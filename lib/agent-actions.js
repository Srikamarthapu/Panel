import { getWorkAgent } from "./work-agents.js";
import { startAssistantRun } from "./assistant-launch.js";
import { cancelAssistantRun, getAssistantRun, publicAssistantRun } from "./assistant-runs.js";
import { getWorkSession } from "./work-sessions.js";
import { inputError } from "./work-store.js";
import { MAX_USER_TEXT } from "./conversation-limits.js";

export async function runWorkAgent(id, input, { callerSessionId, ...options } = {}) {
  const agent = getWorkAgent(id);
  if (!agent || agent.archivedAt) throw inputError("Agent not found.", 404);
  if (callerSessionId && !getWorkSession(callerSessionId)) throw inputError("Calling conversation not found.", 404);
  if (callerSessionId === agent.sessionId) throw inputError("This agent cannot delegate a task to itself.", 409);
  if (typeof input?.text !== "string" || !input.text.trim() || input.text.length > MAX_USER_TEXT) throw inputError(`Give the agent a task of 1–${MAX_USER_TEXT} characters.`);
  const run = await startAssistantRun({ id: input.actionId, sessionId: agent.sessionId, text: input.text.trim(), textOnly: true, source: "agent", ...(callerSessionId ? { parentSessionId: callerSessionId } : {}) }, options);
  return { agentId: agent.id, sessionId: agent.sessionId, run: publicAssistantRun(run) };
}
export function workAgentRun(id, runId, { callerSessionId, stop = false } = {}) {
  const agent = getWorkAgent(id);
  if (!agent) throw inputError("Agent not found.", 404);
  const run = getAssistantRun(runId, agent.sessionId);
  if (!run || (callerSessionId && run.parentSessionId !== callerSessionId)) throw inputError("This request does not belong to this delegation.", 404);
  return { agentId: agent.id, sessionId: agent.sessionId, run: publicAssistantRun(stop ? cancelAssistantRun(run.id, agent.sessionId) : run) };
}
