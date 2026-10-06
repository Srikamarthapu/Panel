import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { dataDirectory, processAlive, processGroupAlive, readJson, withFileLock, writeJson } from "./work-store.js";
import { getWorkSession, recordSessionRun, validateWorkingDirectory, withWorkSessionControlLock } from "./work-sessions.js";

const root = path.join(dataDirectory(), "assistant-runs");
const terminal = new Set(["complete", "error", "cancelled", "interrupted"]);
const jevModes = new Set(["direct", "forced", "finish", "defer", "fallback", "context", "context-fallback", "model"]);
const validId = (id) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
const sessionFile = (sessionId) => path.join(root, `session-${crypto.createHash("sha256").update(sessionId).digest("hex")}.json`);
const runFile = (id) => {
  if (!validId(id)) throw new Error("Invalid request ID.");
  return path.join(root, `${id}.json`);
};
const read = file => readJson(file);
const write = (file, value) => writeJson(file, value);
function withRunLock(id, fn) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const lock = `${runFile(id)}.lock`;
  const deadline = Date.now() + 2000;
  let descriptor;
  while (descriptor === undefined) {
    try { descriptor = fs.openSync(lock, "wx", 0o600); }
    catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 5000) fs.unlinkSync(lock); } catch {}
      if (Date.now() >= deadline) throw new Error("Request state is busy. Try again.");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try { return fn(); } finally { fs.closeSync(descriptor); fs.unlinkSync(lock); }
}
export function getConversationSession(sessionId) { return read(sessionFile(sessionId)) || {}; }
export function saveConversationSession(sessionId, hermesSessionId) {
  if (typeof hermesSessionId !== "string" || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(hermesSessionId)) return;
  const file = sessionFile(sessionId);
  write(file, { ...read(file), hermesSessionId, updatedAt: new Date().toISOString() });
}
const interruptedExecutionMessage = "Hermes stopped before returning a final answer. Check whether any actions completed before trying again; this request was not replayed.";
const pendingReaps = new Set();
function signalGroup(pid, signal) {
  if (!Number.isInteger(pid) || pid < 2) return;
  try { process.kill(process.platform === "win32" ? pid : -pid, signal); } catch {}
}
function scheduleExecutionReap(id) {
  if (pendingReaps.has(id)) return;
  pendingReaps.add(id);
  const timer = setTimeout(() => {
    try { getAssistantRun(id); } catch {} finally { pendingReaps.delete(id); }
  }, 4200);
  timer.unref();
}
function reconcileExecution(id) {
  let groupSignal;
  let runnerSignal;
  const run = withRunLock(id, () => {
    const current = read(runFile(id));
    if (!current) return null;
    // Once all owned processes were confirmed gone, saved PIDs are historical.
    // Never probe or signal them again: the OS may reuse either identifier.
    if (current.executionActive === false && current.executionFinishedAt) return current;
    const helperAlive = processAlive(current.pid);
    const childAlive = processGroupAlive(current.hermesProcessGroupPid);
    const claimedExpired = !current.pid && current.launchClaimedAt && Date.now() - Date.parse(current.launchClaimedAt) > 10_000;
    const lostHelper = current.executionActive && (Number.isInteger(current.pid) && !helperAlive || claimedExpired);
    const stopping = current.executionCancelRequestedAt || current.executionStopRequestedAt;
    if (!lostHelper && !stopping) return current;
    const now = new Date().toISOString();
    const stopAt = current.executionStopRequestedAt || current.executionCancelRequestedAt || now;
    const next = { ...current, executionActive: helperAlive || childAlive, executionStopRequestedAt: stopAt };
    if (lostHelper && !terminal.has(current.state)) Object.assign(next, { state: "interrupted", error: interruptedExecutionMessage, updatedAt: now });
    if (!next.executionActive) {
      next.executionFinishedAt ||= now;
      if (next.executionCancelRequestedAt) next.executionCancelledAt ||= now;
    }
    const force = Date.now() - Date.parse(stopAt) >= 4000;
    if (childAlive) groupSignal = { pid: current.hermesProcessGroupPid, signal: force ? "SIGKILL" : "SIGTERM" };
    if (current.executionCancelRequestedAt && helperAlive) runnerSignal = { pid: current.pid, signal: force && !childAlive ? "SIGKILL" : "SIGTERM" };
    write(runFile(id), next);
    return next;
  });
  if (groupSignal) signalGroup(groupSignal.pid, groupSignal.signal);
  if (runnerSignal && runnerSignal.pid !== process.pid) signalGroup(runnerSignal.pid, runnerSignal.signal);
  if (run?.executionActive && (groupSignal || runnerSignal)) scheduleExecutionReap(id);
  recordSessionRun(run);
  return run;
}
export function getAssistantRun(id, sessionId) {
  if (!validId(id)) return null;
  let run = read(runFile(id));
  if (!run || sessionId && run.sessionId !== sessionId) return null;
  const lostHelper = run.executionActive && (Number.isInteger(run.pid) && !processAlive(run.pid) || !run.pid && run.launchClaimedAt && Date.now() - Date.parse(run.launchClaimedAt) > 10_000);
  if (!(run.executionActive === false && run.executionFinishedAt) && (lostHelper || run.executionCancelRequestedAt || run.executionStopRequestedAt)) run = reconcileExecution(id);
  if (!terminal.has(run.state) && Date.now() - Date.parse(run.createdAt) > 15 * 60_000) {
    return updateAssistantRun(id, { state: "error", error: "This request expired before Hermes returned a result. Check any action before retrying." });
  }
  recordSessionRun(run);
  return run;
}
export const MAX_CONCURRENT_ASSISTANT_RUNS = 4;
export function createAssistantRun(input) {
  // Only admission is serialized. Independent sessions execute concurrently.
  return withFileLock(path.join(root, "admission"), () => withWorkSessionControlLock(input.sessionId, () => createAssistantRunLocked(input)));
}
function executingRunCount() {
  let count = 0;
  for (const file of fs.readdirSync(root)) {
    if (!file.endsWith(".json")) continue;
    const id = file.slice(0, -5);
    if (!validId(id) || read(path.join(root, file))?.id !== id) continue;
    const run = getAssistantRun(id);
    if (run && (!terminal.has(run.state) || assistantRunIsExecuting(run))) count += 1;
  }
  return count;
}
function createAssistantRunLocked(input) {
  const workSession = getWorkSession(input.sessionId);
  if (workSession?.archivedAt) {
    const error = new Error("Restore this archived session before starting a request."); error.status = 409; throw error;
  }
  // Take the authoritative folder under the same lock as metadata edits.
  if (workSession) input = { ...input, workingDirectory: validateWorkingDirectory(workSession.workingDirectory) };
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (input.id) {
    if (!validId(input.id)) throw new Error("Invalid request ID.");
    const existing = getAssistantRun(input.id);
    if (existing) {
      if (existing.sessionId !== input.sessionId) throw new Error("Request ID belongs to another conversation.");
      return existing;
    }
  }
  const file = sessionFile(input.sessionId);
  const lock = `${file}.lock`;
  let descriptor;
  try { descriptor = fs.openSync(lock, "wx", 0o600); }
  catch {
    try { if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) fs.unlinkSync(lock); } catch {}
    const err = new Error("Another request is starting. Try again in a moment."); err.status = 409; throw err;
  }
  try {
    const session = read(file) || {};
    const active = session.activeRunId && getAssistantRun(session.activeRunId);
    if (active && (!terminal.has(active.state) || assistantRunIsExecuting(active))) {
      const err = new Error("Hermes is still working on the previous request. Stop it before sending another."); err.status = 409; throw err;
    }
    if (executingRunCount() >= MAX_CONCURRENT_ASSISTANT_RUNS) {
      const error = new Error(`Panel can run up to ${MAX_CONCURRENT_ASSISTANT_RUNS} requests at once. Wait for one to finish or stop a running request.`); error.status = 409; throw error;
    }
    const run = { ...input, id: input.id || crypto.randomUUID(), state: "queued", response: "", error: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const saved = withRunLock(run.id, () => {
      const previous = read(runFile(run.id));
      if (previous) {
        if (previous.sessionId !== input.sessionId) throw new Error("Request ID belongs to another conversation.");
        return previous;
      }
      write(runFile(run.id), run);
      return run;
    });
    write(file, { ...session, activeRunId: run.id });
    recordSessionRun(saved);
    return saved;
  } finally { fs.closeSync(descriptor); fs.unlinkSync(lock); }
}
export function updateAssistantRun(id, patch) {
  return withRunLock(id, () => {
  const file = runFile(id);
  const current = read(file);
  if (!current || terminal.has(current.state)) return current;
  const next = { ...current, ...patch, id: current.id, sessionId: current.sessionId, updatedAt: new Date().toISOString() };
  write(file, next);
  recordSessionRun(next);
  return next;
  });
}
export function recordJevDecision(id, value) {
  if (!value || value.evaluated !== true || !jevModes.has(value.mode)) return getAssistantRun(id);
  const decision = {
    mode: value.mode,
    reason: typeof value.reason === "string" && /^[a-zA-Z0-9_ -]{0,100}$/.test(value.reason) ? value.reason : "runtime_error",
    tool: typeof value.tool === "string" ? value.tool.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 120) : "",
    ...(value.mode === "model" && typeof value.model === "string" ? { selectedModel: value.model.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 120) } : {}),
    elapsedMs: Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0 ? value.elapsedMs : null,
    confidence: Number.isFinite(value.confidence) && value.confidence >= 0 && value.confidence <= 1 ? value.confidence : null,
    iteration: Number.isFinite(value.iteration) && value.iteration >= 0 ? value.iteration : null,
  };
  return withRunLock(id, () => {
    const file = runFile(id);
    const current = read(file);
    if (!current) return current;
    const jev = current.jev && typeof current.jev === "object" ? current.jev : {};
    const next = { ...current, jev: { observed: true, decisions: Math.max(0, Number(jev.decisions) || 0) + 1, lastDecision: decision }, updatedAt: new Date().toISOString() };
    write(file, next);
    return next;
  });
}
export function cancelAssistantRun(id, sessionId) {
  if (!validId(id) || typeof sessionId !== "string" || !sessionId || sessionId.length > 200) return null;
  const cancelled = withRunLock(id, () => {
    const run = read(runFile(id));
    if (run && run.sessionId !== sessionId) return null;
    const running = assistantRunIsExecuting(run);
    if (run && terminal.has(run.state) && !running) return run;
    const now = new Date().toISOString();
    const value = { ...run, id, sessionId, createdAt: run?.createdAt || now, updatedAt: now,
      executionCancelRequestedAt: run?.executionCancelRequestedAt || now,
      executionStopRequestedAt: run?.executionStopRequestedAt || now,
      executionActive: running,
      ...(!run || !terminal.has(run.state) ? { state: "cancelled", response: "", error: run ? "Stop requested. Actions that already finished are not undone." : "Stopped before the request started." } : {}),
    };
    write(runFile(id), value); return value;
  });
  if (!cancelled) return null;
  return cancelled.executionCancelRequestedAt ? reconcileExecution(id) : cancelled;
}
export function publicAssistantRun(run) {
  if (!run) return null;
  const { id, sessionId, state, response, error, statusLabel, textOnly, createdAt, updatedAt, jev } = run;
  return { id, sessionId, state, response, error, statusLabel, textOnly, createdAt, updatedAt, executionActive: assistantRunIsExecuting(run), executionCancelRequestedAt: run.executionCancelRequestedAt || null, executionCancelledAt: run.executionCancelledAt || null, jev: jev?.observed === true ? jev : null };
}
export function requestFileForRun(id) { return path.join(root, `${validId(id) ? id : "invalid"}.request`); }

// Dispatch and runner startup each have one durable claim. A process crash can
// leave uncertain work, but cannot permit the same request to execute twice.
export function claimAssistantRun(id) {
  return withRunLock(id, () => {
    const run = read(runFile(id));
    if (!run || run.state !== "queued" || run.launchClaimedAt) return null;
    const next = { ...run, launchClaimedAt: new Date().toISOString(), executionActive: true };
    write(runFile(id), next); return next;
  });
}
export function beginAssistantRun(id) {
  return withRunLock(id, () => {
    const run = read(runFile(id));
    if (!run || run.state !== "queued" || run.runnerStartedAt) return null;
    const now = new Date().toISOString();
    const next = { ...run, state: "active", pid: process.pid, executionActive: true, runnerStartedAt: now, updatedAt: now };
    write(runFile(id), next); return next;
  });
}
export function finishAssistantExecution(id) {
  return withRunLock(id, () => {
    const run = read(runFile(id)); if (!run) return null;
    if (run.executionActive === false && run.executionFinishedAt) return run;
    const now = new Date().toISOString();
    const childAlive = processGroupAlive(run.hermesProcessGroupPid);
    const next = { ...run, executionActive: childAlive, ...(!childAlive ? { executionFinishedAt: now, ...(run.executionCancelRequestedAt ? { executionCancelledAt: now } : {}) } : {}), ...(!terminal.has(run.state) ? { state: "interrupted", error: interruptedExecutionMessage, updatedAt: now } : {}) };
    write(runFile(id), next); recordSessionRun(next); return next;
  });
}
export function assistantRunIsExecuting(run) {
  return Boolean(run && run.executionActive && (processAlive(run.pid) || processGroupAlive(run.hermesProcessGroupPid)));
}

// The gate persists its group before spawning Hermes into that same group. A
// killed Node runner can therefore never leave an executing CLI unowned.
export function claimHermesProcessGroup(id) {
  return withRunLock(id, () => {
    const run = read(runFile(id));
    if (!run || terminal.has(run.state) || run.hermesProcessGroupPid || run.executionCancelRequestedAt || !processAlive(run.pid)) return null;
    const next = { ...run, hermesProcessGroupPid: process.pid, hermesGroupStartedAt: new Date().toISOString() };
    write(runFile(id), next); return next;
  });
}
export function recordHermesCliPid(id, pid) {
  return withRunLock(id, () => {
    const run = read(runFile(id));
    if (!run || run.hermesProcessGroupPid !== process.pid || !Number.isInteger(pid) || pid < 2) return null;
    const next = { ...run, hermesCliPid: pid };
    write(runFile(id), next); return next;
  });
}
