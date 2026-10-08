#!/usr/bin/env node
import fs from "node:fs";
import { beginAssistantRun, finishAssistantExecution, getAssistantRun, recordJevDecision, requestFileForRun, updateAssistantRun } from "../../lib/assistant-runs.js";
import { connectRuntime } from "../../lib/hermes-acp-runtime.js";
import { appendAssistantText } from "../../lib/assistant-stream.js";
import { readHermesResult, friendlyRunError } from "../../lib/hermes-run-protocol.js";
import { publicReplyText } from "../../lib/publicReply.js";
import { addVoiceActivity } from "../../lib/voiceActivity.js";
import { routeControlModel } from "./jev-control-route.mjs";

const id = process.argv[2];
let socket, payload, finished = false, stopped = false, authoritativeResult = false;
const activity = input => { try { addVoiceActivity({ sessionId: payload.sessionId, source: "voice/action", textOnly: payload.textOnly, ...input }); } catch {} };
function stop() { stopped = true; socket?.destroy(); }
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
function finish(value) {
  if (finished || stopped) return;
  finished = true;
  const run = updateAssistantRun(id, { ...value, permission: null, toolProgress: null });
  if (!run || run.state === "cancelled") return;
  activity({ id: `${id}:${run.state === "complete" ? "complete" : "failed"}`, kind: run.state === "complete" ? "tool" : "error", state: run.state, title: run.state === "complete" ? "Hermes answered" : "Request needs attention", summary: run.response || run.error, target: "hermes" });
}
async function main() {
  const run = beginAssistantRun(id);
  if (!run) return;
  try {
    const file = requestFileForRun(id);
    payload = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.unlinkSync(file);
    const routed = await routeControlModel({ ...payload, turnId: id, onDecision: decision => recordJevDecision(id, decision) });
    if (routed?.selected) payload = { ...payload, provider: routed.provider, model: routed.model };
    activity({ id: `${id}:running`, kind: "tool", state: "active", title: payload.statusLabel || "Thinking through your request…", summary: "", target: "hermes" });
    socket = await connectRuntime(payload);
    if (stopped || getAssistantRun(id)?.state === "cancelled") { socket.destroy(); return; }
    await new Promise(resolve => {
      let buffer = "", seq = 0, messageId = "", raw = "", emitted = "", lastWrite = 0, assistantSegment = 1, toolsSinceMessage = false;
      const toolCalls = new Map();
      function consume(event) {
        if (stopped || finished) return;
        if (event.type === "error") { finish({ state: "error", response: "", error: friendlyRunError(event.error) }); socket.end(); return; }
        if (event.type === "result") { authoritativeResult = true; finish(readHermesResult({ ...event, type: "result" })); socket.end(); return; }
        if (event.type === "jev") { recordJevDecision(id, event.decision); return; }
        if (event.type !== "update") return;
        const update = event.update;
        if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
          if (toolsSinceMessage) { assistantSegment += 1; toolsSinceMessage = false; }
          const nextMessage = update.messageId || `assistant-${assistantSegment}`;
          if (nextMessage !== messageId) { messageId = nextMessage; raw = ""; emitted = ""; }
          raw += update.content.text || "";
          if (raw.length > 200_000) { stop(); return; }
          const safe = publicReplyText(raw, { partial: true });
          // Only append safe public content. Protocol delimiters split across
          // chunks are buffered by publicReplyText; reasoning chunks are never
          // admitted to this branch.
          if (safe.startsWith(emitted) && safe.length > emitted.length) {
            appendAssistantText(id, { seq: ++seq, text: safe.slice(emitted.length), messageId });
            emitted = safe;
          }
          if (Date.now() - lastWrite > 500) { updateAssistantRun(id, { statusLabel: "Composing a reply…" }); lastWrite = Date.now(); }
        } else if (["tool_call", "tool_call_update"].includes(update.sessionUpdate)) {
          toolsSinceMessage = true;
          const callId = String(update.toolCallId || "");
          const previous = toolCalls.get(callId) || {};
          // Hermes emits tool_call from its actual tool.started callback, but
          // the installed ACP builder omits status on that start event. Later
          // updates carry completed/failed. Preserve explicit pending states
          // (permission gates) rather than promoting them to running work.
          const status = update.status ?? (update.sessionUpdate === "tool_call" ? "in_progress" : previous.status);
          const tool = { ...previous, ...update, status };
          if (tool.status === "in_progress" && !tool.startedAt) tool.startedAt = new Date().toISOString();
          toolCalls.set(callId, tool);
          const done = ["completed", "failed"].includes(tool.status);
          // Native titles can embed commands or user inputs. Public progress
          // carries tool kind only; permission prompts separately show what
          // the user is being asked to authorize.
          const kind = ["read", "edit", "delete", "move", "search", "execute", "think", "fetch"].includes(tool.kind) ? tool.kind : "tool";
          const title = done ? tool.status === "failed" ? "A tool needs attention" : "Tool finished" : ({ read: "Reading…", edit: "Editing…", search: "Searching…", execute: "Running a command…", fetch: "Fetching information…" })[kind] || "Working on your request…";
          const activeTool = [...toolCalls.values()].find(item => item.status === "in_progress");
          const activeKind = ["read", "edit", "delete", "move", "search", "execute", "think", "fetch"].includes(activeTool?.kind) ? activeTool.kind : "tool";
          updateAssistantRun(id, { statusLabel: done ? "Thinking through the result…" : tool.status === "pending" ? "Preparing the requested action…" : title, toolProgress: activeTool ? { callId: String(activeTool.toolCallId || ""), kind: activeKind, status: "in_progress", startedAt: activeTool.startedAt } : null });
          activity({ id: `${id}:${callId}`, kind: "tool", state: done ? tool.status === "failed" ? "error" : "done" : "active", source: "hermes/tool", title, summary: "", toolName: kind, callId, target: "hermes" });
        }
      }
      socket.on("data", chunk => {
        buffer += chunk;
        if (buffer.length > 2_000_000) { stop(); return; }
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          try { consume(JSON.parse(line)); } catch {}
        }
      });
      socket.on("error", () => { finish({ state: "error", response: "", error: "The Hermes connection stopped. This request was not replayed; check any completed actions before retrying." }); });
      socket.on("close", () => {
        if (!finished && !stopped) finish({ state: "error", response: "", error: "Hermes stopped before returning a final answer. This request was not replayed; check any completed actions before retrying." });
        resolve();
      });
      socket.write(JSON.stringify({ type: "run", id, pid: process.pid, history: payload.history || [], workspaceInstructions: payload.workspaceInstructions || "" }) + "\n");
    });
  } catch (error) {
    finish({ state: "error", response: "", error: friendlyRunError(error.message) });
  } finally {
    socket?.destroy();
    // If stopped, the parent run reconciler owns the process-group reap. Never
    // claim stopped work has finished while the native runtime might act.
    if (!stopped && (authoritativeResult || !getAssistantRun(id)?.persistentRuntimePid)) finishAssistantExecution(id);
  }
}
await main();
