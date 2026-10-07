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
const store = process.env.PANEL_DATA_DIR;
const reset = () => fs.rmSync(store, { recursive: true, force: true });

function parentRun(id = "parent-run", sessionId = "caller-session") {
  const run = runs.createAssistantRun({ id, sessionId, text: "Delegate a focused task.", textOnly: true });
  runs.updateAssistantRun(run.id, { persistentRuntimePid: process.pid });
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
  assert.equal(first.statusLabel, "Stopping…");
  assert.equal(second.stopRequested, undefined);
  assert.equal(second.canStop, true);

  delegated.recordDelegatedAgent(run.id, { ...other, status: "complete", result: "Finished." }, { sessionId: run.sessionId, runtimePid: process.pid });
  const terminal = delegated.recordDelegatedAgent(run.id, { ...other, status: "running", result: "Late stale update." }, { sessionId: run.sessionId, runtimePid: process.pid });
  assert.equal(terminal.status, "complete");
  assert.equal(terminal.result, "Finished.");
  assert.equal(delegated.getDelegatedAgent(run.sessionId, run.id, "child-two").status, "complete");
});
