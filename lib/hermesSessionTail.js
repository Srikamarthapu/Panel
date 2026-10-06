// Tails a Hermes CLI JSONL session log line-by-line and emits friendly
// activity events. Used by the voice route so the "VOICE ACTIONS" panel
// reflects what Hermes is actually doing (tool calls + results), not just
// audio/UI chrome.

import fs from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

import { labelForToolCall, labelForToolResult } from "./hermesToolLabels.js";

const POLL_INTERVAL_MS = 250;
const CLAIM_INTERVAL_MS = 200;

function defaultSessionsDir() {
  // Resolve lazily so Next's static trace doesn't try to follow os.homedir()
  // when this module is imported by a route file.
  return path.join(os.homedir(), ".hermes", "sessions");
}

/**
 * Wait until a JSONL session file appears whose basename (sans extension)
 * is not in `knownIds`, then return its absolute path. Returns null after
 * `timeoutMs` of polling with no new session.
 *
 * @param {{
 *   sessionsDir?: string,
 *   knownIds?: Set<string>|Iterable<string>,
 *   timeoutMs?: number,
 * }} [opts]
 * @returns {Promise<string|null>}
 */
export async function claimNextSession(opts = {}) {
  const sessionsDir = opts.sessionsDir || defaultSessionsDir();
  const knownIds =
    opts.knownIds instanceof Set
      ? opts.knownIds
      : new Set(opts.knownIds || []);
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 12_000;
  const deadline = Date.now() + Math.max(0, timeoutMs);

  while (true) {
    const found = await scanForNewSession(sessionsDir, knownIds);
    if (found) return found;
    if (Date.now() >= deadline) return null;
    await sleep(CLAIM_INTERVAL_MS);
  }
}

async function scanForNewSession(sessionsDir, knownIds) {
  let entries;
  try {
    entries = await fs.promises.readdir(sessionsDir);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    console.warn("[hermesSessionTail] readdir failed:", err?.message || err);
    return null;
  }
  const candidates = [];
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const id = name.slice(0, -".jsonl".length);
    if (knownIds.has(id)) continue;
    const full = path.join(sessionsDir, name);
    try {
      const stat = await fs.promises.stat(full);
      if (!stat.isFile()) continue;
      candidates.push({ full, mtimeMs: stat.mtimeMs });
    } catch {
      // ignore
    }
  }
  if (candidates.length === 0) return null;
  // Most recently modified wins so we follow the freshest run.
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0].full;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Open a Hermes JSONL session log and call `onEvent` for each new tool
 * call / tool result line. Combines fs.watch with a polling fallback so
 * macOS append events that don't fire watch notifications still flow.
 *
 * @param {{
 *   sessionPath: string,
 *   onEvent: (event: object) => void,
 *   abortSignal?: AbortSignal,
 * }} opts
 * @returns {{ stop: () => void }}
 */
export function tailHermesSession(opts) {
  const { sessionPath, onEvent, abortSignal } = opts || {};
  if (!sessionPath) throw new Error("tailHermesSession: sessionPath is required");
  if (typeof onEvent !== "function")
    throw new Error("tailHermesSession: onEvent must be a function");

  const sessionId = path.basename(sessionPath, path.extname(sessionPath));
  let lastReadOffset = 0;
  let lineBuffer = "";
  let stopped = false;
  let reading = false;
  let pendingRead = false;
  let watcher = null;
  let pollTimer = null;
  let abortHandler = null;

  const emit = (event) => {
    try {
      onEvent({
        id: randomUUID(),
        sessionId: `voice/${sessionId}`,
        ...event,
      });
    } catch (err) {
      console.warn("[hermesSessionTail] onEvent threw:", err?.message || err);
    }
  };

  const handleParsedLine = (obj) => {
    if (!obj || typeof obj !== "object") return;
    const role = obj.role;
    const ts = sanitizeTs(obj.timestamp);

    if (role === "assistant" && Array.isArray(obj.tool_calls) && obj.tool_calls.length) {
      for (const call of obj.tool_calls) {
        if (!call || typeof call !== "object") continue;
        const fn = call.function || {};
        const toolName = String(fn.name || call.name || "").trim();
        if (!toolName) continue;
        const args = fn.arguments;
        let label;
        try {
          label = labelForToolCall(toolName, args);
        } catch (err) {
          console.warn(
            `[hermesSessionTail] labelForToolCall(${toolName}) failed:`,
            err?.message || err,
          );
          label = { title: `Calling ${toolName}`, summary: "" };
        }
        emit({
          kind: "tool",
          state: "active",
          toolName,
          callId: String(call.id || call.call_id || ""),
          title: label.title,
          summary: label.summary,
          target: label.target,
          source: "hermes/tool",
          ts,
        });
      }
      return;
    }

    if (role === "tool") {
      const toolName = String(obj.name || obj.tool_name || "").trim();
      const content = typeof obj.content === "string" ? obj.content : safeStringify(obj.content);
      let label;
      try {
        label = labelForToolResult(toolName, content);
      } catch (err) {
        console.warn(
          `[hermesSessionTail] labelForToolResult(${toolName}) failed:`,
          err?.message || err,
        );
        label = { title: `Got result from ${toolName}`, summary: "" };
      }
      emit({
        kind: "tool",
        state: "done",
        toolName,
        callId: String(obj.tool_call_id || ""),
        title: label.title,
        summary: label.summary,
        source: "hermes/tool",
        ts,
      });
      return;
    }

    // session_meta, user, plain assistant — skip.
  };

  const consumeBuffer = () => {
    let newlineIdx;
    while ((newlineIdx = lineBuffer.indexOf("\n")) >= 0) {
      const rawLine = lineBuffer.slice(0, newlineIdx);
      lineBuffer = lineBuffer.slice(newlineIdx + 1);
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch (err) {
        console.warn(
          "[hermesSessionTail] skipping malformed JSONL line:",
          err?.message || err,
        );
        continue;
      }
      try {
        handleParsedLine(parsed);
      } catch (err) {
        console.warn("[hermesSessionTail] handler threw:", err?.message || err);
      }
    }
  };

  const readNewBytes = async () => {
    if (stopped) return;
    if (reading) {
      pendingRead = true;
      return;
    }
    reading = true;
    try {
      let stat;
      try {
        stat = await fs.promises.stat(sessionPath);
      } catch (err) {
        if (err && err.code === "ENOENT") return;
        throw err;
      }
      const size = stat.size;
      if (size < lastReadOffset) {
        // File was truncated/rotated. Reset.
        lastReadOffset = 0;
        lineBuffer = "";
      }
      if (size <= lastReadOffset) return;

      const handle = await open(sessionPath, "r");
      try {
        const length = size - lastReadOffset;
        const buf = Buffer.alloc(length);
        await handle.read(buf, 0, length, lastReadOffset);
        lastReadOffset = size;
        lineBuffer += buf.toString("utf8");
        consumeBuffer();
      } finally {
        await handle.close();
      }
    } catch (err) {
      console.warn("[hermesSessionTail] read failed:", err?.message || err);
    } finally {
      reading = false;
      if (pendingRead && !stopped) {
        pendingRead = false;
        // Schedule another pass to drain anything that arrived mid-read.
        setImmediate(readNewBytes);
      }
    }
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (watcher) {
      try {
        watcher.close();
      } catch {
        // ignore
      }
      watcher = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (abortSignal && abortHandler) {
      try {
        abortSignal.removeEventListener("change", abortHandler);
      } catch {
        // ignore
      }
    }
  };

  // fs.watch — change events.
  try {
    watcher = fs.watch(sessionPath, { persistent: false }, (eventType) => {
      if (stopped) return;
      if (eventType === "rename") {
        // File may have been replaced; trigger a fresh stat read.
        readNewBytes();
        return;
      }
      readNewBytes();
    });
    watcher.on("error", (err) => {
      console.warn("[hermesSessionTail] watcher error:", err?.message || err);
    });
  } catch (err) {
    console.warn("[hermesSessionTail] fs.watch unavailable:", err?.message || err);
  }

  // Polling fallback for filesystems that don't fire watch on appends.
  pollTimer = setInterval(() => {
    if (stopped) return;
    readNewBytes();
  }, POLL_INTERVAL_MS);
  pollTimer.unref?.();

  // Honor abort signal.
  if (abortSignal) {
    if (abortSignal.aborted) {
      stop();
    } else {
      abortHandler = () => stop();
      abortSignal.addEventListener("abort", abortHandler, { once: true });
    }
  }

  // Initial read so any existing lines (older history) are processed too.
  // Most callers create the session fresh, so this is usually a no-op.
  readNewBytes();

  return { stop };
}

/**
 * Convenience: claim the next new session under `sessionsDir` and start
 * tailing it. If no session appears before `claimTimeoutMs`, returns a
 * no-op stop and `sessionPath: null`.
 *
 * @param {{
 *   sessionsDir?: string,
 *   knownIds?: Set<string>|Iterable<string>,
 *   onEvent: (event: object) => void,
 *   abortSignal?: AbortSignal,
 *   claimTimeoutMs?: number,
 * }} opts
 * @returns {Promise<{ sessionPath: string|null, stop: () => void }>}
 */
export async function tailLatestForVoice(opts = {}) {
  const sessionPath = await claimNextSession({
    sessionsDir: opts.sessionsDir,
    knownIds: opts.knownIds,
    timeoutMs: opts.claimTimeoutMs,
  });
  if (!sessionPath) {
    return { sessionPath: null, stop: () => {} };
  }
  const tail = tailHermesSession({
    sessionPath,
    onEvent: opts.onEvent,
    abortSignal: opts.abortSignal,
  });
  return { sessionPath, stop: tail.stop };
}

function safeStringify(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function sanitizeTs(value) {
  if (!value) return new Date().toISOString();
  if (typeof value === "number") {
    try {
      return new Date(value > 1e12 ? value : value * 1000).toISOString();
    } catch {
      return new Date().toISOString();
    }
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || new Date().toISOString();
  }
  return new Date().toISOString();
}
