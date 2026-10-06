import path from "node:path";
import crypto from "node:crypto";
import { dataDirectory, inputError, processAlive, readJson, withFileLock, writeJson } from "./work-store.js";
import { getWorkSession, recordSessionRun, withWorkSessionControlLock } from "./work-sessions.js";
import { assistantRunIsExecuting, cancelAssistantRun, getAssistantRun, updateAssistantRun } from "./assistant-runs.js";
import { startAssistantRun } from "./assistant-launch.js";
import { MAX_USER_TEXT } from "./conversation-limits.js";

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
  const task = mutate(tasks => {
    const current = tasks.find(item => item.id === id);
    if (!current) throw inputError("Task not found.", 404);
    if (terminal.has(current.state)) return { ...current, alreadyTerminal: true };
    const settled = current.state === "running" ? getAssistantRun(current.runId, current.sessionId) : null;
    if (settled && terminal.has(settled.state) && !assistantRunIsExecuting(settled)) {
      Object.assign(current, { state: settled.state, response: settled.response || "", error: settled.error || "", completedAt: settled.updatedAt, updatedAt: new Date().toISOString() });
      return { ...current, alreadyTerminal: true };
    }
    const wasRunning = current.state === "running";
    Object.assign(current, { state: "cancelled", ...(settled?.response ? { response: settled.response } : {}), error: wasRunning ? "Stop requested. Actions that already finished are not undone." : "Cancelled before starting.", completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    return { ...current, wasRunning };
  });
  if (!task.alreadyTerminal && task.wasRunning) cancelAssistantRun(task.runId, task.sessionId);
  const { alreadyTerminal, wasRunning, ...saved } = task;
  return saved;
}
// A live PID owns the worker lease until exit. A stale heartbeat only changes
// the displayed readiness; it never authorizes a second worker to execute work.
export function acquireQueueWorker() {
  return withFileLock(workerFile(), () => {
    const current = readJson(workerFile());
    if (current?.owner && processAlive(current.pid)) return null;
    const lease = { owner: crypto.randomUUID(), pid: process.pid, running: true, lastHeartbeatAt: new Date().toISOString() };
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
  return { running: Boolean(worker?.running && processAlive(worker.pid) && Date.now() - Date.parse(worker.lastHeartbeatAt) < 10_000), lastHeartbeatAt: worker?.lastHeartbeatAt || null };
}
/** One tick claims each due task before launching. Once claimed, a missing run
 * or dead runner is uncertain, not permission to repeat an external action. */
export async function tickWorkQueue({ now = Date.now(), launch = startAssistantRun, getRun = getAssistantRun, isExecuting = assistantRunIsExecuting } = {}) {
  for (const task of listWorkTasks().filter(task => task.state === "running")) {
    const run = getRun(task.runId, task.sessionId);
    if (run && terminal.has(run.state) && !isExecuting(run)) {
      recordSessionRun(run);
      patchTask(task.id, { state: run.state, response: run.response || "", error: run.error || "", completedAt: run.updatedAt }, "running");
    } else if (!run || !isExecuting(run) && !processAlive(run.pid)) {
      if (run && !terminal.has(run.state)) updateAssistantRun(run.id, { state: "interrupted", error: interruptedMessage, executionActive: false });
      patchTask(task.id, { state: "interrupted", error: interruptedMessage, completedAt: new Date(now).toISOString() }, "running");
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
      if (run && terminal.has(run.state) && !isExecuting(run)) patchTask(task.id, { state: run.state, response: run.response || "", error: run.error || "", completedAt: run.updatedAt }, "running");
    } catch (error) {
      const run = getRun(task.runId, task.sessionId);
      if (error.status === 409 && !run) patchTask(task.id, { state: "queued", startedAt: null }, "running");
      else patchTask(task.id, { state: run && terminal.has(run.state) ? run.state : "error", error: error.status ? error.message : "The local assistant could not start this task. Check its session before retrying.", completedAt: new Date().toISOString() }, "running");
    }
  }
}
