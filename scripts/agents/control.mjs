#!/usr/bin/env node
import crypto from "node:crypto";
import { createWorkAgent, listWorkAgents, publicWorkAgent } from "../../lib/work-agents.js";
import { runWorkAgent, waitForWorkAgentRun, workAgentRun } from "../../lib/agent-actions.js";
import { getWorkSession } from "../../lib/work-sessions.js";

let input = "";
try {
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 50000) throw new Error("Agent request is too large."); }
  const args = JSON.parse(input), callerSessionId = process.env.PANEL_WORK_SESSION_ID;
  const callerSession = callerSessionId ? getWorkSession(callerSessionId) : null;
  if (!callerSession) throw new Error("A Panel conversation is required.");
  let result;
  if (args.action === "list") result = { agents: listWorkAgents().filter(agent => agent.sessionId !== callerSessionId).map(({ id, name, description, model, provider, workingDirectory, activeRun, capabilityPolicy, capabilityPolicyError }) => ({ id, name, description, model, provider, workingDirectory, working: Boolean(activeRun), capabilityPolicy, capabilityPolicyUnavailable: Boolean(capabilityPolicyError) })) };
  else if (args.action === "create") {
    const id = `created-${crypto.createHash("sha256").update(args.idempotency_key).digest("hex").slice(0, 32)}`;
    const capabilityPolicy = { version: 1, tools: { mode: "allow", ids: args.tools || [] }, skills: { mode: "allow", ids: args.skills || [] } };
    const workingDirectory = args.working_directory === undefined ? callerSession.workingDirectory : args.working_directory;
    const agent = publicWorkAgent(createWorkAgent({ id, name: args.name, soul: args.role, capabilityPolicy, ...(workingDirectory ? { workingDirectory } : {}) }), { includeSoul: false });
    result = { agent: { id: agent.id, name: agent.name, description: agent.description, workingDirectory: agent.workingDirectory, sessionId: agent.sessionId, capabilityPolicy: agent.capabilityPolicy } };
  }
  else if (args.action === "run") result = await runWorkAgent(args.agent_id, { text: args.task, actionId: args.action_id }, { callerSessionId });
  else if (args.action === "status") result = await waitForWorkAgentRun(args.agent_id, args.run_id, { callerSessionId });
  else if (args.action === "stop") result = workAgentRun(args.agent_id, args.run_id, { callerSessionId, stop: true });
  else throw new Error("Choose list, create, run, status, or stop.");
  process.stdout.write(JSON.stringify({ ok: true, ...result }) + "\n");
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error.status ? error.message : "Panel could not complete this agent request." }) + "\n");
  process.exitCode = 1;
}
