import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

const appRoot = process.cwd();
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "panel-work-agents-"));
const store = path.join(temporary, "store");
process.env.PANEL_DATA_DIR = store;
process.env.PANEL_APP_ROOT = appRoot;
process.env.HERMES_HOME = path.join(temporary, "empty-hermes-home");
process.env.HERMES_VOICE_TRANSPORT = "legacy";

const agents = await import("../../lib/work-agents.js");
const actions = await import("../../lib/agent-actions.js");
const sessions = await import("../../lib/work-sessions.js");
const runs = await import("../../lib/assistant-runs.js");
const { requestFileForRun } = await import("../../lib/assistant-runs.js");

const reset = () => fs.rmSync(store, { recursive: true, force: true });
const statusIs = status => error => error?.status === status;
function fakeSpawner() {
  const calls = [];
  const spawnProcess = (command, args, options) => {
    const child = new EventEmitter();
    child.pid = process.pid;
    child.unref = () => {};
    calls.push({ command, args, options });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
  return { calls, spawnProcess };
}

test.beforeEach(reset);
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

test("two profiles keep separate SOUL.md files, workspaces, sessions, and model selections", () => {
  const first = agents.createWorkAgent({
    id: "researcher",
    name: "Researcher",
    soul: "# Researcher\n\nTrace claims to sources.",
    provider: "provider-a",
    model: "model-a",
  });
  const second = agents.createWorkAgent({
    id: "builder",
    name: "Builder",
    soul: "# Builder\n\nMake small, verified changes.",
    provider: "provider-b",
    model: "model-b",
  });

  assert.notEqual(first.sessionId, second.sessionId);
  assert.notEqual(first.workingDirectory, second.workingDirectory);
  assert.notEqual(first.soulPath, second.soulPath);
  assert.equal(first.workingDirectory, path.join(store, "agents", first.id, "workspace"));
  assert.equal(second.workingDirectory, path.join(store, "agents", second.id, "workspace"));
  assert.ok(fs.statSync(first.workingDirectory).isDirectory());
  assert.ok(fs.statSync(second.workingDirectory).isDirectory());
  assert.equal(fs.readFileSync(first.soulPath, "utf8"), first.soul);
  assert.equal(fs.readFileSync(second.soulPath, "utf8"), second.soul);
  assert.deepEqual([first.provider, first.model], ["provider-a", "model-a"]);
  assert.deepEqual([second.provider, second.model], ["provider-b", "model-b"]);
  assert.equal(sessions.getWorkSession(first.sessionId).agentId, first.id);
  assert.equal(sessions.getWorkSession(second.sessionId).agentId, second.id);
  assert.equal(agents.getWorkAgent(first.id).soul, first.soul);
  assert.equal(agents.getWorkAgent(second.id).soul, second.soul);
});

test("repeating a profile creation ID returns the original profile and native session", () => {
  const first = agents.createWorkAgent({
    id: "retryable-profile",
    name: "First name",
    soul: "Keep the accepted profile.",
    provider: "provider-a",
    model: "model-a",
  });
  const retry = agents.createWorkAgent({
    id: "retryable-profile",
    name: "Retry payload name",
    soul: "Do not replace the accepted profile.",
    provider: "provider-b",
    model: "model-b",
  });

  assert.equal(retry.id, first.id);
  assert.equal(retry.sessionId, first.sessionId);
  assert.equal(retry.createdAt, first.createdAt);
  assert.equal(retry.workingDirectory, first.workingDirectory);
  assert.equal(retry.soul, first.soul);
  assert.deepEqual([retry.provider, retry.model], [first.provider, first.model]);
  assert.equal(agents.listWorkAgents({ includeArchived: true }).length, 1);
  assert.equal(sessions.listWorkSessions().length, 1);
});

test("profile edits are blocked while its native session has queued or running work", () => {
  const agent = agents.createWorkAgent({ id: "busy-profile", name: "Busy", soul: "Keep the original." });
  const run = runs.createAssistantRun({ id: "busy-profile-run", sessionId: agent.sessionId, text: "Do the current task." });
  assert.equal(run.state, "queued");

  assert.throws(
    () => agents.updateWorkAgent(agent.id, { name: "Changed", soul: "Replace the profile." }),
    statusIs(409),
  );
  assert.equal(agents.getWorkAgent(agent.id).name, "Busy");
  assert.equal(agents.getWorkAgent(agent.id).soul, "Keep the original.");
  runs.cancelAssistantRun(run.id, agent.sessionId);
  assert.equal(agents.updateWorkAgent(agent.id, { name: "Changed" }).name, "Changed");
});

test("archiving and reopening a profile preserves its session, workspace, model, and SOUL.md", async () => {
  const agent = agents.createWorkAgent({
    id: "archive-profile",
    name: "Archive me",
    soul: "Persistent personality.",
    provider: "provider-a",
    model: "model-a",
  });
  const session = sessions.getWorkSession(agent.sessionId);
  const archived = agents.updateWorkAgent(agent.id, { archived: true });

  assert.ok(archived.archivedAt);
  assert.ok(sessions.getWorkSession(agent.sessionId).archivedAt);
  assert.equal(agents.listWorkAgents().some(item => item.id === agent.id), false);
  assert.equal(agents.listWorkAgents({ includeArchived: true }).some(item => item.id === agent.id), true);
  assert.throws(() => agents.agentForSession(session), statusIs(409));
  await assert.rejects(
    actions.runWorkAgent(agent.id, { text: "Do not start while archived." }),
    statusIs(404),
  );

  const reopened = agents.updateWorkAgent(agent.id, { archived: false });
  assert.equal(reopened.archivedAt, null);
  assert.equal(reopened.sessionId, agent.sessionId);
  assert.equal(reopened.workingDirectory, agent.workingDirectory);
  assert.equal(reopened.soul, agent.soul);
  assert.deepEqual([reopened.provider, reopened.model], [agent.provider, agent.model]);
  assert.equal(sessions.getWorkSession(agent.sessionId).archivedAt, null);
  assert.equal(agents.agentForSession(sessions.getWorkSession(agent.sessionId)).id, agent.id);
});

test("missing work folders are rejected and stale sessions fail closed when a profile folder is gone", () => {
  const missing = path.join(temporary, "does-not-exist");
  assert.throws(
    () => agents.createWorkAgent({ id: "bad-folder", name: "Bad folder", workingDirectory: missing }),
    /working folder does not exist/i,
  );
  assert.equal(agents.getWorkAgent("bad-folder"), null);

  const agent = agents.createWorkAgent({ id: "removed-folder", name: "Removed" });
  const session = sessions.getWorkSession(agent.sessionId);
  fs.rmSync(path.join(store, "agents", agent.id), { recursive: true, force: true });
  assert.equal(agents.getWorkAgent(agent.id), null);
  assert.throws(() => agents.agentForSession(session), statusIs(409));
  assert.deepEqual(agents.listWorkAgents(), []);
});

test("agent runs receive profile provider, model, workspace, and SOUL.md read from disk", async () => {
  const first = agents.createWorkAgent({
    id: "profile-run-a",
    name: "Runner A",
    soul: "A real profile file for runner A.",
    provider: "provider-a",
    model: "model-a",
  });
  const second = agents.createWorkAgent({
    id: "profile-run-b",
    name: "Runner B",
    soul: "A different profile file for runner B.",
    provider: "provider-b",
    model: "model-b",
  });
  const caller = sessions.createWorkSession({ name: "Calling conversation" });
  const spawner = fakeSpawner();

  for (const [agent, actionId, text] of [[first, "profile-run-action-a", "Run A"], [second, "profile-run-action-b", "Run B"]]) {
    await actions.runWorkAgent(agent.id, { actionId, text }, {
      callerSessionId: caller.id,
      spawnProcess: spawner.spawnProcess,
    });
    const payload = JSON.parse(fs.readFileSync(requestFileForRun(actionId), "utf8"));
    assert.equal(payload.sessionId, agent.sessionId);
    assert.equal(payload.agentId, agent.id);
    assert.equal(payload.agentName, agent.name);
    assert.equal(payload.agentSoul, fs.readFileSync(agent.soulPath, "utf8"));
    assert.equal(fs.realpathSync(payload.workingDirectory), fs.realpathSync(agent.workingDirectory));
    assert.equal(payload.provider, agent.provider);
    assert.equal(payload.model, agent.model);
    assert.equal(payload.text, text);
    assert.equal(payload.textOnly, true);
    assert.equal(runs.getAssistantRun(actionId, agent.sessionId).parentSessionId, caller.id);
  }

  assert.equal(spawner.calls.length, 2);
  assert.ok(spawner.calls.every(call => path.basename(call.args[0]) === "run-hermes-action.mjs"));
  assert.notEqual(first.provider, second.provider);
  assert.notEqual(first.model, second.model);
  assert.notEqual(first.sessionId, second.sessionId);
});

test("caller sessions cannot inspect or stop another session's delegated agent run", async () => {
  const agent = agents.createWorkAgent({ id: "child-agent", name: "Child agent" });
  const caller = sessions.createWorkSession({ name: "Caller" });
  const other = sessions.createWorkSession({ name: "Different caller" });
  const { spawnProcess } = fakeSpawner();
  const accepted = await actions.runWorkAgent(
    agent.id,
    { actionId: "delegated-run", text: "Carry out the child task." },
    { callerSessionId: caller.id, spawnProcess },
  );

  assert.equal(runs.getAssistantRun(accepted.run.id, agent.sessionId).parentSessionId, caller.id);
  assert.throws(() => actions.workAgentRun(agent.id, accepted.run.id, { callerSessionId: other.id }), statusIs(404));
  assert.throws(() => actions.workAgentRun(agent.id, accepted.run.id, { callerSessionId: other.id, stop: true }), statusIs(404));
  assert.equal(actions.workAgentRun(agent.id, accepted.run.id, { callerSessionId: caller.id }).run.id, accepted.run.id);
  assert.equal(actions.workAgentRun(agent.id, accepted.run.id, { callerSessionId: caller.id, stop: true }).run.state, "cancelled");
  assert.throws(() => actions.workAgentRun("different-agent", accepted.run.id, { callerSessionId: caller.id }), statusIs(404));
});

test("profile metadata ignores supplied credentials and never stores or returns them", () => {
  const secret = "sk-" + "a".repeat(32);
  const agent = agents.createWorkAgent({
    id: "credential-free",
    name: "Credential free",
    soul: "Use credentials only through the configured provider.",
    provider: "provider-a",
    model: "model-a",
    apiKey: secret,
    accessToken: secret,
    credentials: { token: secret },
  });
  const configPath = path.join(store, "agents", agent.id, "agent.json");
  const stored = fs.readFileSync(configPath, "utf8");
  const publicProfile = agents.publicWorkAgent(agents.getWorkAgent(agent.id), { includeSoul: true });

  assert.equal(stored.includes(secret), false);
  assert.equal(JSON.stringify(publicProfile).includes(secret), false);
  assert.equal(Object.hasOwn(JSON.parse(stored), "apiKey"), false);
  assert.equal(Object.hasOwn(JSON.parse(stored), "accessToken"), false);
  assert.equal(Object.hasOwn(JSON.parse(stored), "credentials"), false);
  assert.equal(publicProfile.provider, "provider-a");
  assert.equal(publicProfile.model, "model-a");
});

test("profile colors are allowlisted and existing profiles migrate to sage", () => {
  const colored = agents.createWorkAgent({ id: "blue-agent", name: "Blue agent", color: "blue" });
  assert.equal(colored.color, "blue");
  assert.equal(agents.publicWorkAgent(agents.getWorkAgent(colored.id)).color, "blue");
  assert.throws(() => agents.createWorkAgent({ id: "css-agent", name: "CSS agent", color: "url(javascript:alert(1))" }), /supported agent color/i);
  assert.throws(() => agents.updateWorkAgent(colored.id, { color: "#ffffff" }), /supported agent color/i);

  const configPath = path.join(store, "agents", colored.id, "agent.json");
  const legacy = JSON.parse(fs.readFileSync(configPath, "utf8"));
  delete legacy.color;
  fs.writeFileSync(configPath, JSON.stringify(legacy));
  assert.equal(agents.getWorkAgent(colored.id).color, "sage");
});

test("public profile metadata exposes only the real storage, workspace, and SOUL paths", () => {
  const agent = agents.createWorkAgent({ id: "paths-agent", name: "Paths agent", color: "peach" });
  const publicProfile = agents.publicWorkAgent(agents.getWorkAgent(agent.id), { includeSoul: true });
  assert.equal(publicProfile.storagePath, path.join(store, "agents", agent.id));
  assert.equal(publicProfile.workspacePath, agent.workingDirectory);
  assert.equal(publicProfile.soulPath, path.join(store, "agents", agent.id, "SOUL.md"));
  assert.equal(publicProfile.configPath, path.join(store, "agents", agent.id, "agent.json"));
  assert.equal(fs.readFileSync(publicProfile.soulPath, "utf8").trim(), publicProfile.soul);
});
