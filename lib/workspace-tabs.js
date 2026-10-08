import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { dataDirectory, inputError, readJson, withFileLock, writeJson } from "./work-store.js";
import { createWorkSession, getWorkSession, currentWorkSessionRun, workSessionRunIsBusy } from "./work-sessions.js";
import { getAssistantRun, publicAssistantRun } from "./assistant-runs.js";
import { extractWorkspaceSpec, parseWorkspacePlan, parseWorkspaceReviewPlan, parseWorkspaceSpec, planningMessageText } from "./workspace-tab-contract.js";

export const WORKSPACE_BUILD_RESERVATION_MS = 15_000;

export function workspaceTabPaths(id) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw inputError("Invalid tab ID.");
  const directory = path.join(dataDirectory(), "workspace-tabs", id);
  return { directory, config: path.join(directory, "tab.json"), state: path.join(directory, "state.json") };
}
function title(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 60) throw inputError("Give the tab a name of up to 60 characters.");
  return value.trim();
}
export function getWorkspaceTab(id) { return readJson(workspaceTabPaths(id).config); }
export function createWorkspaceTab(input = {}) {
  const id = input.id || crypto.randomUUID(), paths = workspaceTabPaths(id);
  return withFileLock(paths.config, () => {
    const current = getWorkspaceTab(id); if (current) return current;
    const name = title(input.title || "New tab");
    fs.mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
    const session = createWorkSession({ name: `Plan: ${name}`, workingDirectory: paths.directory, workspaceTabId: id, workspaceRole: "planner" });
    const execution = createWorkSession({ name: name, workingDirectory: paths.directory });
    const now = new Date().toISOString();
    const tab = { id, title: name, sessionId: session.id, executionSessionId: execution.id, phase: "planning", createdAt: now, updatedAt: now, archivedAt: null, plan: null, previewVersion: null, publishedVersion: null, buildRunId: null, buildPlanDigest: null, buildReservedAt: null };
    writeJson(paths.config, tab); return tab;
  });
}
export function updateWorkspaceTab(id, patch) {
  const p = workspaceTabPaths(id);
  return withFileLock(p.config, () => {
    const tab = getWorkspaceTab(id); if (!tab) throw inputError("Tab not found.", 404);
    const next = { ...tab, ...patch, id, updatedAt: new Date().toISOString() };
    if (Object.hasOwn(patch, "title")) next.title = title(patch.title);
    writeJson(p.config, next); return next;
  });
}
export function reconcileWorkspaceTab(id) {
  const p = workspaceTabPaths(id);
  return withFileLock(p.config, () => {
    let tab = getWorkspaceTab(id); if (!tab) throw inputError("Tab not found.", 404);
    if (tab.buildRunId && tab.phase === "building") {
      const run = getAssistantRun(tab.buildRunId, tab.sessionId);
      if (!run) {
        const reservedAt = Date.parse(tab.buildReservedAt || "");
        const reservationAge = Date.now() - reservedAt;
        if (Number.isFinite(reservedAt) && reservationAge >= 0 && reservationAge <= WORKSPACE_BUILD_RESERVATION_MS) return tab;
        tab = { ...tab, phase: "error", buildReservedAt: null, error: "The build did not start. Your earlier tab is still available." };
      } else if (run.state === "complete") {
        try {
          const spec = extractWorkspaceSpec(run.response);
          const version = crypto.randomUUID();
          // Every version is a new regular file; old published versions survive rebuilds.
          fs.writeFileSync(path.join(p.directory, `${version}.json`), JSON.stringify(spec), { flag: "wx", mode: 0o600 });
          tab = { ...tab, phase: "preview", previewVersion: version, buildReservedAt: null, error: null };
        } catch (error) { tab = { ...tab, phase: "error", buildReservedAt: null, error: error.message }; }
      } else if (["error", "cancelled", "interrupted"].includes(run.state)) tab = { ...tab, phase: "error", buildReservedAt: null, error: run.error || "The build did not finish. Your earlier tab is still available." };
      if (tab.phase !== "building") writeJson(p.config, { ...tab, updatedAt: new Date().toISOString() });
    }
    return tab;
  });
}
export function workspaceTabDetails(id) {
  let tab = reconcileWorkspaceTab(id);
  const session = getWorkSession(tab.sessionId);
  const messages = (session?.messages || []).filter(item => !(tab.buildRunIds || [tab.buildRunId]).includes(item.runId));
  const runModes = new Map([...new Set(messages.map(item => item.runId).filter(Boolean))].map(runId => [runId, getAssistantRun(runId, tab.sessionId)?.workspaceMode || ""]));
  const run = currentWorkSessionRun(tab.sessionId);
  const last = messages.at(-1);
  const planParser = runModes.get(last?.runId) === "review" ? parseWorkspaceReviewPlan : parseWorkspacePlan;
  const plan = !workSessionRunIsBusy(run) && messages.filter(item => item.role === "user" && runModes.get(item.runId) !== "review").length >= 2 && ["hermes", "assistant"].includes(last?.role) && !last?.isError ? planParser(last.text) : null;
  const planDigest = plan ? crypto.createHash("sha256").update(JSON.stringify([plan, last.id, last.runId])).digest("hex") : null;
  return { tab: { ...tab, suggestedPlan: plan, planDigest, storagePath: workspaceTabPaths(id).directory }, messages: messages.filter(item => !(item.role === "user" && runModes.get(item.runId) === "review")).map(item => ({ ...item, text: planningMessageText(item.text, { review: runModes.get(item.runId) === "review" }) })).filter(item => item.text), run: run ? { ...publicAssistantRun(run), ...(tab.buildRunId === run.id ? { response: "" } : {}) } : null };
}
export function listWorkspaceTabs({ archived = false } = {}) {
  const root = path.join(dataDirectory(), "workspace-tabs");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter(id => /^[a-zA-Z0-9_-]{1,100}$/.test(id)).map(id => getWorkspaceTab(id)).filter(tab => tab && (archived || !tab.archivedAt)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(({ id, title, phase, publishedVersion, archivedAt }) => ({ id, title, phase, published: !!publishedVersion, archivedAt }));
}
export function readWorkspaceTabArtifact(id, { preview = false } = {}) {
  const tab = reconcileWorkspaceTab(id);
  const version = preview ? tab.previewVersion : tab.publishedVersion;
  if (tab.archivedAt || !version || !/^[a-f0-9-]{36}$/.test(version)) throw inputError("This tab does not have a saved preview yet.", 404);
  const file = path.join(workspaceTabPaths(id).directory, `${version}.json`);
  const info = fs.lstatSync(file); if (!info.isFile() || info.isSymbolicLink() || info.size > 100000) throw inputError("The tab file cannot be opened safely.", 409);
  let value; try { value = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw inputError("The saved tab is invalid. Rebuild its preview.", 409); }
  try { return { spec: parseWorkspaceSpec(value), version }; } catch { throw inputError("The saved tab is invalid. Rebuild its preview.", 409); }
}
export function publishWorkspaceTab(id, version) {
  reconcileWorkspaceTab(id);
  const paths = workspaceTabPaths(id);
  return withFileLock(paths.config, () => {
    const tab = getWorkspaceTab(id); if (!tab || tab.archivedAt) throw inputError("Tab not found.", 404);
    if (workSessionRunIsBusy(currentWorkSessionRun(tab.sessionId))) throw inputError("Wait for Hermes to finish before adding this preview.", 409);
    if (!version || tab.previewVersion !== version) throw inputError("This preview changed. Review the current version first.", 409);
    const file = path.join(paths.directory, `${version}.json`);
    let info; try { info = fs.lstatSync(file); } catch { throw inputError("This tab does not have a saved preview yet.", 404); }
    if (!info.isFile() || info.isSymbolicLink() || info.size > 100000) throw inputError("The tab file cannot be opened safely.", 409);
    try { parseWorkspaceSpec(JSON.parse(fs.readFileSync(file, "utf8"))); } catch { throw inputError("The saved tab is invalid. Rebuild its preview.", 409); }
    const next = { ...tab, publishedVersion: version, phase: "published", error: null, updatedAt: new Date().toISOString() };
    writeJson(paths.config, next); return next;
  });
}
export function failWorkspaceTabBuild(id, runId, message) {
  const paths = workspaceTabPaths(id);
  return withFileLock(paths.config, () => {
    const tab = getWorkspaceTab(id);
    if (!tab || tab.phase !== "building" || tab.buildRunId !== runId) return tab;
    const next = { ...tab, phase: "error", buildReservedAt: null, error: message, updatedAt: new Date().toISOString() };
    writeJson(paths.config, next); return next;
  });
}
export function readWorkspaceTabState(id) { if (!getWorkspaceTab(id)) throw inputError("Tab not found.", 404); return readJson(workspaceTabPaths(id).state, null); }
export function saveWorkspaceTabState(id, value) {
  const tab = getWorkspaceTab(id); if (!tab || tab.archivedAt) throw inputError("Tab not available.", 404);
  const serialized = JSON.stringify(value);
  if (!serialized || Buffer.byteLength(serialized, "utf8") > 100000) throw inputError("This tab can save up to 100 KB of local data.");
  writeJson(workspaceTabPaths(id).state, value); return true;
}
