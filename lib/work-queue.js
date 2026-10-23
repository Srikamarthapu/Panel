import path from "node:path";
import crypto from "node:crypto";
import { dataDirectory, inputError, processIdentity, processMatchesIdentity, readJson, withFileLock, writeJson } from "./work-store.js";
import { getWorkSession, recordSessionRun, withWorkSessionControlLock } from "./work-sessions.js";
import { assistantRunIsExecuting, cancelAssistantRun, getAssistantRun, updateAssistantRun } from "./assistant-runs.js";
import { startAssistantRun } from "./assistant-launch.js";
import { MAX_USER_TEXT } from "./conversation-limits.js";
import { compactRunOutcome, createRunOutcome, outcomeFromLegacyResult } from "./run-outcome.js";

const queueFile = () => path.join(dataDirectory(), "work-queue.json");
const workerFile = () => path.join(dataDirectory(), "work-queue-worker.json");
const terminal = new Set(["complete", "error", "cancelled", "interrupted"]);
const interruptedMessage = "Panel lost contact with this run. Check its actions and session before scheduling it again; it was not replayed.";
function mutate(callback) {
  return withFileLock(queueFile(), () => {
    const store = readJson(queueFile(), { tasks: [] });
    const result = callback(store.tasks);
    writeJson(queueFile(), store); return result;
  });
}
export function listWorkTasks() { return readJson(queueFile(), { tasks: [] }).tasks.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
export function listPublicWorkTasks() {
  return listWorkTasks().map(task => {
    let outcome = task.outcome;
    if (terminal.has(task.state) && outcome?.execution?.active) {
      const run = getAssistantRun(task.runId, task.sessionId);
      if (run && !assistantRunIsExecuting(run)) outcome = createRunOutcome(run);
    }
    return { ...task, response: typeof task.response === "string" ? task.response.slice(0, 2_000) : "", error: typeof task.error === "string" ? task.error.slice(0, 1_000) : "", outcome: compactRunOutcome(outcome) };
  });
}
export function getWorkTask(id) { return listWorkTasks().find(task => task.id === id) || null; }
export function createWorkTask(input = {}) {
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt || prompt.length > MAX_USER_TEXT) throw inputError(`Enter a task of 1–${MAX_USER_TEXT.toLocaleString()} characters.`);

  const requestId = input.requestId;
  if (requestId !== undefined && (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(requestId))) throw inputError("Request IDs must contain 1–100 letters, numbers, underscores, or hyphens.");
  const immediate = input.runAt === undefined || input.runAt === null || input.runAt === "";
  const scheduled = immediate ? new Date() : typeof input.runAt === "string" ? new Date(input.runAt) : new Date(NaN);
  if (!Number.isFinite(scheduled.getTime())) throw inputError("Choose a valid date and time.");
  // An immediate request fingerprints the intent, not its generated timestamp,
  // so a retry after an uncertain network response still finds the first task.
  const requestFingerprint = requestId ? crypto.createHash("sha256").update(JSON.stringify({ sessionId: input.sessionId, prompt, runAt: immediate ? null : scheduled.toISOString() })).digest("hex") : null;
  return withWorkSessionControlLock(input.sessionId, () => {
    const session = getWorkSession(input.sessionId);
    if (!session) throw inputError("Choose an existing session for this task.", 404);
    if (session.archivedAt) throw inputError("Restore this archived session before scheduling a task.", 409);
    return mutate(tasks => {
      const existing = requestId && tasks.find(task => task.requestId === requestId);
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint) throw inputError("This request ID was already used for a different task. Start a new request for changed input.", 409);
        return { ...existing };
      }
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const task = { id, sessionId: input.sessionId, prompt, runAt: scheduled.toISOString(), state: "queued", runId: `task-${id}`, createdAt: now, updatedAt: now, response: "", error: "", ...(requestId ? { requestId, requestFingerprint } : {}) };
      tasks.push(task); return task;
    });
  });
}
function patchTask(id, patch, expectedState) {
  return mutate(tasks => {
    const task = tasks.find(item => item.id === id);
    if (!task || expectedState && task.state !== expectedState) return null;
    Object.assign(task, patch, { updatedAt: new Date().toISOString() }); return { ...task };
  });
}
export function cancelWorkTask(id) {
  let task = mutate(tasks => {
    const current = tasks.find(item => item.id === id);
    if (!current) throw inputError("Task not found.", 404);
    if (terminal.has(current.state)) return { ...current, alreadyTerminal: true };
    const settled = current.state === "running" ? getAssistantRun(current.runId, current.sessionId) : null;
    if (settled && terminal.has(settled.state) && !assistantRunIsExecuting(settled)) {
      Object.assign(current, { state: settled.state, response: settled.response || "", error: settled.error || "", outcome: createRunOutcome(settled), completedAt: settled.updatedAt, updatedAt: new Date().toISOString() });
      return { ...current, alreadyTerminal: true };
    }
    const wasRunning = current.state === "running";
    const updatedAt = new Date().toISOString();
    const error = wasRunning ? "Stop requested. Actions that already finished are not undone." : "Cancelled before starting.";
    Object.assign(current, { state: "cancelled", ...(settled?.response ? { response: settled.response } : {}), error, outcome: outcomeFromLegacyResult({ state: "cancelled", error, updatedAt }), completedAt: updatedAt, updatedAt });
    return { ...current, wasRunning };
  });
  if (!task.alreadyTerminal && task.wasRunning) {
    const run = cancelAssistantRun(task.runId, task.sessionId);
    if (run) task = { ...task, ...patchTask(task.id, { state: run.state, response: run.response || "", error: run.error || task.error, outcome: createRunOutcome(run), completedAt: run.updatedAt }) };
  }
  const { alreadyTerminal, wasRunning, ...saved } = task;
  return saved;
}
// A live PID owns the worker lease until exit. A stale heartbeat only changes
// the displayed readiness; it never authorizes a second worker to execute work.
export function acquireQueueWorker() {
  return withFileLock(workerFile(), () => {
    const current = readJson(workerFile());
    if (current?.owner && processMatchesIdentity(current.pid, current.pidIdentity)) return null;
    const pidIdentity = processIdentity(process.pid);
    if (!pidIdentity) throw new Error("Panel could not verify ownership of the scheduled-work process. Restart Panel and try again.");
    const lease = { owner: crypto.randomUUID(), pid: process.pid, pidIdentity, running: true, lastHeartbeatAt: new Date().toISOString() };
    writeJson(workerFile(), lease); return lease;
  });
}
export function heartbeatQueueWorker(lease) {
  return withFileLock(workerFile(), () => {
    const current = readJson(workerFile());
    if (current?.owner !== lease.owner) return false;
    writeJson(workerFile(), { ...current, running: true, lastHeartbeatAt: new Date().toISOString() }); return true;
  });
}
export function releaseQueueWorker(lease) {
  return withFileLock(workerFile(), () => {
    const current = readJson(workerFile());
    if (current?.owner === lease.owner) writeJson(workerFile(), { ...current, owner: null, running: false });
  });
}
export function queueWorkerStatus() {
  const worker = readJson(workerFile());
  return { running: Boolean(worker?.running && processMatchesIdentity(worker.pid, worker.pidIdentity) && Date.now() - Date.parse(worker.lastHeartbeatAt) < 10_000), lastHeartbeatAt: worker?.lastHeartbeatAt || null };
}
/** One tick claims each due task before launching. Once claimed, a missing run
 * or dead runner is uncertain, not permission to repeat an external action. */
export async function tickWorkQueue({ now = Date.now(), launch = startAssistantRun, getRun = getAssistantRun, isExecuting = assistantRunIsExecuting } = {}) {
  for (const task of listWorkTasks().filter(task => terminal.has(task.state) && task.outcome?.execution?.active)) {
    const run = getRun(task.runId, task.sessionId);
    if (run && !isExecuting(run)) patchTask(task.id, { outcome: createRunOutcome(run), completedAt: run.executionFinishedAt || run.updatedAt });
  }
  for (const task of listWorkTasks().filter(task => task.state === "running")) {
    const run = getRun(task.runId, task.sessionId);
    if (run && terminal.has(run.state) && !isExecuting(run)) {
      recordSessionRun(run);
      patchTask(task.id, { state: run.state, response: run.response || "", error: run.error || "", outcome: createRunOutcome(run), completedAt: run.updatedAt }, "running");
    } else if (!run || !isExecuting(run)) {
      const interrupted = run && !terminal.has(run.state) ? updateAssistantRun(run.id, { state: "interrupted", error: interruptedMessage, executionActive: false }) : run;
      const completedAt = new Date(now).toISOString();
      patchTask(task.id, { state: "interrupted", error: interruptedMessage, outcome: interrupted ? createRunOutcome(interrupted) : outcomeFromLegacyResult({ state: "interrupted", error: interruptedMessage, updatedAt: completedAt }), completedAt }, "running");
    }
  }
  const due = listWorkTasks().filter(task => task.state === "queued" && Date.parse(task.runAt) <= now).sort((a, b) => a.runAt.localeCompare(b.runAt) || a.createdAt.localeCompare(b.createdAt));
  for (const candidate of due) {
    // One queued agent job at a time keeps unattended provider/process use
    // bounded. Foreground chat in another session remains independent.
    const occupied = listWorkTasks().some(task => task.state === "running" || task.state === "cancelled" && isExecuting(getRun(task.runId, task.sessionId)));
    if (occupied) break;
    const task = patchTask(candidate.id, { state: "running", startedAt: new Date(now).toISOString() }, "queued");
    if (!task || getWorkTask(task.id)?.state !== "running") continue;
    try {
      const run = await launch({ id: task.runId, sessionId: task.sessionId, text: task.prompt, textOnly: true, source: "task" });
      if (run && terminal.has(run.state) && !isExecuting(run)) patchTask(task.id, { state: run.state, response: run.response || "", error: run.error || "", outcome: createRunOutcome(run), completedAt: run.updatedAt }, "running");
    } catch (error) {
      const run = getRun(task.runId, task.sessionId);
      if (error.code === "AGENT_POLICY_TRANSPORT_UNSUPPORTED" && !run) patchTask(task.id, { state: "error", error: error.message, completedAt: new Date(now).toISOString() }, "running");
      else if (error.status === 409 && !run) patchTask(task.id, { state: "queued", startedAt: null }, "running");
      else patchTask(task.id, { state: run && terminal.has(run.state) ? run.state : "error", error: error.status ? error.message : "The local assistant could not start this task. Check its session before retrying.", completedAt: new Date().toISOString() }, "running");
    }
  }
}
