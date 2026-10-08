import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSelectedAgentIds, parseSelectedAgentIds, workAgentPresence } from "../../lib/work-agent-selection.js";

test("saved agent selections keep unique valid active profile IDs", () => {
  const parsed = parseSelectedAgentIds(JSON.stringify(["atlas", "bad/id", "atlas", 4, "forge"]));
  assert.deepEqual(parsed, ["atlas", "forge"]);
  assert.deepEqual(normalizeSelectedAgentIds(parsed, [
    { id: "atlas", archivedAt: null },
    { id: "forge", archivedAt: "2026-01-01T00:00:00.000Z" },
  ]), ["atlas"]);
  assert.deepEqual(parseSelectedAgentIds("not json"), []);
});

test("agent presence reports only real run state", () => {
  assert.deepEqual(workAgentPresence({}), { label: "No active task", state: "idle", active: false });
  assert.deepEqual(workAgentPresence({ activeRun: { state: "active", statusLabel: "Searching project files" } }), { label: "Searching project files", state: "working", active: true });
  assert.deepEqual(workAgentPresence({ activeRun: { state: "active", permissionPending: true, statusLabel: "Working" } }), { label: "Needs your attention", state: "error", active: true });
  assert.deepEqual(workAgentPresence({ lastRun: { state: "complete", statusLabel: "Complete" } }), { label: "Last task complete", state: "idle", active: false });
  assert.deepEqual(workAgentPresence({ lastRun: { state: "failed", statusLabel: "Thinking" } }), { label: "Last task needs attention", state: "error", active: false });
});
