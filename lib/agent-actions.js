import { ensureWorkAgentSession, getWorkAgent } from "./work-agents.js";
import { startAssistantRun } from "./assistant-launch.js";
import { cancelAssistantRun, getAssistantRun, publicAssistantRun } from "./assistant-runs.js";
import { getWorkSession } from "./work-sessions.js";
import { inputError } from "./work-store.js";
import { MAX_USER_TEXT } from "./conversation-limits.js";

export async function runWorkAgent(id, input, { callerSessionId, ...options } = {}) {
  let agent = getWorkAgent(id);
  if (!agent || agent.archivedAt) throw inputError("Agent not found.", 404);
  if (agent.capabilityPolicyError) throw inputError(agent.capabilityPolicyError, 409);
  const caller = callerSessionId ? getWorkSession(callerSessionId) : null;
  if (callerSessionId && !caller) throw inputError("Calling conversation not found.", 404);
  if (callerSessionId && (callerSessionId === agent.sessionId || caller?.agentId === agent.id)) throw inputError("This agent cannot delegate a task to itself.", 409);
  if (typeof input?.text !== "string" || !input.text.trim() || input.text.length > MAX_USER_TEXT) throw inputError(`Give the agent a task of 1–${MAX_USER_TEXT} characters.`);
  const text = input.text.trim();
  if (input.actionId) {
    const existing = getAssistantRun(input.actionId);
    if (existing) {
      const existingSession = getWorkSession(existing.sessionId);
      const sameCaller = (existing.parentSessionId || null) === (callerSessionId || null);
      const sameAgent = existingSession?.agentId === agent.id && (!existing.agentId || existing.agentId === agent.id);
      if (!sameAgent || existing.source !== "agent" || existing.text !== text || !sameCaller) throw inputError("This action ID belongs to another request.", 409);
      return { agentId: agent.id, sessionId: existing.sessionId, run: publicAssistantRun(existing) };
    }
  }
  agent = ensureWorkAgentSession(id);
  const launch = () => startAssistantRun({ id: input.actionId, sessionId: agent.sessionId, text, textOnly: true, source: "agent", ...(callerSessionId ? { parentSessionId: callerSessionId } : {}) }, options);
  let run;
  try { run = await launch(); }
  catch (error) {
    if (error?.status !== 409 || !getWorkSession(agent.sessionId)?.archivedAt) throw error;
    agent = ensureWorkAgentSession(id);
    run = await launch();
  }
  return { agentId: agent.id, sessionId: agent.sessionId, run: publicAssistantRun(run) };
}
export function workAgentRun(id, runId, { callerSessionId, stop = false } = {}) {
  const agent = getWorkAgent(id);
  if (!agent) throw inputError("Agent not found.", 404);
  const run = getAssistantRun(runId);
  const runSession = run ? getWorkSession(run.sessionId) : null;
  const owned = runSession?.agentId === agent.id && (!run.agentId || run.agentId === agent.id);
  if (!owned || (callerSessionId && run.parentSessionId !== callerSessionId)) throw inputError("This request does not belong to this delegation.", 404);
  return { agentId: agent.id, sessionId: run.sessionId, run: publicAssistantRun(stop ? cancelAssistantRun(run.id, run.sessionId) : run) };
}

const terminalAgentRunStates = new Set(["complete", "error", "cancelled", "interrupted"]);
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function waitForWorkAgentRun(id, runId, { callerSessionId, waitMs = 12_000, pollMs = 200 } = {}) {
  const boundedWaitMs = Math.max(0, Math.min(12_000, Number(waitMs) || 0));
  const boundedPollMs = Math.max(20, Math.min(1_000, Number(pollMs) || 200));
  const started = Date.now();
  let result = workAgentRun(id, runId, { callerSessionId });
  while (
    Date.now() - started < boundedWaitMs
    && (!terminalAgentRunStates.has(result.run.state) || result.run.executionActive === true)
  ) {
    await wait(Math.min(boundedPollMs, Math.max(1, boundedWaitMs - (Date.now() - started))));
    result = workAgentRun(id, runId, { callerSessionId });
  }
  const terminal = terminalAgentRunStates.has(result.run.state) && result.run.executionActive !== true;
  return {
    ...result,
    statusWait: {
      terminal,
      timedOut: !terminal,
      waitedMs: Math.max(0, Date.now() - started),
      observedAt: new Date().toISOString(),
      automaticDelivery: false,
    },
  };
}
