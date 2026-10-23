import test from "node:test";
import assert from "node:assert/strict";
import { migrateAgentPresence, normalizeSelectedAgentIds, parseAgentPresence, parseSelectedAgentIds, reconcileAgentPresence, selectedAgentIdsFromPresence, workAgentPresence } from "../../lib/work-agent-selection.js";

test("saved agent selections keep unique valid active profile IDs", () => {
  const parsed = parseSelectedAgentIds(JSON.stringify(["atlas", "bad/id", "atlas", 4, "forge"]));
  assert.deepEqual(parsed, ["atlas", "forge"]);
  assert.deepEqual(normalizeSelectedAgentIds(parsed, [
    { id: "atlas", archivedAt: null },
    { id: "forge", archivedAt: "2026-01-01T00:00:00.000Z" },
  ]), ["atlas"]);
  assert.deepEqual(parseSelectedAgentIds("not json"), []);
});

test("agent presence migrates explicit legacy hiding and automatically includes later profiles", () => {
  const agents = [
    { id: "atlas", archivedAt: null },
    { id: "forge", archivedAt: null },
    { id: "archived", archivedAt: "2026-01-01T00:00:00.000Z" },
  ];
  const migrated = migrateAgentPresence(["atlas"], agents);
  assert.deepEqual(migrated, { version: 2, knownIds: ["atlas", "forge", "archived"], hiddenIds: ["forge", "archived"] });
  assert.deepEqual(selectedAgentIdsFromPresence(migrated, agents), ["atlas"]);

  const withExternalProfile = [...agents, { id: "new-from-server", archivedAt: null }];
  const reconciled = reconcileAgentPresence(migrated, withExternalProfile);
  assert.deepEqual(reconciled.hiddenIds, ["forge", "archived"]);
  assert.deepEqual(selectedAgentIdsFromPresence(reconciled, withExternalProfile), ["atlas", "new-from-server"]);
  assert.deepEqual(parseAgentPresence(JSON.stringify(reconciled)), reconciled);
});

test("a fresh browser shows every active saved profile and rejects damaged presence state", () => {
  const agents = [{ id: "atlas" }, { id: "forge" }];
  const fresh = migrateAgentPresence(null, agents);
  assert.deepEqual(selectedAgentIdsFromPresence(fresh, agents), ["atlas", "forge"]);
  assert.equal(parseAgentPresence("not json"), null);
  assert.equal(parseAgentPresence(JSON.stringify({ version: 1, knownIds: [], hiddenIds: [] })), null);
});

test("explicitly hidden profiles stay hidden through archive, restore, and storage reload", () => {
  const active = [{ id: "atlas" }, { id: "forge" }];
  const hidden = { version: 2, knownIds: ["atlas", "forge"], hiddenIds: ["forge"] };
  const archived = reconcileAgentPresence(hidden, [{ id: "atlas" }, { id: "forge", archivedAt: "2026-10-15T12:00:00.000Z" }]);
  assert.deepEqual(archived.hiddenIds, ["forge"]);
  assert.deepEqual(selectedAgentIdsFromPresence(archived, active), ["atlas"]);
  const restored = reconcileAgentPresence(parseAgentPresence(JSON.stringify(archived)), active);
  assert.deepEqual(restored.hiddenIds, ["forge"]);
  assert.deepEqual(selectedAgentIdsFromPresence(restored, active), ["atlas"]);
});

test("agent presence reports only real run state", () => {
  assert.deepEqual(workAgentPresence({}), { label: "No active task", state: "idle", active: false });
  assert.deepEqual(workAgentPresence({ activeRun: { state: "active", statusLabel: "Searching project files" } }), { label: "Searching project files", state: "working", active: true });
  assert.deepEqual(workAgentPresence({ activeRun: { state: "active", permissionPending: true, statusLabel: "Working" } }), { label: "Needs your attention", state: "error", active: true });
  assert.deepEqual(workAgentPresence({ lastRun: { state: "complete", statusLabel: "Complete" } }), { label: "Last task complete", state: "idle", active: false });
  assert.deepEqual(workAgentPresence({ lastRun: { state: "failed", statusLabel: "Thinking" } }), { label: "Last task needs attention", state: "error", active: false });
});

test("agent progress uses the current action, then its actual task, without inventing progress", () => {
  const activeRun = { state: "active", statusLabel: "Thinking through your request…", taskLabel: "Review the calendar integration" };
  assert.equal(workAgentPresence({ activeRun }).label, "Working on: Review the calendar integration");
  assert.equal(workAgentPresence({ activeRun: { ...activeRun, statusLabel: "Reading calendar.js" } }).label, "Reading calendar.js");
  assert.equal(workAgentPresence({ activeRun: { ...activeRun, statusLabel: "Reading…" } }).label, "Reading · Review the calendar integration");
  assert.equal(workAgentPresence({ activeRun: { ...activeRun, toolLabel: "Checking calendar tests" } }).label, "Checking calendar tests");
  assert.equal(workAgentPresence({ activeRun: { ...activeRun, permissionPending: true } }).label, "Needs your attention");
  assert.equal(workAgentPresence({ activeRun: { ...activeRun, executionCancelRequestedAt: "now" } }).label, "Stopping");
  assert.equal(workAgentPresence({ activeRun: { ...activeRun, state: "queued", statusLabel: "Queued" } }).label, "Queued: Review the calendar integration");
  assert.ok(workAgentPresence({ activeRun: { ...activeRun, taskLabel: "Long task ".repeat(40) } }).label.length <= 96);
  assert.equal(workAgentPresence({ lastRun: activeRun }).label, "No active task");
});
