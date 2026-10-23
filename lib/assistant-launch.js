import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { assistantRunIsExecuting, claimAssistantRun, createAssistantRun, getAssistantRun, getConversationSession, prepareConversationRuntime, requestFileForRun, updateAssistantRun } from "./assistant-runs.js";
import { getDirectConfig, resolveDirectConnection } from "./direct-config.js";
import { directCredentialFingerprint } from "./direct-provider.js";
import { getVoiceConfig } from "./voice.js";
import { inferModelSurface, resolveModelFor } from "./model-resolver.js";
import { addVoiceActivity } from "./voiceActivity.js";
import { getWorkSession, recordSessionRun } from "./work-sessions.js";
import { inputError, processIdentity } from "./work-store.js";
import { acpEnabled } from "./hermes-acp-runtime.js";
import { agentForSession } from "./work-agents.js";
import { getWorkspaceTab } from "./workspace-tabs.js";
import { workspaceTurnInstructions } from "./workspace-tab-contract.js";

const panelRoot = process.env.PANEL_APP_ROOT || process.cwd();
const helper = path.join(panelRoot, "scripts", "voice", "run-hermes-action.mjs");
const directHelper = path.join(panelRoot, "scripts", "voice", "run-direct-action.mjs");
export async function launchAssistantRun(run, payload, { spawnProcess = spawn, identifyProcess = processIdentity } = {}) {
  const claimed = claimAssistantRun(run.id);
  if (!claimed) return getAssistantRun(run.id);
  try {
    fs.writeFileSync(requestFileForRun(run.id), JSON.stringify(payload), { mode: 0o600 });
    await new Promise((resolve, reject) => {
      // Scheduled work retains its existing unattended CLI behavior. ACP's
      // interactive permission requests belong to foreground Talk and Chat.
      const selectedHelper = run.executionMode === "direct" ? directHelper : acpEnabled() && run.source !== "task" ? path.join(panelRoot, "scripts", "voice", "run-hermes-acp-action.mjs") : helper;
      const child = spawnProcess(process.execPath, [selectedHelper, run.id], { cwd: panelRoot, detached: true, stdio: "ignore", env: process.env });
      child.once("error", reject);
      child.once("spawn", () => {
        const pidIdentity = identifyProcess(child.pid);
        if (!pidIdentity) {
          try { child.kill("SIGTERM"); } catch {}
          const error = new Error("Panel could not verify ownership of the assistant process. Restart Panel and try again.");
          error.code = "PROCESS_IDENTITY_UNAVAILABLE";
          reject(error);
          return;
        }
        updateAssistantRun(run.id, { pid: child.pid, pidIdentity });
        child.unref(); resolve();
      });
    });
    return getAssistantRun(run.id);
  } catch (error) {
    updateAssistantRun(run.id, { state: "error", executionActive: false, error: error?.code === "PROCESS_IDENTITY_UNAVAILABLE" ? error.message : run.executionMode === "direct" ? "The direct provider request could not start. Check Settings and try again." : "The local assistant could not start this request. Check Panel and Hermes setup." });
    try { fs.unlinkSync(requestFileForRun(run.id)); } catch {}
    throw error;
  }
}
export async function startAssistantRun({ id, sessionId, text, textOnly = true, surface, history = [], source = "chat", parentSessionId, workspaceMode = "plan", workspacePlanDigest }, options) {
  const session = getWorkSession(sessionId);
  if (!session) throw inputError("Session not found. Create or choose a session first.", 404);
  if (id) {
    const accepted = getAssistantRun(id);
    if (accepted) {
      if (accepted.sessionId !== sessionId) throw inputError("Request ID belongs to another conversation.", 409);
      return accepted;
    }
  }
  const directConfig = getDirectConfig();
  const executionMode = directConfig.executionMode;
  const workspace = session.workspaceRole === "planner" ? getWorkspaceTab(session.workspaceTabId) : null;
  if (session.workspaceRole === "planner" && (!workspace || workspace.archivedAt)) throw inputError("This tab is unavailable.", 409);
  if (workspace && executionMode === "direct") throw inputError("Workspace tab planning uses Hermes tools. Switch to Hermes mode or continue in a regular direct conversation.", 409);
  if (workspace && (!acpEnabled() || source === "task")) throw inputError("Tab planning needs the persistent Hermes runtime. Start Panel with its default ACP configuration.", 409);
  if (workspaceMode === "build" && workspace && (!workspace.plan || workspace.buildRunId !== id || !workspacePlanDigest || workspace.buildPlanDigest !== workspacePlanDigest)) throw inputError("Review and approve the current tab plan before building.", 409);
  // A completed native turn receipt can precede the CLI's short notification
  // linger. Let a quick follow-up wait for that process to finish, while active
  // unfinished work still returns the normal immediate conflict.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const previousId = getConversationSession(sessionId).activeRunId;
    const previous = previousId ? getAssistantRun(previousId, sessionId) : null;
    if (!previous || !["complete", "error", "cancelled", "interrupted"].includes(previous.state) || !assistantRunIsExecuting(previous)) break;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  const config = getVoiceConfig();
  const agent = agentForSession(session);
  const modelSurface = inferModelSurface({ surface, source, textOnly });
  const modelResolution = resolveModelFor({ surface: modelSurface, agent, directConfig, voiceConfig: config });
  if (executionMode === "hermes" && agent?.capabilityPolicy != null && (!acpEnabled() || source === "task")) {
    const error = inputError("This teammate's capability policy requires the persistent Hermes runtime, which is unavailable for scheduled or legacy launches. Use foreground Chat with ACP enabled, or switch to Direct API for tool-free conversation.", 409);
    error.code = "AGENT_POLICY_TRANSPORT_UNSUPPORTED";
    throw error;
  }
  const statusLabel = "Thinking through your request…";
  let requestedProvider = modelResolution.requestedProvider;
  let requestedModel = modelResolution.requestedModel;
  let acceptedCredentialFingerprint = "";
  if (executionMode === "direct") {
    const connection = resolveDirectConnection(modelResolution.origin === "agent" ? { provider: requestedProvider, model: requestedModel } : {});
    requestedProvider = connection.provider.id;
    requestedModel = connection.model;
    acceptedCredentialFingerprint = directCredentialFingerprint(connection.apiKey);
  }
  const run = createAssistantRun({ ...(id ? { id } : {}), sessionId, text, textOnly, statusLabel, source, surface: modelSurface, executionMode, requestedProvider, requestedModel, modelOrigin: modelResolution.origin, ...(workspace ? { workspaceMode } : {}), ...(parentSessionId ? { parentSessionId } : {}), ...(agent ? { agentId: agent.id, agentName: agent.name } : {}) });
  const workingDirectory = run.workingDirectory;
  recordSessionRun(run);
  const prior = (getWorkSession(sessionId)?.messages || session.messages).filter(entry => entry.runId !== run.id).filter(entry => !entry.isError).slice(-24).map(entry => ({ role: entry.role === "user" ? "user" : "assistant", content: entry.text }));
  const runtimeState = prepareConversationRuntime(sessionId, run.executionMode);
  const result = await launchAssistantRun(run, { text, sessionId, textOnly, surface: modelSurface, statusLabel, workingDirectory, provider: requestedProvider, model: requestedModel, ...(acceptedCredentialFingerprint ? { credentialFingerprint: acceptedCredentialFingerprint } : {}), runtimeGeneration: runtimeState?.runtimeGeneration || 1, ...(agent ? { agentId: agent.id, agentName: agent.name, agentSoul: agent.soul, ...(agent.capabilityPolicy ? { agentPolicy: agent.capabilityPolicy } : {}) } : {}), ...(workspace ? { disableTools: true, workspaceInstructions: workspaceTurnInstructions({ mode: workspaceMode, plan: workspace.plan }) } : {}), reasoningEffort: modelResolution.reasoningEffort, history: prior.length ? prior : history }, options);
  if (result?.state === "queued" || result?.state === "active") addVoiceActivity({ id: run.id, sessionId, kind: "tool", state: "queued", title: statusLabel, source: "voice/action", textOnly });
  return result;
}
