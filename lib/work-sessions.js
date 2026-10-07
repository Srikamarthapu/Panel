import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { dataDirectory, inputError, readJson, withFileLock, writeJson } from "./work-store.js";
import { MAX_USER_TEXT, MAX_ASSISTANT_TEXT } from "./conversation-limits.js";
import { publicReplyText, normalizeTranscriptEntries } from "./publicReply.js";
import { assistantRunIsExecuting, getAssistantRun, getConversationSession } from "./assistant-runs.js";

const directory = () => path.join(dataDirectory(), "work-sessions");
const validId = id => typeof id === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(id);
function fileFor(id) { if (!validId(id)) throw inputError("Invalid session ID."); return path.join(directory(), `${id}.json`); }
function nameFor(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 120) throw inputError("Session names must contain 1–120 characters.");
  return value.trim();
}
export function validateWorkingDirectory(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 4096 || !path.isAbsolute(value) || value.includes("\0")) throw inputError("Choose an existing absolute folder path.");
  try { const resolved = fs.realpathSync(value); if (fs.statSync(resolved).isDirectory()) return resolved; } catch {}
  throw inputError("The working folder does not exist or is not a directory.");
}
const summary = ({ messages, ...session }) => ({ ...session, pinned: session.pinned === true, archivedAt: session.archivedAt || null });
// Separate from transcript writes: metadata changes and run admission share this
// short transaction while result recording can safely take the transcript lock.
export function withWorkSessionControlLock(id, callback) {
  return withFileLock(`${fileFor(id)}.control`, callback);
}
export function currentWorkSessionRun(id) {
  const runId = getConversationSession(id).activeRunId;
  return runId ? getAssistantRun(runId, id) : null;
}
export function workSessionRunIsBusy(run) {
  return !!run && (["queued", "active"].includes(run.state) || assistantRunIsExecuting(run));
}
export function workSessionRunSummary(run) {
  if (!run) return null;
  const { id, sessionId, state, textOnly, createdAt, updatedAt } = run;
  return { id, sessionId, state, textOnly: !!textOnly, createdAt, updatedAt,
    statusLabel: typeof run.statusLabel === "string" ? run.statusLabel.slice(0, 200) : "",
    executionActive: assistantRunIsExecuting(run),
    executionCancelRequestedAt: run.executionCancelRequestedAt || null,
    permissionPending: run.state === "active" && !!run.permission,
    toolLabel: run.state === "active" && typeof run.toolProgress?.title === "string" ? run.toolProgress.title.slice(0, 160) : null };
}
export function workSessionSummaryWithRun(session) {
  if (!session) return null;
  const run = currentWorkSessionRun(session.id);
  // Reconciliation may have just recorded a terminal receipt.
  const current = getWorkSession(session.id) || session;
  const lastRun = workSessionRunSummary(run);
  return { ...summary(current), activeRun: workSessionRunIsBusy(run) ? lastRun : null, lastRun };
}
export function getWorkSession(id) { return validId(id) ? readJson(fileFor(id)) : null; }
export function listWorkSessions() {
  let files; try { files = fs.readdirSync(directory()); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return files.filter(file => file.endsWith(".json")).map(file => readJson(path.join(directory(), file))).filter(Boolean).map(workSessionSummaryWithRun).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
}
export function createWorkSession(input = {}) {
  const id = input.id || crypto.randomUUID();
  const file = fileFor(id);
  const name = nameFor(input.name || "New session");
  const workingDirectory = validateWorkingDirectory(input.workingDirectory);
  return withFileLock(file, () => {
    const existing = readJson(file);
    if (existing) return summary(existing);
    const now = new Date().toISOString();
    const session = { id, name, workingDirectory, ...(validId(input.agentId) ? { agentId: input.agentId } : {}), pinned: false, archivedAt: null, createdAt: now, updatedAt: now, messages: [] };
    writeJson(file, session); return summary(session);
  });
}
export function updateWorkSession(id, patch) {
  const file = fileFor(id);
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw inputError("A session object is required.");
  const changes = {};
  if (Object.hasOwn(patch, "name")) changes.name = nameFor(patch.name);
  if (Object.hasOwn(patch, "workingDirectory")) changes.workingDirectory = validateWorkingDirectory(patch.workingDirectory);
  for (const field of ["pinned", "archived"]) {
    if (Object.hasOwn(patch, field) && typeof patch[field] !== "boolean") throw inputError(`${field} must be true or false.`);
  }
  if (Object.hasOwn(patch, "pinned")) changes.pinned = patch.pinned;
  return withWorkSessionControlLock(id, () => {
    const saved = getWorkSession(id);
    if (!saved) throw inputError("Session not found.", 404);
    const folderChanged = Object.hasOwn(changes, "workingDirectory") && changes.workingDirectory !== (saved.workingDirectory || null);
    if (folderChanged || patch.archived === true) {
      if (workSessionRunIsBusy(currentWorkSessionRun(id))) throw inputError("Wait for this session's current request to stop before changing its folder or archiving it.", 409);
    }
    if (patch.archived === true || folderChanged) {
      const queued = readJson(path.join(dataDirectory(), "work-queue.json"), { tasks: [] }).tasks;
      if (queued.some(task => task.sessionId === id && ["queued", "running"].includes(task.state))) throw inputError("Cancel this session's pending scheduled tasks before changing its folder or archiving it.", 409);
    }
    return withFileLock(file, () => {
      const current = readJson(file);
      if (Object.hasOwn(patch, "archived")) changes.archivedAt = patch.archived ? current.archivedAt || new Date().toISOString() : null;
      const next = { ...current, ...changes, updatedAt: new Date().toISOString() };
      writeJson(file, next); return summary(next);
    });
  });
}
export function publicWorkSession(session) { return session ? summary(session) : null; }
// Adopt browser history once, keeping this exact ID's existing Hermes mapping.
// Existing server messages and metadata always remain authoritative.
export function adoptLegacyMessages(id, entries) {
  if (!Array.isArray(entries) || entries.length > 100) throw inputError("Expected up to 100 saved messages.");
  const imported = normalizeTranscriptEntries(entries.filter(entry => typeof entry?.text === "string"));
  const file = fileFor(id);
  return withFileLock(file, () => {
    const current = readJson(file);
    if (!current) throw inputError("Session not found.", 404);
    if (current.legacyAdoptedAt) return summary(current);
    const counts = new Map();
    const signature = entry => JSON.stringify([entry.role, entry.text, !!entry.isError]);
    for (const entry of current.messages) counts.set(signature(entry), (counts.get(signature(entry)) || 0) + 1);
    const older = [];
    // Match newest occurrences first so repeated older exchanges stay intact.
    for (let index = imported.length - 1; index >= 0; index--) {
      const entry = imported[index], key = signature(entry), count = counts.get(key) || 0;
      if (count) { counts.set(key, count - 1); continue; }
      older.unshift({ ...entry, id: `legacy:${index}:${crypto.createHash("sha256").update(key).digest("hex").slice(0, 16)}`, createdAt: current.createdAt });
    }
    const next = { ...current, messages: [...older, ...current.messages], legacyAdoptedAt: new Date().toISOString() };
    writeJson(file, next);
    return summary(next);
  });
}
// Run IDs make repeated polls, cancellation, and post-restart reconciliation idempotent.
export function recordSessionRun(run) {
  if (!run || !validId(run.sessionId)) return;
  const file = fileFor(run.sessionId);
  if (!fs.existsSync(file)) return; // Legacy sessions are adopted at the chat boundary.
  withFileLock(file, () => {
    const session = readJson(file); if (!session) return;
    const messages = [...session.messages];
    let changed = false;
    const append = entry => { if (entry.text && !messages.some(item => item.id === entry.id)) { messages.push(entry); changed = true; } };
    if (run.text) append({ id: `${run.id}:user`, runId: run.id, role: "user", text: run.text.slice(0, MAX_USER_TEXT), createdAt: run.createdAt });
    if (["complete", "error", "cancelled", "interrupted"].includes(run.state)) {
      const isError = run.state !== "complete";
      append({ id: `${run.id}:result`, runId: run.id, role: "hermes", text: publicReplyText(isError ? run.error : run.response).slice(0, MAX_ASSISTANT_TEXT), createdAt: run.updatedAt, ...(isError ? { isError: true } : {}) });
    }
    if (changed) writeJson(file, { ...session, messages, updatedAt: new Date().toISOString() });
  });
}
