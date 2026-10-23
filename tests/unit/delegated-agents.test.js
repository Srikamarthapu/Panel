import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "panel-delegated-agents-"));
process.env.PANEL_DATA_DIR = path.join(temporary, "store");

const runs = await import("../../lib/assistant-runs.js");
const delegated = await import("../../lib/delegated-agents.js");
const runtime = await import("../../lib/hermes-acp-runtime.js");
const storeHelpers = await import("../../lib/work-store.js");
const store = process.env.PANEL_DATA_DIR;
const reset = () => fs.rmSync(store, { recursive: true, force: true });

function parentRun(id = "parent-run", sessionId = "caller-session") {
  const run = runs.createAssistantRun({ id, sessionId, text: "Delegate a focused task.", textOnly: true });
  runs.updateAssistantRun(run.id, { persistentRuntimePid: process.pid, persistentRuntimeIdentity: storeHelpers.processIdentity(process.pid) });
  return run;
}

test.beforeEach(reset);
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

test("delegated updates require the exact parent conversation and runtime owner", async () => {
  const run = parentRun();
  const value = { id: "child-one", name: "Research helper", task: "Find the relevant API", status: "running", canStop: true };

  assert.equal(delegated.recordDelegatedAgent(run.id, value, { sessionId: "other-session", runtimePid: process.pid }), null);
  assert.equal(delegated.recordDelegatedAgent(run.id, value, { sessionId: run.sessionId, runtimePid: process.pid + 100000 }), null);
  assert.equal(delegated.recordDelegatedAgent("unknown-run", value, { sessionId: run.sessionId, runtimePid: process.pid }), null);
  assert.deepEqual(delegated.listDelegatedAgents(run.sessionId), []);

  const recorded = delegated.recordDelegatedAgent(run.id, value, { sessionId: run.sessionId, runtimePid: process.pid });
  assert.equal(recorded.sessionId, run.sessionId);
  assert.equal(recorded.runId, run.id);
  assert.equal(delegated.getDelegatedAgent("other-session", run.id, value.id), null);
  assert.equal(delegated.getDelegatedAgent(run.sessionId, run.id, value.id).canStop, true);
  await assert.rejects(
    runtime.stopDelegatedAgent({ sessionId: "other-session", runId: run.id, agentId: value.id }),
    /no longer available/i,
  );
});

test("a verified owner event migrates a legacy delegation record to process identity", () => {
  const run = parentRun("migration-run", "migration-session");
  const directory = path.join(store, "delegated-agents");
  const file = path.join(directory, `${run.id}.json`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    runId: run.id,
    sessionId: run.sessionId,
    runtimePid: process.pid,
    agents: [{ id: "legacy-child", instanceId: "legacy-child", runId: run.id, sessionId: run.sessionId, status: "running", canStop: true, updatedAt: new Date().toISOString() }],
  }));

  delegated.recordDelegatedAgent(run.id, { id: "legacy-child", status: "running", canStop: true }, { sessionId: run.sessionId, runtimePid: process.pid });
  const migrated = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(migrated.runtimeIdentity, storeHelpers.processIdentity(process.pid));
  assert.equal(delegated.getDelegatedAgent(run.sessionId, run.id, "legacy-child").canStop, true);
});

test("stop requests stay scoped to one child and terminal updates cannot be reopened", () => {
  const run = parentRun();
  const other = { id: "child-two", name: "Second helper", task: "Separate task", status: "running", canStop: true };
  delegated.recordDelegatedAgent(run.id, { id: "child-one", status: "running", canStop: true }, { sessionId: run.sessionId, runtimePid: process.pid });
  delegated.recordDelegatedAgent(run.id, other, { sessionId: run.sessionId, runtimePid: process.pid });

  delegated.markDelegationStopping(run.sessionId, run.id, "child-one");
  const first = delegated.getDelegatedAgent(run.sessionId, run.id, "child-one");
  const second = delegated.getDelegatedAgent(run.sessionId, run.id, "child-two");
  assert.equal(first.stopRequested, true);
  assert.equal(first.canStop, false);
  assert.equal(first.lifecycle, "stopping");
  assert.equal(first.statusLabel, "Stopping…");
  assert.equal(second.stopRequested, undefined);
  assert.equal(second.canStop, true);

  delegated.recordDelegatedAgent(run.id, { ...other, status: "complete", result: "Finished." }, { sessionId: run.sessionId, runtimePid: process.pid });
  const terminal = delegated.recordDelegatedAgent(run.id, { ...other, status: "running", result: "Late stale update." }, { sessionId: run.sessionId, runtimePid: process.pid });
  assert.equal(terminal.status, "complete");
  assert.equal(terminal.result, "Finished.");
  assert.equal(delegated.getDelegatedAgent(run.sessionId, run.id, "child-two").status, "complete");
});

test("late nonterminal events cannot regress progress and stopping waits for a terminal event", () => {
  const run = parentRun();
  const owner = { sessionId: run.sessionId, runtimePid: process.pid };
  delegated.recordDelegatedAgent(run.id, {
    id: "child-one", delegationId: "delegation-one", status: "running", canStop: true,
    task: "Check the API", toolCount: 2, updatedAt: "2026-10-13T12:00:02.000Z",
  }, owner);

  const regressed = delegated.recordDelegatedAgent(run.id, {
    id: "child-one", delegationId: "delegation-one", status: "queued", canStop: false,
    updatedAt: "2026-10-13T12:00:03.000Z",
  }, owner);
  assert.equal(regressed.status, "running");
  assert.equal(regressed.toolCount, 2);

  delegated.markDelegationStopping(run.sessionId, run.id, "child-one");
  const afterTick = delegated.recordDelegatedAgent(run.id, {
    id: "child-one", delegationId: "delegation-one", status: "running", canStop: true,
    toolCount: 3, updatedAt: "2026-10-13T12:00:04.000Z",
  }, owner);
  assert.equal(afterTick.lifecycle, "stopping");
  assert.equal(afterTick.statusLabel, "Stopping…");
  assert.equal(afterTick.canStop, false);
  assert.equal(afterTick.toolCount, 3);

  const stopped = delegated.recordDelegatedAgent(run.id, {
    id: "child-one", delegationId: "delegation-one", status: "cancelled",
    durationSeconds: 4.5, updatedAt: "2026-10-13T12:00:05.000Z",
  }, owner);
  assert.equal(stopped.lifecycle, "stopped");
  assert.equal(stopped.statusLabel, "Stopped");
  assert.equal(stopped.durationSeconds, 4.5);
});

test("a reused worker id keeps distinct delegation instances inside one parent run", () => {
  const run = parentRun();
  const owner = { sessionId: run.sessionId, runtimePid: process.pid };
  delegated.recordDelegatedAgent(run.id, { id: "reused", delegationId: "first", status: "complete", task: "First task", updatedAt: "2026-10-13T12:00:01.000Z" }, owner);
  delegated.recordDelegatedAgent(run.id, { id: "reused", delegationId: "second", status: "running", task: "Second task", canStop: true, updatedAt: "2026-10-13T12:00:02.000Z" }, owner);

  const records = delegated.listDelegatedAgents(run.sessionId).filter(agent => agent.id === "reused");
  assert.equal(records.length, 2);
  assert.deepEqual(new Set(records.map(agent => agent.instanceId)), new Set(["reused:first", "reused:second"]));
  assert.equal(delegated.getDelegatedAgent(run.sessionId, run.id, "reused").delegationId, "second");
});

test("stop selection fails closed for ambiguous reused ids and marks only the chosen generation", () => {
  const run = parentRun();
  const owner = { sessionId: run.sessionId, runtimePid: process.pid };
  delegated.recordDelegatedAgent(run.id, {
    id: "reused", delegationId: "first", status: "running", canStop: true,
    task: "First task", updatedAt: "2026-10-13T12:00:01.000Z",
  }, owner);
  delegated.recordDelegatedAgent(run.id, {
    id: "reused", delegationId: "second", status: "running", canStop: true,
    task: "Second task", updatedAt: "2026-10-13T12:00:02.000Z",
  }, owner);

  assert.equal(delegated.getDelegatedAgent(run.sessionId, run.id, "reused"), null);
  assert.equal(delegated.markDelegationStopping(run.sessionId, run.id, "reused"), undefined);

  delegated.markDelegationStopping(run.sessionId, run.id, "reused", "first");
  const records = delegated.listDelegatedAgents(run.sessionId).filter(agent => agent.id === "reused");
  assert.equal(records.find(agent => agent.delegationId === "first").lifecycle, "stopping");
  assert.equal(records.find(agent => agent.delegationId === "second").lifecycle, "running");
});

test("sparse terminal events close only the current timestamped worker generation", () => {
  const run = parentRun();
  const owner = { sessionId: run.sessionId, runtimePid: process.pid };
  delegated.recordDelegatedAgent(run.id, { id: "reused", delegationId: "first", status: "complete", task: "First task", updatedAt: "2026-10-13T12:00:01.000Z" }, owner);
  delegated.recordDelegatedAgent(run.id, { id: "reused", delegationId: "second", status: "running", task: "Second task", canStop: true, updatedAt: "2026-10-13T12:00:03.000Z" }, owner);

  const late = delegated.recordDelegatedAgent(run.id, { id: "reused", status: "complete", result: "Late first result", updatedAt: "2026-10-13T12:00:02.000Z" }, owner);
  assert.equal(late.status, "running");
  assert.equal(late.delegationId, "second");

  const current = delegated.recordDelegatedAgent(run.id, { id: "reused", status: "complete", result: "Second result", updatedAt: "2026-10-13T12:00:04.000Z" }, owner);
  assert.equal(current.status, "complete");
  assert.equal(current.instanceId, "reused:second");
  assert.equal(delegated.listDelegatedAgents(run.sessionId).filter(agent => agent.id === "reused").length, 2);
});
