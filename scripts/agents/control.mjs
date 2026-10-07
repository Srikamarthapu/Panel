#!/usr/bin/env node
import { listWorkAgents } from "../../lib/work-agents.js";
import { runWorkAgent, workAgentRun } from "../../lib/agent-actions.js";
import { getWorkSession } from "../../lib/work-sessions.js";

let input = "";
try {
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 50000) throw new Error("Agent request is too large."); }
  const args = JSON.parse(input), callerSessionId = process.env.PANEL_WORK_SESSION_ID;
  if (!callerSessionId || !getWorkSession(callerSessionId)) throw new Error("A Panel conversation is required.");
  let result;
  if (args.action === "list") result = { agents: listWorkAgents().filter(agent => agent.sessionId !== callerSessionId).map(({ id, name, description, model, provider, activeRun }) => ({ id, name, description, model, provider, working: Boolean(activeRun) })) };
  else if (args.action === "run") result = await runWorkAgent(args.agent_id, { text: args.task, actionId: args.action_id }, { callerSessionId });
  else if (["status", "stop"].includes(args.action)) result = workAgentRun(args.agent_id, args.run_id, { callerSessionId, stop: args.action === "stop" });
  else throw new Error("Choose list, run, status, or stop.");
  process.stdout.write(JSON.stringify({ ok: true, ...result }) + "\n");
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error.status ? error.message : "Panel could not complete this agent request." }) + "\n");
  process.exitCode = 1;
}
