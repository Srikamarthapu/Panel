import crypto from "node:crypto";
import { inputError, withFileLock } from "./work-store.js";
import { startAssistantRun } from "./assistant-launch.js";
import { cancelAssistantRun, publicAssistantRun } from "./assistant-runs.js";
import { currentWorkSessionRun, workSessionRunIsBusy } from "./work-sessions.js";
import { failWorkspaceTabBuild, getWorkspaceTab, workspaceTabPaths, workspaceTabDetails, updateWorkspaceTab, publishWorkspaceTab } from "./workspace-tabs.js";

export async function workspaceTabAction(id, input, options) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw inputError("Choose a tab action.");
  const tab = getWorkspaceTab(id); if (!tab || tab.archivedAt) throw inputError("Tab not found.", 404);
  const requestId = input.requestId || crypto.randomUUID();
  if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(requestId)) throw inputError("Invalid request ID.");
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (["message", "run"].includes(input.action) && (!text || text.length > 16000)) throw inputError("Write a message of up to 16,000 characters.");
  if (input.action === "run" && /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(text)) throw inputError("The reviewed task contains hidden direction controls. Remove them before running it.");
  if (input.action === "stop") {
    const sessionId = input.target === "execution" ? tab.executionSessionId : tab.sessionId;
    const run = currentWorkSessionRun(sessionId);
    return { run: run ? publicAssistantRun(cancelAssistantRun(run.id, sessionId)) : null };
  }
  if (input.action === "publish") return { tab: publishWorkspaceTab(id, input.version) };
  if (input.action === "message") {
    if (tab.phase === "building") throw inputError("Wait for the preview, or stop the build first.", 409);
    const run = await startAssistantRun({ id: requestId, sessionId: tab.sessionId, text, source: "workspace", textOnly: true }, options);
    return { run: publicAssistantRun(run) };
  }
  if (input.action === "plan") {
    if (tab.phase === "building") throw inputError("Wait for the preview, or stop the build first.", 409);
    const details = workspaceTabDetails(id);
    const userTurns = details.messages.filter(message => message.role === "user").length;
    if (userTurns < 2) throw inputError("Discuss the tab with Hermes for at least two turns before preparing its plan.", 409);
    if (workSessionRunIsBusy(currentWorkSessionRun(tab.sessionId))) throw inputError("Wait for Hermes to finish before preparing the plan.", 409);
    const run = await startAssistantRun({ id: requestId, sessionId: tab.sessionId, text: "Prepare the plan for review, including agreed features, connections, boundaries, and checks. Return exactly one fenced panel-plan JSON object with the keys title, outcome, features, connections, boundaries, and checks.", source: "workspace", textOnly: true, workspaceMode: "review" }, options);
    return { run: publicAssistantRun(run) };
  }
  if (input.action === "build") {
    let plan;
    withFileLock(`${workspaceTabPaths(id).config}.build`, () => {
      const details = workspaceTabDetails(id);
      if (details.tab.phase === "building") {
        if (details.tab.buildRunId === requestId) { plan = details.tab.plan; return; }
        throw inputError("A preview is already being built.", 409);
      }
      if (!details.tab.suggestedPlan || input.planDigest !== details.tab.planDigest) throw inputError("Discuss the requirements with Hermes and review its latest plan before building.", 409);
      plan = details.tab.suggestedPlan;
      updateWorkspaceTab(id, { title: plan.title, plan, phase: "building", buildRunId: requestId, buildRunIds: [...(details.tab.buildRunIds || []), requestId].slice(-100), buildPlanDigest: details.tab.planDigest, buildReservedAt: new Date().toISOString(), error: null });
    });
    try {
      const current = getWorkspaceTab(id);
      const run = await startAssistantRun({ id: requestId, sessionId: tab.sessionId, text: "Build the preview from the plan I approved in Panel.", source: "workspace", textOnly: true, workspaceMode: "build", workspacePlanDigest: current?.buildPlanDigest }, options);
      return { run: { ...publicAssistantRun(run), response: "" } };
    } catch (error) { failWorkspaceTabBuild(id, requestId, "The preview could not start. Check Hermes and retry the approved plan."); throw error; }
  }
  if (input.action === "run") {
    if (!tab.publishedVersion && !tab.previewVersion) throw inputError("Create a preview first.", 409);
    // Panel owns this handler and the exact-task review; layout data cannot call APIs.
    const run = await startAssistantRun({ id: requestId, sessionId: tab.executionSessionId, text, source: "workspace", textOnly: true }, options);
    return { run: publicAssistantRun(run) };
  }
  throw inputError("Unknown tab action.");
}

export function changeWorkspaceTab(id, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw inputError("A tab update is required.");
  const tab = getWorkspaceTab(id); if (!tab) throw inputError("Tab not found.", 404);
  const patch = {};
  if (Object.hasOwn(input, "title")) patch.title = input.title;
  if (Object.hasOwn(input, "archived")) {
    if (typeof input.archived !== "boolean") throw inputError("Archived must be true or false.");
    if ([tab.sessionId, tab.executionSessionId].some(sessionId => workSessionRunIsBusy(currentWorkSessionRun(sessionId)))) throw inputError("Stop this tab's work before archiving it.", 409);
    patch.archivedAt = input.archived ? new Date().toISOString() : null;
  }
  return updateWorkspaceTab(id, patch);
}
