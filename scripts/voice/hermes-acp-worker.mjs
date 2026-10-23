#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { getAssistantRun, getConversationSession, saveConversationSession, updateAssistantRun } from "../../lib/assistant-runs.js";
import { ACP_RUN_ID_META_KEY, ACP_TURN_INSTRUCTIONS_META_KEY, buildControlSystemInstructions, turnInstructionsForTextOnly } from "../../lib/voiceTurnInstructions.js";
import { processIdentity, processMatchesIdentity, readJson } from "../../lib/work-store.js";
import { recordDelegatedAgent, listDelegatedAgents, getDelegatedAgent, markDelegationStopping } from "../../lib/delegated-agents.js";
import { assistantRunTimeoutMs } from "../../lib/assistant-timeout.js";

const spec = readJson(process.argv[2]);
const workerIdentity = processIdentity(process.pid);
if (!workerIdentity) throw new Error("Panel could not verify ownership of the persistent Hermes runtime.");
const repo = process.env.HERMES_REPO || path.join(os.homedir(), ".hermes", "hermes-agent");
const python = process.platform === "win32" ? path.join(repo, "venv", "Scripts", "python.exe") : path.join(repo, "venv", "bin", "python");
const child = spawn(process.env.HERMES_ACP_COMMAND || python, process.env.HERMES_ACP_COMMAND ? [] : [path.join(spec.appRoot, "scripts/voice/launch-panel-acp.py")], {
  cwd: spec.workingDirectory || spec.appRoot, stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, PANEL_NODE: process.execPath, PANEL_APP_ROOT: spec.appRoot, PANEL_WORK_SESSION_ID: spec.sessionId, PANEL_DATA_DIR: spec.dataDirectory, PANEL_AGENT_SOUL: spec.agentSoul || "", PANEL_AGENT_SOUL_PATH: spec.agentId ? path.join(spec.dataDirectory, "agents", spec.agentId, "SOUL.md") : "", PANEL_AGENT_POLICY: spec.agentPolicy === undefined ? "" : JSON.stringify(spec.agentPolicy), HERMES_REPO: repo, HERMES_DISABLE_LAZY_INSTALLS: "1", HERMES_JEV_CONTROL: "1", HERMES_AGENT_MAX_TURNS: "30", PATH: [path.join(os.homedir(), ".local", "bin"), path.join(repo, "venv", process.platform === "win32" ? "Scripts" : "bin"), "/opt/homebrew/bin", "/usr/local/bin", process.env.PATH || ""].join(path.delimiter), PANEL_DISABLE_TOOLS: spec.disableTools === true ? "1" : "0", PANEL_ACP_MODEL: spec.model || "", PANEL_ACP_PROVIDER: spec.provider || "", PANEL_ACP_REASONING: spec.reasoningEffort || "", PANEL_ACP_INSTRUCTIONS: buildControlSystemInstructions({ agentName: spec.agentName }) },
});
let nextId = 1, sessionId = "", active = null, stdout = "", stderr = "", closed = false, lastUsed = Date.now();
const pending = new Map();
const clients = new Set();
const delegatedUpdateMethods = new Set(["_panel/agent_update", "panel/agent_update"]);
const turnResultMethods = new Set(["_panel/turn_result", "panel/turn_result"]);
const send = value => { if (!closed) child.stdin.write(JSON.stringify(value) + "\n"); };
const emit = (socket, value) => { if (!socket.destroyed) socket.write(JSON.stringify(value) + "\n"); };
function tracePermission(kind, rpcId) {
  if (!active?.id?.startsWith("tf-")) return;
  const current = getAssistantRun(active.id);
  const previous = Array.isArray(current?.permissionTrace) ? current.permissionTrace.slice(-31) : [];
  updateAssistantRun(active.id, { permissionTrace: [...previous, { kind, rpcId: String(rpcId).slice(0, 80), at: new Date().toISOString() }] });
}
function request(method, params, timeoutMs = 45_000) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Hermes runtime timed out during ${method}.`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    send({ jsonrpc: "2.0", id, method, params });
  });
}
function permissionFile(id) { return path.join(spec.dataDirectory, "assistant-runs", `${id}.permission.json`); }
function rejectPermission(id) { send({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } }); }
function publicPermission(permission) {
  return permission ? { requestId: permission.requestId, title: permission.title, description: permission.description, options: permission.options, expiresAt: new Date(permission.expires).toISOString() } : null;
}
function publishNextPermission() {
  if (!active) return;
  const next = active.permissions.values().next().value || null;
  if (next && !next.expires) { next.expires = Date.now() + 120_000; tracePermission("presented", next.id); }
  updateAssistantRun(active.id, { permission: publicPermission(next), toolProgress: null, statusLabel: next ? "Waiting for your permission…" : "Continuing your request…" });
}
function rejectActivePermissions() {
  if (!active?.permissions) return;
  for (const permission of active.permissions.values()) rejectPermission(permission.id);
  for (const permission of active.permissions.values()) tracePermission("cleanup_rejected", permission.id);
  active.permissions.clear();
  try { fs.unlinkSync(permissionFile(active.id)); } catch {}
  updateAssistantRun(active.id, { permission: null, toolProgress: null });
}
function acceptDelegatedUpdate(event, acknowledged) {
  if (event.params?.sessionId !== sessionId) {
    if (acknowledged) send({ jsonrpc: "2.0", id: event.id, error: { code: -32001, message: "Delegated agent update belongs to another session." } });
    return;
  }
  try {
    const recorded = recordDelegatedAgent(event.params.runId, event.params.agent, { sessionId: spec.sessionId, runtimePid: process.pid });
    if (!recorded) throw new Error("Delegated agent update was not accepted.");
    lastUsed = Date.now();
    if (acknowledged) send({ jsonrpc: "2.0", id: event.id, result: { ok: true } });
  } catch {
    if (acknowledged) send({ jsonrpc: "2.0", id: event.id, error: { code: -32002, message: "Delegated agent update could not be saved." } });
  }
}
function onMessage(event) {
  if (event.method && event.id !== undefined) {
    if (delegatedUpdateMethods.has(event.method)) { acceptDelegatedUpdate(event, true); return; }
    if (event.method !== "session/request_permission" || !active || event.params?.sessionId !== sessionId) {
      if (active && event.method === "session/request_permission") tracePermission("foreign_rejected", event.id);
      rejectPermission(event.id); return;
    }
    tracePermission("received", event.id);
    const params = event.params || {};
    if (active.permissions.has(event.id)) {
      active.permissions.delete(event.id);
      tracePermission("duplicate_rejected", event.id);
      rejectPermission(event.id);
      publishNextPermission();
      return;
    }
    if (active.permissions.size >= 32) { tracePermission("overflow_rejected", event.id); rejectPermission(event.id); return; }
    const options = (Array.isArray(params.options) ? params.options : []).slice(0, 16).flatMap(option => {
      const optionId = typeof option?.optionId === "string" && option.optionId.length <= 200 ? option.optionId : "";
      const kind = typeof option?.kind === "string" && option.kind.length <= 64 ? option.kind : "";
      return optionId && kind ? [{ optionId, name: String(option.name || "").slice(0, 120), kind }] : [];
    });
    if (!options.length) { tracePermission("malformed_rejected", event.id); rejectPermission(event.id); return; }
    const requestId = `${active.id}:${event.id}`;
    const content = (Array.isArray(params.toolCall?.content) ? params.toolCall.content : []).map(item => item?.content?.text || "").join("\n");
    const permission = { id: event.id, requestId, options, expires: 0, title: String(params.toolCall?.title || "Hermes needs permission").slice(0, 1200), description: content.slice(0, 5000) };
    active.permissions.set(event.id, permission);
    publishNextPermission();
    return;
  }
  if (event.id !== undefined && pending.has(event.id)) {
    const waiter = pending.get(event.id); pending.delete(event.id); clearTimeout(waiter.timer);
    event.error ? waiter.reject(new Error(`Hermes ACP request failed (${event.error.code}): ${event.error.message || "unknown error"}`)) : waiter.resolve(event.result || {});
    return;
  }
  // The ACP SDK prefixes extension notifications with `_`. Keep the legacy
  // spelling for runtimes that write the JSON-RPC notification directly.
  if (delegatedUpdateMethods.has(event.method) && event.params?.sessionId === sessionId) {
    acceptDelegatedUpdate(event, false);
    return;
  }
  if (!active || active.finishing || event.params?.sessionId !== sessionId) return;
  if (event.method === "session/update") {
    const update = event.params.update;
    if (["agent_message_chunk", "tool_call", "tool_call_update"].includes(update?.sessionUpdate)) emit(active.socket, { type: "update", update });
  } else if (turnResultMethods.has(event.method)) active.result = event.params;
}
child.stdout.on("data", chunk => {
  stdout += chunk;
  if (stdout.length > 2_000_000) return shutdown("Hermes runtime returned oversized output.");
  let index;
  while ((index = stdout.indexOf("\n")) >= 0) {
    const line = stdout.slice(0, index); stdout = stdout.slice(index + 1);
    try { onMessage(JSON.parse(line)); } catch {}
  }
});
child.stderr.on("data", chunk => {
  stderr = (stderr + chunk).slice(-32_000);
  let index;
  while ((index = stderr.indexOf("\n")) >= 0) {
    const line = stderr.slice(0, index); stderr = stderr.slice(index + 1);
    if (active && line.startsWith("HERMES_JEV_EVENT ")) {
      try { emit(active.socket, { type: "jev", decision: JSON.parse(line.slice(17)) }); } catch {}
    }
  }
});
child.stdin.on("error", () => {});
child.on("error", () => shutdown("The installed Hermes ACP runtime could not start."));
child.on("close", () => shutdown("Hermes runtime stopped. This request was not replayed; check any completed actions before retrying."));

const ready = (async () => {
  await request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "hermes-control", version: "0.2.1" } });
  const previous = getConversationSession(spec.sessionId).hermesSessionId;
  let session;
  if (previous) {
    session = await request("session/load", { sessionId: previous, cwd: spec.workingDirectory || spec.appRoot, mcpServers: [] });
    if (!session.models) throw new Error("Hermes could not restore this conversation. It was not silently replaced.");
    sessionId = previous;
  } else {
    session = await request("session/new", { cwd: spec.workingDirectory || spec.appRoot, mcpServers: [] });
    sessionId = session.sessionId;
  }
  if (!sessionId) throw new Error("Hermes did not return a conversation ID.");
  // Empty ACP sessions are ephemeral. Save their mapping only after a native
  // turn persists history, so an idle warmup never leaves an unrestorable ID.
  const reportedModel = typeof session.models?.currentModelId === "string" ? session.models.currentModelId : "";
  let provider = "";
  let model = reportedModel;
  if (reportedModel.includes(":")) [provider, model] = [reportedModel.slice(0, reportedModel.indexOf(":")), reportedModel.slice(reportedModel.indexOf(":") + 1)];
  return reportedModel
    ? { model, provider, provenance: "runtime" }
    : { model: spec.model || "", provider: spec.provider || "", provenance: "requested" };
})();
ready.catch(error => shutdown(error.message));

async function execute(socket, message) {
  lastUsed = Date.now();
  try {
    const selected = await ready;
    if (socket.destroyed) return;
    if (message.type === "warmup") { emit(socket, { type: "ready", ...selected }); return; }
    if (message.type === "agent_control") {
      const run = getAssistantRun(message.runId, spec.sessionId);
      const agent = getDelegatedAgent(spec.sessionId, message.runId, message.agentId, message.delegationId);
      if (!run || run.persistentRuntimePid !== process.pid || !agent?.canStop) throw new Error("This delegated agent is no longer available to stop.");
      // ACP extension requests are underscore-prefixed on the wire; the SDK
      // strips that prefix before calling ControlACPAgent.ext_method.
      const result = await request("_panel/stop_agent", { sessionId, runId: run.id, agentId: agent.id, ...(agent.delegationId ? { delegationId: agent.delegationId } : {}) }, 10_000);
      if (result.ok !== true) throw new Error(result.error || "Hermes could not stop this delegated agent.");
      markDelegationStopping(spec.sessionId, run.id, agent.id, agent.delegationId);
      emit(socket, { type: "agent_control", ok: true }); socket.end(); return;
    }
    if (message.type !== "run" || typeof message.id !== "string") throw new Error("Invalid runtime request.");
    const run = getAssistantRun(message.id, spec.sessionId);
    if (!run || run.state !== "active" || !processMatchesIdentity(run.pid, run.pidIdentity) || run.pid !== message.pid || run.executionCancelRequestedAt) throw new Error("The request is no longer owned by its runner.");
    if (active) throw new Error("Hermes is already working in this conversation.");
    updateAssistantRun(run.id, { persistentRuntimePid: process.pid, persistentRuntimeIdentity: workerIdentity, nativeSessionId: sessionId, transport: "acp", selectedModel: selected.model, selectedProvider: selected.provider, selectedModelProvenance: selected.provenance });
    const turn = { id: run.id, socket, helperPid: run.pid, helperIdentity: run.pidIdentity, result: null, finishing: false, permissions: new Map() };
    active = turn;
    emit(socket, { type: "started", ...selected });
    let text = run.text;
    // Native sessions normally already contain the history. A brand-new Control
    // conversation can import its existing local messages exactly once.
    if (!previousHistoryImported && message.history?.length) text = `Earlier conversation (context only):\n${JSON.stringify(message.history).slice(-12000)}\n\nCurrent request:\n${text}`;
    previousHistoryImported = true;
    const response = await request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
      _meta: {
        [ACP_TURN_INSTRUCTIONS_META_KEY]: [turnInstructionsForTextOnly(run.textOnly), spec.disableTools === true && typeof message.workspaceInstructions === "string" ? message.workspaceInstructions.slice(0, 18000) : ""].filter(Boolean).join("\n\n"),
        [ACP_RUN_ID_META_KEY]: run.id,
      },
    }, assistantRunTimeoutMs(process.env.HERMES_VOICE_RUN_TIMEOUT_MS));
    turn.finishing = true;
    if (!turn.result) throw new Error("Hermes ended without an authoritative result. This request was not replayed.");
    rejectActivePermissions();
    saveConversationSession(spec.sessionId, sessionId);
    emit(socket, { type: "result", ...turn.result, stopReason: response.stopReason });
    active = null;
    lastUsed = Date.now();
  } catch (error) {
    emit(socket, { type: "error", error: error.message });
    if (active?.socket === socket) shutdown("Hermes did not complete the active turn; it was not replayed.");
  }
}
let previousHistoryImported = Boolean(getConversationSession(spec.sessionId).hermesSessionId);
const server = net.createServer(socket => {
  clients.add(socket);
  let buffer = "", accepted = false;
  socket.on("error", () => {});
  socket.on("data", chunk => {
    buffer += chunk;
    if (buffer.length > 256_000) { socket.destroy(); return; }
    const index = buffer.indexOf("\n");
    if (index < 0 || accepted) return;
    accepted = true;
    try { execute(socket, JSON.parse(buffer.slice(0, index))); } catch { socket.destroy(); }
  });
  socket.on("close", () => {
    clients.delete(socket);
    if (active?.socket === socket && !active.finishing) shutdown("The request runner disconnected. In-flight work was stopped and was not replayed.");
  });
});
server.on("error", () => shutdown("The local Hermes socket could not be opened."));
server.listen(spec.socket, () => fs.chmodSync(spec.socket, 0o600));

const monitor = setInterval(() => {
  if (!active) {
    if (Date.now() - lastUsed > (Number(process.env.HERMES_ACP_IDLE_TIMEOUT_MS) || 30 * 60_000) && !listDelegatedAgents(spec.sessionId).some(agent => ["queued", "running"].includes(agent.status))) shutdown("Idle runtime stopped.");
    return;
  }
  if (!processMatchesIdentity(active.helperPid, active.helperIdentity)) return shutdown("The request runner stopped. In-flight work was stopped and was not replayed.");
  const permission = active.permissions.values().next().value;
  if (!permission) return;
  let response;
  try { response = readJson(permissionFile(active.id)); } catch {}
  let expired = false;
  if (response?.requestId === permission.requestId && permission.options.some(option => option.optionId === response.optionId)) {
    send({ jsonrpc: "2.0", id: permission.id, result: { outcome: { outcome: "selected", optionId: response.optionId } } });
    tracePermission("resolved", permission.id);
  } else if (Date.now() >= permission.expires) { rejectPermission(permission.id); expired = true; }
  else return;
  if (expired) tracePermission("expired", permission.id);
  active.permissions.delete(permission.id);
  try { fs.unlinkSync(permissionFile(active.id)); } catch {}
  publishNextPermission();
}, 100);

function shutdown(reason) {
  if (closed) return;
  if (active) {
    rejectActivePermissions();
    send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
    emit(active.socket, { type: "error", error: reason });
  }
  closed = true;
  clearInterval(monitor);
  for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(reason)); }
  pending.clear();
  for (const socket of clients) socket.end();
  server.close();
  try { fs.unlinkSync(spec.socket); } catch {}
  try { child.kill("SIGTERM"); } catch {}
  // This detached worker is the conversation's process-group leader. Reap the
  // entire group, including MCP servers and terminal grandchildren, even when
  // the native ACP parent has already exited. Other conversations have distinct
  // leaders. Keep this timer referenced so cleanup cannot exit prematurely.
  setTimeout(() => {
    try { process.kill(process.platform === "win32" ? child.pid : -process.pid, "SIGKILL"); } catch {}
    process.exit(0);
  }, 750);
}
process.on("SIGTERM", () => shutdown("The request was stopped."));
process.on("SIGINT", () => shutdown("The request was stopped."));
