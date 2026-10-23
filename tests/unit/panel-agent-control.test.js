import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const appRoot = process.cwd();

test("the conversation bridge creates an explicit-none profile idempotently and lists it", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "panel-agent-control-"));
  const env = { ...process.env, PANEL_APP_ROOT: appRoot, PANEL_DATA_DIR: directory, HERMES_HOME: path.join(directory, "hermes") };
  const previous = process.env.PANEL_DATA_DIR;
  process.env.PANEL_DATA_DIR = directory;
  try {
    const { createWorkSession } = await import(`../../lib/work-sessions.js?control=${Date.now()}`);
    const inheritedWorkspace = path.join(directory, "caller-workspace");
    fs.mkdirSync(inheritedWorkspace);
    const inheritedWorkspaceReal = fs.realpathSync(inheritedWorkspace);
    const caller = createWorkSession({ name: "Caller", workingDirectory: inheritedWorkspace });
    env.PANEL_WORK_SESSION_ID = caller.id;
    const invoke = request => JSON.parse(execFileSync(process.execPath, [path.join(appRoot, "scripts/agents/control.mjs")], {
      cwd: appRoot, env, input: JSON.stringify(request), encoding: "utf8",
    }));
    const request = { action: "create", name: "Research helper", role: "Trace claims to sources.", idempotency_key: "same-request", tools: [], skills: [] };
    const first = invoke(request);
    const retry = invoke(request);
    const listed = invoke({ action: "list" });
    assert.equal(first.ok, true);
    assert.equal(retry.agent.id, first.agent.id);
    assert.equal(first.agent.workingDirectory, inheritedWorkspaceReal);
    assert.deepEqual(first.agent.capabilityPolicy, { version: 1, tools: { mode: "allow", ids: [] }, skills: { mode: "allow", ids: [] } });
    assert.ok(listed.agents.some(agent => agent.id === first.agent.id && agent.name === "Research helper" && agent.workingDirectory === inheritedWorkspaceReal && JSON.stringify(agent.capabilityPolicy) === JSON.stringify(first.agent.capabilityPolicy)));

    const explicitWorkspace = path.join(directory, "explicit-workspace");
    fs.mkdirSync(explicitWorkspace);
    const explicit = invoke({ ...request, idempotency_key: "explicit-folder", working_directory: explicitWorkspace });
    assert.equal(explicit.agent.workingDirectory, fs.realpathSync(explicitWorkspace));

    const malformedConfig = path.join(directory, "agents", explicit.agent.id, "agent.json");
    const malformed = JSON.parse(fs.readFileSync(malformedConfig, "utf8"));
    malformed.capabilityPolicy = { version: 1, tools: { mode: "allow", ids: ["bad/id"] }, skills: { mode: "allow", ids: [] } };
    fs.writeFileSync(malformedConfig, `${JSON.stringify(malformed, null, 2)}\n`);
    const listedMalformed = invoke({ action: "list" }).agents.find(agent => agent.id === explicit.agent.id);
    assert.equal(listedMalformed.capabilityPolicyUnavailable, true);
    assert.deepEqual(listedMalformed.capabilityPolicy, { version: 1, tools: { mode: "allow", ids: [] }, skills: { mode: "allow", ids: [] } });

    const missing = path.join(directory, "missing-workspace");
    const rejected = spawnSync(process.execPath, [path.join(appRoot, "scripts/agents/control.mjs")], {
      cwd: appRoot, env, input: JSON.stringify({ ...request, idempotency_key: "missing-folder", working_directory: missing }), encoding: "utf8",
    });
    const failed = JSON.parse(rejected.stdout);
    assert.equal(rejected.status, 1);
    assert.equal(failed.ok, false);
    assert.match(failed.error, /does not exist|not a directory/i);
  } finally {
    if (previous === undefined) delete process.env.PANEL_DATA_DIR;
    else process.env.PANEL_DATA_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("saved-agent status waits for terminal state and times out honestly without automatic delivery", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "panel-agent-status-wait-"));
  const env = { ...process.env, PANEL_DATA_DIR: directory, HERMES_HOME: path.join(directory, "hermes") };
  const program = `
    const { createWorkSession } = await import('./lib/work-sessions.js');
    const { createWorkAgent } = await import('./lib/work-agents.js');
    const { createAssistantRun, updateAssistantRun } = await import('./lib/assistant-runs.js');
    const { waitForWorkAgentRun } = await import('./lib/agent-actions.js');
    const caller = createWorkSession({ name: 'Caller' });
    const foreign = createWorkSession({ name: 'Foreign' });
    const agent = createWorkAgent({ id: 'status-reader', name: 'Reader', soul: 'Read.' });
    createAssistantRun({ id: 'terminal-run', sessionId: agent.sessionId, text: 'finish', source: 'agent', parentSessionId: caller.id });
    updateAssistantRun('terminal-run', { state: 'active', executionActive: true });
    setTimeout(() => updateAssistantRun('terminal-run', { state: 'complete', executionActive: false, response: 'done' }), 40);
    const completed = await waitForWorkAgentRun(agent.id, 'terminal-run', { callerSessionId: caller.id, waitMs: 500, pollMs: 10 });
    createAssistantRun({ id: 'active-run', sessionId: agent.sessionId, text: 'wait', source: 'agent', parentSessionId: caller.id });
    updateAssistantRun('active-run', { state: 'active', executionActive: true });
    const active = await waitForWorkAgentRun(agent.id, 'active-run', { callerSessionId: caller.id, waitMs: 30, pollMs: 10 });
    let foreignStatus = 0;
    try { await waitForWorkAgentRun(agent.id, 'active-run', { callerSessionId: foreign.id, waitMs: 30, pollMs: 10 }); }
    catch (error) { foreignStatus = error.status; }
    setTimeout(() => updateAssistantRun('active-run', { state: 'cancelled', executionActive: false }), 20);
    const cancelled = await waitForWorkAgentRun(agent.id, 'active-run', { callerSessionId: caller.id, waitMs: 500, pollMs: 10 });
    console.log(JSON.stringify({ completed, active, cancelled, foreignStatus }));
  `;
  try {
    const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", program], { cwd: appRoot, env, encoding: "utf8" }));
    assert.equal(result.completed.run.state, "complete");
    assert.equal(result.completed.statusWait.terminal, true);
    assert.equal(result.completed.statusWait.timedOut, false);
    assert.equal(result.completed.statusWait.automaticDelivery, false);
    assert.equal(result.active.run.state, "active");
    assert.equal(result.active.statusWait.terminal, false);
    assert.equal(result.active.statusWait.timedOut, true);
    assert.equal(result.active.statusWait.automaticDelivery, false);
    assert.match(result.active.statusWait.observedAt, /^\d{4}-\d\d-\d\dT/);
    assert.equal(result.cancelled.run.state, "cancelled");
    assert.equal(result.cancelled.statusWait.terminal, true);
    assert.equal(result.foreignStatus, 404);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
