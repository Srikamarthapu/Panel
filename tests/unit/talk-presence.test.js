import assert from "node:assert/strict";
import test from "node:test";
import { deriveTalkPresence } from "../../lib/talk-presence.js";

test("Talk stays idle when only the gateway reports other active agents", () => {
  const presence = deriveTalkPresence({
    voiceState: "idle",
    connected: true,
    runtimeStatus: { state: "working", source: "gateway", label: "Working on a task", updatedAt: new Date().toISOString() },
  });
  assert.equal(presence.state, "idle");
  assert.equal(presence.label, "Ready when you are.");
  assert.equal(presence.active, false);
  assert.equal(presence.avatarActivity.state, "idle");
  assert.equal(presence.avatarActivity.orbState, "breathing");
});

test("Talk shows work only for a fresh acknowledged lifecycle event", () => {
  const presence = deriveTalkPresence({
    voiceState: "idle",
    runtimeStatus: { state: "working", source: "voice/action", label: "Opening your calendar", updatedAt: new Date().toISOString(), isStale: false },
  });
  assert.equal(presence.state, "working");
  assert.equal(presence.label, "Opening your calendar");
  assert.equal(presence.active, true);
  assert.equal(presence.avatarActivity.state, "working");
});

test("voice lifecycle is authoritative and error stops active presentation", () => {
  const status = { state: "working", source: "voice/action", updatedAt: new Date().toISOString() };
  assert.equal(deriveTalkPresence({ voiceState: "capturing", runtimeStatus: status }).state, "capturing");
  const failed = deriveTalkPresence({ voiceState: "error", runtimeStatus: status });
  assert.equal(failed.active, false);
  assert.equal(failed.avatarActivity.state, "error");
});

test("only acknowledged work may retain a runtime-specific animation", () => {
  const global = deriveTalkPresence({ voiceState: "idle", runtimeStatus: { state: "working", source: "gateway", updatedAt: new Date().toISOString(), orbState: "weaving" } });
  const acknowledged = deriveTalkPresence({ voiceState: "idle", runtimeStatus: { state: "working", source: "hermes/task", updatedAt: new Date().toISOString(), orbState: "weaving" } });
  assert.equal(global.avatarActivity.orbState, "breathing");
  assert.equal(acknowledged.avatarActivity.orbState, "weaving");
});

test("microphone setup is visible without claiming Hermes is listening", () => {
  const permission = deriveTalkPresence({ voiceState: "idle", permission: "pending" });
  const starting = deriveTalkPresence({ voiceState: "starting", permission: "granted" });
  assert.equal(permission.state, "starting");
  assert.match(permission.label, /permission/i);
  assert.equal(permission.active, false);
  assert.equal(permission.avatarActivity.orbState, "connecting");
  assert.equal(starting.state, "starting");
  assert.equal(starting.active, false);
});
