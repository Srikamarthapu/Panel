import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { MAX_ASSISTANT_TEXT } from "./conversation-limits.js";

const storeDir = path.resolve(process.env.PANEL_DATA_DIR || path.join(process.cwd(), "data"));
const activityPath = path.join(storeDir, "voice-activity.json");
const MAX_EVENTS = 120;

const defaultStore = {
  events: [],
};

function ensureStore() {
  if (!fs.existsSync(storeDir)) fs.mkdirSync(storeDir, { recursive: true });
  if (!fs.existsSync(activityPath)) {
    fs.writeFileSync(activityPath, JSON.stringify(defaultStore, null, 2));
  }
}

function readStore() {
  try {
    ensureStore();
    const parsed = JSON.parse(fs.readFileSync(activityPath, "utf8"));
    return {
      ...defaultStore,
      ...parsed,
      events: Array.isArray(parsed.events) ? parsed.events : [],
    };
  } catch {
    return { ...defaultStore };
  }
}

function writeStore(nextStore) {
  ensureStore();
  const tmp = `${activityPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(nextStore, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, activityPath);
}

// Default cap for noisy feed entries (titles, statuses, log lines): 240 chars
// keeps the ticker readable and the store small.
const DEFAULT_SUMMARY_CAP = 240;
// T-0010 Law 8 ("complete thoughts"): a completed data/action run's summary IS
// the answer the client speaks. Truncating it at 240 chars amputated spoken
// replies mid-sentence ("And C…"). Completion summaries get a much larger cap
// so the full reply is stored and spoken; the 240 cap still applies to every
// noise field so nothing else can bloat the store.
const COMPLETION_SUMMARY_CAP = 2000;

function clean(value, fallback = "", cap = DEFAULT_SUMMARY_CAP) {
  const text = String(value == null ? fallback : value).trim();
  return text.length > cap ? text.slice(0, cap - 1) + "…" : text;
}

// A completion event is one whose run FINISHED — state "complete"/"error" from
// a voice completion lane. Only these get the large summary cap; queued/running
// events and every non-completion source keep the tight default.
const COMPLETION_LANES = new Set(["voice/action", "voice/data", "voice/reply"]);
function isCompletionEvent(input) {
  const state = String(input && input.state != null ? input.state : "").trim();
  const source = String(input && input.source != null ? input.source : "").trim();
  return (
    (state === "complete" || state === "error") && COMPLETION_LANES.has(source)
  );
}

export function addVoiceActivity(input = {}) {
  ensureStore();
  // The server and detached runners write concurrently. Serialize the short
  // read/modify/rename so tool updates cannot erase a completed answer.
  const lock = `${activityPath}.lock`;
  const deadline = Date.now() + 2000;
  let descriptor;
  while (descriptor === undefined) {
    try { descriptor = fs.openSync(lock, "wx", 0o600); }
    catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 5000) fs.unlinkSync(lock); } catch {}
      if (Date.now() > deadline) throw new Error("Activity store is busy.");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
  const store = readStore();
  const now = new Date().toISOString();
  const summaryCap = isCompletionEvent(input)
    ? MAX_ASSISTANT_TEXT
    : DEFAULT_SUMMARY_CAP;
  const event = {
    id: clean(input.id) || crypto.randomUUID(),
    sessionId: clean(input.sessionId, "voice-default"),
    kind: clean(input.kind, "status"),
    state: clean(input.state, "active"),
    title: clean(input.title, "Voice activity"),
    // Law 8: the completion summary carries the full spoken reply.
    summary: clean(input.summary, "", summaryCap),
    target: clean(input.target),
    source: clean(input.source, "voice"),
    textOnly: input.textOnly === true,
    // Pair real tool starts/results without confusing a historical replay for
    // new work. Session tail events carry the original tool timestamp.
    toolName: clean(input.toolName),
    callId: clean(input.callId),
    updatedAt: input.source === "hermes/tool" && Number.isFinite(Date.parse(input.ts || ""))
      ? new Date(input.ts).toISOString()
      : now,
  };
  const events = [event, ...store.events]
    .filter((item) => item && item.id)
    .slice(0, MAX_EVENTS);
  writeStore({ events });

  // The event now lives in data/voice-activity.json, which is the store the
  // T-0003 live activity ticker's action console (VoiceActionConsole →
  // /api/voice/activity → getVoiceActivity) actually renders. We intentionally
  // do NOT mirror into orchestrator/ledger/runs.jsonl: orchestrator/** is a
  // forbidden runtime write target, and the mission-control feed already reads
  // voice/action completions from this data/ store via getVoiceActivity().

  return event;
  } finally { fs.closeSync(descriptor); fs.unlinkSync(lock); }
}

export function getVoiceActivity({ sessionId, limit = 24 } = {}) {
  const store = readStore();
  const scoped = sessionId
    ? store.events.filter((event) => event.sessionId === sessionId)
    : store.events;
  return scoped.slice(0, Math.max(1, Math.min(Number(limit) || 24, 80)));
}

export { activityPath as voiceActivityPath };
