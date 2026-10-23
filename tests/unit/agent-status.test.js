import test from "node:test";
import assert from "node:assert/strict";
import { delegatedAgentStatus, formatDelegatedProgress, savedAgentStatus } from "../../components/work/agentStatus.js";

test("saved teammate status follows native approval, stop, and terminal state", () => {
  assert.equal(savedAgentStatus({}).state, "idle");
  assert.deepEqual(savedAgentStatus({ activeRun: { state: "queued", taskLabel: "Review the API" } }), {
    state: "queued", label: "Queued", detail: "", task: "Review the API", active: true,
  });
  assert.equal(savedAgentStatus({ activeRun: { state: "active", permissionPending: true } }).state, "approval");
  assert.equal(savedAgentStatus({ activeRun: { state: "active", permissionPending: true, executionCancelRequestedAt: "now" } }).state, "stopping");
  assert.equal(savedAgentStatus({ lastRun: { state: "error" } }).state, "failed");
  assert.equal(savedAgentStatus({ lastRun: { state: "complete" } }).state, "completed");
});

test("terminal teammate states discard stale active-phase detail", () => {
  for (const [runState, expectedState] of [["complete", "completed"], ["error", "failed"], ["cancelled", "stopped"]]) {
    const status = savedAgentStatus({
      lastRun: {
        state: runState,
        statusLabel: "Waiting for your permission…",
        toolLabel: "Running a protected write",
        taskLabel: "Update the requested file",
      },
    });
    assert.equal(status.state, expectedState);
    assert.equal(status.detail, "");
    assert.equal(status.task, "");
  }

  const active = savedAgentStatus({ activeRun: {
    state: "active",
    statusLabel: "Checking the requested file",
    taskLabel: "Update the requested file",
  } });
  assert.equal(active.detail, "Checking the requested file");
  assert.equal(active.task, "Update the requested file");
});

test("temporary worker status uses recorded lifecycle and bounded progress", () => {
  assert.equal(delegatedAgentStatus({ status: "running", stopRequested: true }).state, "stopping");
  assert.equal(delegatedAgentStatus({ status: "complete", statusLabel: "Complete" }).state, "completed");
  assert.equal(delegatedAgentStatus({ status: "interrupted" }).state, "failed");
  assert.equal(formatDelegatedProgress({ toolCount: 3, durationSeconds: 72.2 }), "3 tool steps · 1m 12s");
});
