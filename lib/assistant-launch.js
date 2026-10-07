import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { assistantRunIsExecuting, claimAssistantRun, createAssistantRun, getAssistantRun, getConversationSession, requestFileForRun, updateAssistantRun } from "./assistant-runs.js";
import { getVoiceConfig } from "./voice.js";
import { addVoiceActivity } from "./voiceActivity.js";
import { getWorkSession, recordSessionRun } from "./work-sessions.js";
import { inputError } from "./work-store.js";
import { acpEnabled } from "./hermes-acp-runtime.js";
import { agentForSession } from "./work-agents.js";

const panelRoot = process.env.PANEL_APP_ROOT || process.cwd();
const helper = path.join(panelRoot, "scripts", "voice", "run-hermes-action.mjs");
export async function launchAssistantRun(run, payload, { spawnProcess = spawn } = {}) {
  const claimed = claimAssistantRun(run.id);
  if (!claimed) return getAssistantRun(run.id);
  try {
    fs.writeFileSync(requestFileForRun(run.id), JSON.stringify(payload), { mode: 0o600 });
    await new Promise((resolve, reject) => {
      // Scheduled work retains its existing unattended CLI behavior. ACP's
      // interactive permission requests belong to foreground Talk and Chat.
      const selectedHelper = acpEnabled() && run.source !== "task" ? path.join(panelRoot, "scripts", "voice", "run-hermes-acp-action.mjs") : helper;
      const child = spawnProcess(process.execPath, [selectedHelper, run.id], { cwd: panelRoot, detached: true, stdio: "ignore", env: process.env });
      child.once("error", reject);
      child.once("spawn", () => {
        updateAssistantRun(run.id, { pid: child.pid });
        child.unref(); resolve();
      });
    });
    return getAssistantRun(run.id);
  } catch (error) {
    updateAssistantRun(run.id, { state: "error", executionActive: false, error: "The local assistant could not start this request. Check Panel and Hermes setup." });
    try { fs.unlinkSync(requestFileForRun(run.id)); } catch {}
    throw error;
  }
}
export async function startAssistantRun({ id, sessionId, text, textOnly = true, history = [], source = "chat", parentSessionId }, options) {
  const session = getWorkSession(sessionId);
  if (!session) throw inputError("Session not found. Create or choose a session first.", 404);
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
  const statusLabel = "Thinking through your request…";
  const run = createAssistantRun({ ...(id ? { id } : {}), sessionId, text, textOnly, statusLabel, source, ...(parentSessionId ? { parentSessionId } : {}), ...(agent ? { agentId: agent.id, agentName: agent.name } : {}) });
  const workingDirectory = run.workingDirectory;
  recordSessionRun(run);
  const prior = (getWorkSession(sessionId)?.messages || session.messages).filter(entry => entry.runId !== run.id).filter(entry => !entry.isError).slice(-24).map(entry => ({ role: entry.role === "user" ? "user" : "assistant", content: entry.text }));
  const result = await launchAssistantRun(run, { text, sessionId, textOnly, statusLabel, workingDirectory, provider: agent?.provider || config.voiceModelProvider || "", model: agent?.model || config.voiceModel || "", ...(agent ? { agentId: agent.id, agentName: agent.name, agentSoul: agent.soul } : {}), reasoningEffort: config.voiceReasoningEffort || "", history: prior.length ? prior : history }, options);
  if (result?.state === "queued" || result?.state === "active") addVoiceActivity({ id: run.id, sessionId, kind: "tool", state: "queued", title: statusLabel, source: "voice/action", textOnly });
  return result;
}
