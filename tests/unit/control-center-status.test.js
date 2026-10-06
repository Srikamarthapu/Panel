import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveOrbActivity, selectCurrentActivity } from "../../lib/control-center-status.js";

const now = Date.parse("2026-09-15T20:00:00Z");
const iso = (ago = 0) => new Date(now - ago).toISOString();
const gateway = { online: true, running: true, isStale: false, activeAgents: 0, updatedAt: iso() };
const status = (options = {}) => deriveOrbActivity({ now, fetchedAt: iso(), gateway, ...options });
const event = (overrides = {}) => ({ id: "run1:running", sessionId: "s1", source: "voice/action", state: "active", title: "Opening your calendar", updatedAt: iso(2_000), ...overrides });

test("a connected gateway with no work stays idle", () => {
  assert.equal(status().state, "idle");
  assert.equal(status().orbState, "breathing");
});
test("fresh detached work drives the orb until its completion arrives", () => {
  const active = event();
  assert.equal(status({ activity: [active] }).state, "working");
  const complete = event({ id: "run1:complete", state: "complete", updatedAt: iso() });
  assert.equal(status({ activity: [active, complete] }).state, "idle");
});
test("old, undated, or future active events never masquerade as live work", () => {
  for (const updatedAt of [iso(121_000), "", "not-a-date", iso(-30_000)]) {
    assert.equal(status({ activity: [event({ updatedAt })] }).state, "idle");
  }
});
test("poll connection loss overrides cached work and marks it delayed", () => {
  const result = status({ fetchedAt: iso(25_000), activity: [event()] });
  assert.equal(result.state, "offline");
  assert.equal(result.isStale, true);
});
test("a request failure immediately freezes cached work while preserving the last successful timestamp", () => {
  const result = status({ connectionError: true, fetchedAt: iso(3_000), activity: [event()] });
  assert.equal(result.state, "offline");
  assert.equal(result.label, "Live status delayed");
  assert.equal(result.isStale, true);
  assert.equal(result.updatedAt, iso(3_000));
  assert.equal(status({ connectionError: true, voiceState: "speaking" }).state, "speaking");
});
test("real microphone and audio state override runtime events and stale polling", () => {
  assert.equal(status({ voiceState: "speaking", fetchedAt: iso(25_000), activity: [event()] }).state, "speaking");
  assert.equal(status({ voiceState: "capturing" }).orbState, "listening");
  assert.equal(status({ voiceState: "thinking" }).orbState, "solving");
});
test("tool completion pairs by session and call id, with explicit operation animation", () => {
  const active = event({ source: "hermes/tool", callId: "c1", toolName: "web_search", id: "start" });
  assert.equal(status({ activity: [active] }).orbState, "searching");
  const done = event({ source: "hermes/tool", callId: "c1", state: "done", id: "result" });
  assert.equal(status({ activity: [active, done] }).state, "idle");
  assert.equal(status({ activity: [active, { ...done, sessionId: "other" }] }).state, "working");
});
test("uncorrelated tool events and history cannot declare work active", () => {
  assert.equal(status({ activity: [event({ source: "hermes/tool", callId: "" })] }).state, "idle");
  assert.equal(status({ activity: [event({ source: "orchestrator/ledger" })] }).state, "idle");
});
test("terminal error suppresses the matching run without blocking a newer run", () => {
  const failed = event({ id: "run1:failed", state: "error" });
  const newer = event({ id: "run2:running", title: "Reading a file" });
  assert.equal(selectCurrentActivity([event(), failed, newer], { now }).id, newer.id);
});
test("session filtering scopes voice runs but preserves independent agent work", () => {
  assert.equal(selectCurrentActivity([event()], { now, sessionId: "other" }), null);
  assert.ok(selectCurrentActivity([event({ source: "hermes/task" })], { now, sessionId: "other" }));
});
test("verified gateway active count is evidence, unavailable metadata cannot drive activity", () => {
  assert.equal(status({ gateway: { ...gateway, activeAgents: 2 } }).state, "working");
  const result = status({ gateway: { ...gateway, activeAgents: 2, isStale: true } });
  assert.equal(result.state, "idle");
  assert.equal(result.isStale, true);
});
