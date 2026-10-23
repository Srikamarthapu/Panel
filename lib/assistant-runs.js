import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { dataDirectory, processIdentity, processMatchesIdentity, processGroupMatchesIdentity, readJson, withFileLock, writeJson } from "./work-store.js";
import { getWorkSession, recordSessionRun, validateWorkingDirectory, withWorkSessionControlLock } from "./work-sessions.js";
import { createRunOutcome, mergeToolReceipt } from "./run-outcome.js";

const root = path.join(dataDirectory(), "assistant-runs");
const terminal = new Set(["complete", "error", "cancelled", "interrupted"]);
const ACTIVE_INDEX_VERSION = 1;
const jevModes = new Set(["direct", "forced", "finish", "defer", "fallback", "context", "context-fallback", "model"]);
const validId = (id) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
const sessionFile = (sessionId) => path.join(root, `session-${crypto.createHash("sha256").update(sessionId).digest("hex")}.json`);
const activeIndexFile = () => path.join(root, "active-index.json");
const runFile = (id) => {
  if (!validId(id)) throw new Error("Invalid request ID.");
  return path.join(root, `${id}.json`);
};
const finalResultFile = (id) => `${runFile(id)}.final`;
const read = file => readJson(file);
const write = (file, value) => writeJson(file, value);
const potentiallyActive = run => Boolean(run?.id && (!terminal.has(run.state) || run.executionActive === true));
function activeIndexPayload(ids) {
  return { version: ACTIVE_INDEX_VERSION, ids: [...new Set(ids)].filter(validId).sort(), updatedAt: new Date().toISOString() };
}
function readActiveIndex() {
  try {
    const value = read(activeIndexFile());
    return value?.version === ACTIVE_INDEX_VERSION && Array.isArray(value.ids) && value.ids.every(validId) ? value : null;
  } catch { return null; }
}
function scanPotentiallyActiveIds() {
  const ids = [];
  for (const file of fs.readdirSync(root)) {
    if (file === path.basename(activeIndexFile()) || !file.endsWith(".json")) continue;
    const id = file.slice(0, -5);
    if (!validId(id)) continue;
    try {
      const run = read(path.join(root, file));
      if (run?.id === id && potentiallyActive(run)) ids.push(id);
    } catch {
      // A malformed run cannot safely be classified as terminal during an
      // index rebuild, so retain it in the bounded working set.
      ids.push(id);
    }
  }
  return ids;
}
function rebuildActiveIndex() {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return withFileLock(activeIndexFile(), () => {
    const current = readActiveIndex();
    if (current) return current;
    const next = activeIndexPayload(scanPotentiallyActiveIds());
    write(activeIndexFile(), next);
    return next;
  });
}
function mutateActiveIndex(id, include) {
  if (!validId(id)) return;
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  withFileLock(activeIndexFile(), () => {
    const current = readActiveIndex() || activeIndexPayload(scanPotentiallyActiveIds());
    const ids = new Set(current.ids);
    if (include) ids.add(id); else ids.delete(id);
    write(activeIndexFile(), activeIndexPayload(ids));
  });
}
function syncActiveIndex(run) { if (run?.id) mutateActiveIndex(run.id, potentiallyActive(run)); }
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
  withFileLock(file, () => write(file, { ...read(file), hermesSessionId, updatedAt: new Date().toISOString() }));
}
export function prepareConversationRuntime(sessionId, executionMode) {
  if (typeof sessionId !== "string" || !sessionId || !["hermes", "direct"].includes(executionMode)) return null;
  const file = sessionFile(sessionId);
  return withFileLock(file, () => {
    const current = read(file) || {};
    const switched = current.executionMode && current.executionMode !== executionMode;
    const runtimeGeneration = switched ? Math.max(1, Number(current.runtimeGeneration) || 1) + 1 : Math.max(1, Number(current.runtimeGeneration) || 1);
    const next = { ...current, executionMode, runtimeGeneration, updatedAt: new Date().toISOString() };
    // A direct turn is not present in an older native Hermes conversation.
    // Starting Hermes again creates a fresh native session from Panel's
    // visible history instead of silently resuming that stale branch.
    if (executionMode === "hermes" && current.executionMode === "direct") delete next.hermesSessionId;
    write(file, next);
    return next;
  });
}
const interruptedExecutionMessage = "The assistant runtime stopped before returning a final answer. Check whether any actions completed before trying again; this request was not replayed.";
const pendingReaps = new Set();
function signalGroup(pid, identity, signal) {
  if (!processGroupMatchesIdentity(pid, identity)) return;
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
    const helperAlive = processMatchesIdentity(current.pid, current.pidIdentity);
    const ownedGroup = current.hermesProcessGroupPid || current.persistentRuntimePid;
    const ownedGroupIdentity = current.hermesProcessGroupPid ? current.hermesProcessGroupIdentity : current.persistentRuntimeIdentity;
    const childAlive = processGroupMatchesIdentity(ownedGroup, ownedGroupIdentity);
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
    if (childAlive) groupSignal = { pid: ownedGroup, identity: ownedGroupIdentity, signal: force ? "SIGKILL" : "SIGTERM" };
    if (stopping && helperAlive) runnerSignal = { pid: current.pid, identity: current.pidIdentity, signal: force && !childAlive ? "SIGKILL" : "SIGTERM" };
    write(runFile(id), next);
    return next;
  });
  if (groupSignal) signalGroup(groupSignal.pid, groupSignal.identity, groupSignal.signal);
  if (runnerSignal && runnerSignal.pid !== process.pid) signalGroup(runnerSignal.pid, runnerSignal.identity, runnerSignal.signal);
  if (run?.executionActive && (groupSignal || runnerSignal)) scheduleExecutionReap(id);
  syncActiveIndex(run);
  recordSessionRun(run);
  return run;
}
function reconcileFinalResult(id) {
  const staged = read(finalResultFile(id));
  if (!staged) return null;
  let discard = false;
  const run = withRunLock(id, () => {
    const current = read(runFile(id));
    if (!current || staged.version !== 1 || staged.runCreatedAt !== current.createdAt || !terminal.has(staged.result?.state)) {
      discard = true;
      return current;
    }
    if (terminal.has(current.state)) return current;
    const next = { ...current, ...staged.result, id: current.id, sessionId: current.sessionId, updatedAt: staged.savedAt };
    write(runFile(id), next);
    return next;
  });
  if (run) recordSessionRun(run);
  syncActiveIndex(run);
  if (discard || terminal.has(run?.state)) {
    try { fs.unlinkSync(finalResultFile(id)); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return run;
}
/** Stage an authoritative terminal result before taking the contended run lock.
 * A later reader can finish the commit after a helper crash or lock timeout. */
export function finalizeAssistantRun(id, result) {
  if (!validId(id) || !result || !terminal.has(result.state)) throw new Error("Invalid final assistant result.");
  const current = read(runFile(id));
  if (!current || terminal.has(current.state)) return current;
  const file = finalResultFile(id);
  withFileLock(file, () => {
    let existing;
    try { existing = read(file); } catch { /* replace an invalid internal sidecar */ }
    if (existing?.version === 1 && existing.runCreatedAt === current.createdAt && terminal.has(existing.result?.state)) return;
    write(file, { version: 1, runCreatedAt: current.createdAt, savedAt: new Date().toISOString(), result });
  });
  return reconcileFinalResult(id);
}
export function getAssistantRun(id, sessionId) {
  if (!validId(id)) return null;
  let run = read(runFile(id));
  if (!run || sessionId && run.sessionId !== sessionId) return null;
  run = reconcileFinalResult(id) || run;
  const lostHelper = run.executionActive && (Number.isInteger(run.pid) && !processMatchesIdentity(run.pid, run.pidIdentity) || !run.pid && run.launchClaimedAt && Date.now() - Date.parse(run.launchClaimedAt) > 10_000);
  if (!(run.executionActive === false && run.executionFinishedAt) && (lostHelper || run.executionCancelRequestedAt || run.executionStopRequestedAt)) run = reconcileExecution(id);
  if (!terminal.has(run.state) && Date.now() - Date.parse(run.createdAt) > 15 * 60_000) {
    const expiredAt = new Date().toISOString();
    run = withRunLock(id, () => {
      const current = read(runFile(id));
      if (!current || terminal.has(current.state)) return current;
      const next = { ...current, state: "error", response: "", error: "This request expired and its execution was stopped. Check whether any actions completed before retrying.", executionStopRequestedAt: current.executionStopRequestedAt || expiredAt, updatedAt: expiredAt };
      write(runFile(id), next);
      return next;
    });
    run = reconcileExecution(id);
  }
  recordSessionRun(run);
  return run;
}
export function listAssistantRunsForSessions(sessionIds) {
  const wanted = new Set(Array.isArray(sessionIds) ? sessionIds.filter(id => typeof id === "string" && id) : []);
  if (!wanted.size) return [];
  let files;
  try { files = fs.readdirSync(root); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return files
    .filter(file => file !== path.basename(activeIndexFile()) && file.endsWith(".json") && !file.startsWith("session-"))
    .map(file => read(path.join(root, file)))
    .filter(run => run?.id && wanted.has(run.sessionId));
}
export const MAX_CONCURRENT_ASSISTANT_RUNS = 4;
export function createAssistantRun(input) {
  // Only admission is serialized. Independent sessions execute concurrently.
  return withFileLock(path.join(root, "admission"), () => withWorkSessionControlLock(input.sessionId, () => createAssistantRunLocked(input)));
}
function executingRunCount() {
  let count = 0;
  const stale = [];
  for (const id of (readActiveIndex() || rebuildActiveIndex()).ids) {
    const run = getAssistantRun(id);
    if (run && (!terminal.has(run.state) || assistantRunIsExecuting(run))) count += 1;
    else stale.push(id);
  }
  for (const id of stale) mutateActiveIndex(id, false);
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
  return withFileLock(file, () => {
    const session = read(file) || {};
    const active = session.activeRunId && getAssistantRun(session.activeRunId);
    if (active && (!terminal.has(active.state) || assistantRunIsExecuting(active))) {
      const err = new Error("The assistant is still working on the previous request. Stop it before sending another."); err.status = 409; throw err;
    }
    if (executingRunCount() >= MAX_CONCURRENT_ASSISTANT_RUNS) {
      const error = new Error(`Panel can run up to ${MAX_CONCURRENT_ASSISTANT_RUNS} requests at once. Wait for one to finish or stop a running request.`); error.status = 409; throw error;
    }
    const run = { ...input, id: input.id || crypto.randomUUID(), state: "queued", response: "", error: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    // Reserve before persisting the run: a crash can leave a harmless stale
    // index entry, but can never create an executing run omitted from admission.
    mutateActiveIndex(run.id, true);
    let saved;
    try {
      saved = withRunLock(run.id, () => {
        const previous = read(runFile(run.id));
        if (previous) {
          if (previous.sessionId !== input.sessionId) throw new Error("Request ID belongs to another conversation.");
          return previous;
        }
        write(runFile(run.id), run);
        return run;
      });
    } catch (error) {
      mutateActiveIndex(run.id, false);
      throw error;
    }
    write(file, { ...session, activeRunId: run.id });
    recordSessionRun(saved);
    return saved;
  });
}
export function updateAssistantRun(id, patch) {
  const run = withRunLock(id, () => {
    const file = runFile(id);
    const current = read(file);
    if (!current || terminal.has(current.state)) return current;
    const next = { ...current, ...patch, id: current.id, sessionId: current.sessionId, updatedAt: new Date().toISOString() };
    write(file, next);
    return next;
  });
  syncActiveIndex(run);
  recordSessionRun(run);
  return run;
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
export function recordAssistantRunToolEvent(id, event) {
  const run = withRunLock(id, () => {
    const file = runFile(id);
    const current = read(file);
    if (!current || !event || typeof event !== "object") return current;
    const previous = current.outcomeEvidence?.toolReceipts || [];
    const locations = Array.isArray(event.locations) ? event.locations.map(location => {
      if (!location || typeof location.path !== "string" || path.isAbsolute(location.path) || !current.workingDirectory) return location;
      return { ...location, path: path.resolve(current.workingDirectory, location.path) };
    }) : event.locations;
    const toolReceipts = mergeToolReceipt(previous, { ...event, locations });
    if (toolReceipts === previous || !toolReceipts.length) return current;
    const next = { ...current, outcomeEvidence: { ...current.outcomeEvidence, toolReceipts } };
    write(file, next);
    return next;
  });
  if (terminal.has(run?.state)) recordSessionRun(run);
  return run;
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
      executionActive: running, permission: null, toolProgress: null,
      ...(!run || !terminal.has(run.state) ? { state: "cancelled", response: "", error: run ? "Stop requested. Actions that already finished are not undone." : "Stopped before the request started." } : {}),
    };
    write(runFile(id), value); return value;
  });
  if (!cancelled) return null;
  return cancelled.executionCancelRequestedAt ? reconcileExecution(id) : cancelled;
}
export function publicAssistantRun(run) {
  if (!run) return null;
  const { id, sessionId, state, response, error, partialResponse, statusLabel, textOnly, createdAt, updatedAt, jev, permission, toolProgress, executionMode } = run;
  return { id, sessionId, state, response, error, partialResponse: typeof partialResponse === "string" ? partialResponse : "", statusLabel, textOnly, createdAt, updatedAt, executionMode: executionMode === "direct" ? "direct" : "hermes", outcome: createRunOutcome(run), executionActive: assistantRunIsExecuting(run), executionCancelRequestedAt: run.executionCancelRequestedAt || null, executionCancelledAt: run.executionCancelledAt || null, jev: jev?.observed === true ? jev : null, toolProgress: state === "active" && !permission ? toolProgress || null : null, ...(permission ? { permission } : {}) };
}
export function assistantRunVersion(id) {
  if (!validId(id)) return "";
  try {
    const stat = fs.statSync(runFile(id), { bigint: true });
    return `${stat.size}:${stat.mtimeNs}`;
  } catch (error) { if (error.code === "ENOENT") return ""; throw error; }
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
  const pidIdentity = processIdentity(process.pid);
  if (!pidIdentity) throw new Error("Panel could not verify ownership of the assistant process. Restart Panel and try again.");
  return withRunLock(id, () => {
    const run = read(runFile(id));
    if (!run || run.state !== "queued" || run.runnerStartedAt) return null;
    const now = new Date().toISOString();
    const next = { ...run, state: "active", pid: process.pid, pidIdentity, executionActive: true, runnerStartedAt: now, updatedAt: now };
    write(runFile(id), next); return next;
  });
}
export function finishAssistantExecution(id) {
  // Commit a staged terminal answer before an execution fallback can classify
  // the same work as interrupted.
  reconcileFinalResult(id);
  const result = withRunLock(id, () => {
    const run = read(runFile(id)); if (!run) return null;
    if (run.executionActive === false && run.executionFinishedAt) return run;
    const now = new Date().toISOString();
    const childAlive = processGroupMatchesIdentity(run.hermesProcessGroupPid, run.hermesProcessGroupIdentity);
    const next = { ...run, executionActive: childAlive, ...(!childAlive ? { executionFinishedAt: now, ...(run.executionCancelRequestedAt ? { executionCancelledAt: now } : {}) } : {}), ...(!terminal.has(run.state) ? { state: "interrupted", error: interruptedExecutionMessage, updatedAt: now } : {}) };
    write(runFile(id), next); recordSessionRun(next); return next;
  });
  syncActiveIndex(result);
  return result;
}
export function assistantRunIsExecuting(run) {
  const groupPid = run?.hermesProcessGroupPid || run?.persistentRuntimePid;
  const groupIdentity = run?.hermesProcessGroupPid ? run?.hermesProcessGroupIdentity : run?.persistentRuntimeIdentity;
  return Boolean(run && run.executionActive && (processMatchesIdentity(run.pid, run.pidIdentity) || processGroupMatchesIdentity(groupPid, groupIdentity)));
}

// The gate persists its group before spawning Hermes into that same group. A
// killed Node runner can therefore never leave an executing CLI unowned.
export function claimHermesProcessGroup(id) {
  const hermesProcessGroupIdentity = processIdentity(process.pid);
  if (!hermesProcessGroupIdentity) throw new Error("Panel could not verify ownership of the Hermes process group.");
  return withRunLock(id, () => {
    const run = read(runFile(id));
    if (!run || terminal.has(run.state) || run.hermesProcessGroupPid || run.executionCancelRequestedAt || !processMatchesIdentity(run.pid, run.pidIdentity)) return null;
    const next = { ...run, hermesProcessGroupPid: process.pid, hermesProcessGroupIdentity, hermesGroupStartedAt: new Date().toISOString() };
    write(runFile(id), next); return next;
  });
}
export function recordHermesCliPid(id, pid) {
  return withRunLock(id, () => {
    const run = read(runFile(id));
    if (!run || run.hermesProcessGroupPid !== process.pid || !Number.isInteger(pid) || pid < 2) return null;
    const next = { ...run, hermesCliPid: pid, hermesCliIdentity: processIdentity(pid) };
    write(runFile(id), next); return next;
  });
}
