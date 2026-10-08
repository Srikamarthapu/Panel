import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "panel-agent-session-route-"));
process.env.PANEL_DATA_DIR = path.join(temporary, "store");
process.env.HERMES_HOME = path.join(temporary, "empty-hermes-home");
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier.startsWith("@/") ? pathToFileURL(path.resolve(specifier.slice(2))).href : specifier, context);
} });
const agents = await import("../../lib/work-agents.js");
const runs = await import("../../lib/assistant-runs.js");
const sessions = await import("../../lib/work-sessions.js");
const route = await import("../../app/api/agents/[id]/session/route.js");
const runRoute = await import("../../app/api/agents/[id]/runs/route.js");
const sessionRoute = await import("../../app/api/sessions/[id]/route.js");
hooks.deregister();

test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

test("agent conversation endpoint replaces an archived conversation without changing the profile", async () => {
  const agent = agents.createWorkAgent({ id: "open-agent", name: "Open agent", soul: "Keep me." });
  sessions.updateWorkSession(agent.sessionId, { archived: true });
  const response = await route.POST(new Request("http://panel/api/agents/open-agent/session", { method: "POST" }), { params: Promise.resolve({ id: agent.id }) });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.notEqual(body.session.id, agent.sessionId);
  assert.equal(body.session.agentId, agent.id);
  assert.equal(body.session.archivedAt, null);
  assert.equal(body.agent.sessionId, body.session.id);
  assert.equal(body.agent.soul, undefined);
  assert.equal(body.agent.stats.runs.total, 0);
  assert.ok(sessions.getWorkSession(agent.sessionId).archivedAt);
  assert.equal(agents.getWorkAgent(agent.id).soul, agent.soul);
});

test("agent conversation endpoint preserves explicit profile archives", async () => {
  const agent = agents.createWorkAgent({ id: "archived-agent", name: "Archived agent" });
  agents.updateWorkAgent(agent.id, { archived: true });
  const response = await route.POST(new Request("http://panel/api/agents/archived-agent/session", { method: "POST" }), { params: Promise.resolve({ id: agent.id }) });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /restore this agent profile/i);
  assert.equal(agents.getWorkAgent(agent.id).sessionId, agent.sessionId);
});

test("session API syncs current agent display metadata without coupling pin or archive state", async () => {
  const folder = fs.mkdtempSync(path.join(temporary, "agent-folder-"));
  const agent = agents.createWorkAgent({ id: "metadata-agent", name: "Before metadata" });
  const response = await sessionRoute.PATCH(new Request(`http://panel/api/sessions/${agent.sessionId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "After metadata", workingDirectory: folder, pinned: true }),
  }), { params: Promise.resolve({ id: agent.sessionId }) });

  assert.equal(response.status, 200);
  assert.equal(agents.getWorkAgent(agent.id).name, "After metadata");
  assert.equal(agents.getWorkAgent(agent.id).workingDirectory, fs.realpathSync(folder));
  assert.equal(sessions.getWorkSession(agent.sessionId).name, "After metadata");
  assert.equal(sessions.getWorkSession(agent.sessionId).pinned, true);
  assert.equal(agents.getWorkAgent(agent.id).archivedAt, null);
});

test("session API archives only the conversation and idempotent agent retries keep the original run", async () => {
  const agent = agents.createWorkAgent({ id: "route-lifecycle-agent", name: "Route lifecycle", soul: "Preserve this identity." });
  const oldSessionId = agent.sessionId;
  const original = runs.createAssistantRun({
    id: "accepted-before-session-replacement",
    sessionId: oldSessionId,
    text: "Keep this accepted task.",
    textOnly: true,
    source: "agent",
    agentId: agent.id,
    agentName: agent.name,
  });
  runs.updateAssistantRun(original.id, { state: "complete", response: "Original result." });
  const oldMessages = sessions.getWorkSession(oldSessionId).messages;

  const archivedResponse = await sessionRoute.PATCH(new Request(`http://panel/api/sessions/${oldSessionId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ archived: true, pinned: true }),
  }), { params: Promise.resolve({ id: oldSessionId }) });
  assert.equal(archivedResponse.status, 200);
  assert.ok((await archivedResponse.json()).session.archivedAt);
  assert.ok(sessions.getWorkSession(oldSessionId).archivedAt);
  assert.equal(sessions.getWorkSession(oldSessionId).pinned, true);
  assert.equal(agents.getWorkAgent(agent.id).archivedAt, null);
  assert.equal(agents.listWorkAgents().some(item => item.id === agent.id), true);

  const openedResponse = await route.POST(new Request(`http://panel/api/agents/${agent.id}/session`, { method: "POST" }), { params: Promise.resolve({ id: agent.id }) });
  assert.equal(openedResponse.status, 200);
  const opened = await openedResponse.json();
  assert.notEqual(opened.session.id, oldSessionId);
  assert.equal(agents.getWorkAgent(agent.id).sessionId, opened.session.id);

  const retryResponse = await runRoute.POST(new Request(`http://panel/api/agents/${agent.id}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actionId: original.id, text: original.text }),
  }), { params: Promise.resolve({ id: agent.id }) });
  assert.equal(retryResponse.status, 202);
  const retried = await retryResponse.json();
  assert.equal(retried.run.id, original.id);
  assert.equal(retried.run.state, "complete");
  assert.equal(retried.sessionId, oldSessionId);
  assert.equal(runs.listAssistantRunsForSessions([oldSessionId, opened.session.id]).length, 1);
  assert.equal(agents.getWorkAgent(agent.id).sessionId, opened.session.id);

  const mismatchedRetry = await runRoute.POST(new Request(`http://panel/api/agents/${agent.id}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actionId: original.id, text: "A different task." }),
  }), { params: Promise.resolve({ id: agent.id }) });
  assert.equal(mismatchedRetry.status, 409);
  assert.match((await mismatchedRetry.json()).error, /another request/i);
  assert.equal(runs.listAssistantRunsForSessions([oldSessionId, opened.session.id]).length, 1);

  const restoredResponse = await sessionRoute.PATCH(new Request(`http://panel/api/sessions/${oldSessionId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ archived: false, name: "Earlier route history" }),
  }), { params: Promise.resolve({ id: oldSessionId }) });
  assert.equal(restoredResponse.status, 200);
  assert.equal((await restoredResponse.json()).session.archivedAt, null);
  assert.equal(sessions.getWorkSession(oldSessionId).name, "Earlier route history");
  assert.deepEqual(sessions.getWorkSession(oldSessionId).messages, oldMessages);
  const historyResponse = await sessionRoute.GET(new Request(`http://panel/api/sessions/${oldSessionId}`), { params: Promise.resolve({ id: oldSessionId }) });
  assert.equal(historyResponse.status, 200);
  assert.deepEqual((await historyResponse.json()).messages, oldMessages);
  assert.equal(agents.getWorkAgent(agent.id).name, "Route lifecycle");
  assert.equal(sessions.getWorkSession(opened.session.id).name, "Route lifecycle");
  assert.throws(
    () => agents.agentForSession(sessions.getWorkSession(oldSessionId)),
    error => error?.status === 409 && /earlier saved conversation.*current conversation/i.test(error.message),
  );
});
