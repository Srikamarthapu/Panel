import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { MODE_FRAMES, resolvePreset } from "thinking-orbs/engine";
import { resolveMissionOrb, THINKING_ORB_STATES } from "../../lib/mission-orb-state.js";

// Exercise the production resolver and the library engine. These regressions
// cover live voice precedence, unavailable telemetry, and valid draw geometry.

test("immediate voice interaction overrides background work and stale status", () => {
  for (const state of ["listening", "capturing", "transcribing", "thinking", "speaking", "error"]) {
    const result = resolveMissionOrb({
      contextVoiceState: state,
      activity: { state: "working", orbState: "searching", isStale: true },
    });
    assert.equal(result.state, state);
    assert.equal(result.isStale, false);
    assert.equal(result.paused, state === "error");
  }
});

test("idle voice yields to observed agent work and resumes neutral when work stops", () => {
  const working = resolveMissionOrb({
    contextVoiceState: "idle",
    activity: { state: "working", orbState: "searching", label: "Searching the web" },
  });
  assert.equal(working.orbState, "searching");
  assert.equal(working.label, "Searching the web");
  assert.equal(working.paused, false);
  const idle = resolveMissionOrb({ contextVoiceState: "idle", activity: { state: "idle" } });
  assert.equal(idle.orbState, "breathing");
  assert.equal(idle.label, "Ready");
});

test("expired observations and unavailable agents never keep animating work", () => {
  for (const state of ["working", "thinking", "offline", "error"]) {
    const result = resolveMissionOrb({
      activity: { state, orbState: "working", label: "Old status", isStale: true },
    });
    assert.equal(result.orbState, "breathing");
    assert.equal(result.paused, true);
    assert.equal(result.label, "Status unavailable");
  }
  for (const state of ["offline", "error"]) {
    const result = resolveMissionOrb({ activity: { state, orbState: "searching" } });
    assert.equal(result.orbState, "breathing");
    assert.equal(result.paused, true);
  }
});

test("unrecognized inputs cannot imply listening or unsupported animation modes", () => {
  assert.equal(resolveMissionOrb({ status: "active" }).state, "idle");
  assert.equal(resolveMissionOrb({ status: "connected" }).state, "idle");
  fc.assert(fc.property(fc.string(), (untrustedState) => {
    const result = resolveMissionOrb({ activity: { state: untrustedState, orbState: untrustedState } });
    assert.ok(THINKING_ORB_STATES.includes(result.orbState));
  }), { numRuns: 200 });
});

test("explicit voice prop retains precedence over provider state", () => {
  const result = resolveMissionOrb({ voiceState: "speaking", contextVoiceState: "listening" });
  assert.equal(result.state, "speaking");
  assert.equal(result.orbState, "composing");
});

test("all nine mapped library modes produce finite geometry at hero resolution", () => {
  assert.equal(THINKING_ORB_STATES.length, 9);
  for (const orbState of THINKING_ORB_STATES) {
    const result = resolveMissionOrb({ activity: { state: "working", orbState } });
    const preset = resolvePreset(result.orbState, 64);
    for (const time of [0, 0.6, 1.7, 20]) {
      const frame = MODE_FRAMES[preset.mode](280, time, preset.opts);
      assert.ok(frame.dots.length > 0, `${orbState} must have visible dots`);
      for (const dot of frame.dots) {
        assert.ok(Number.isFinite(dot.x) && Number.isFinite(dot.y));
        assert.ok(Number.isFinite(dot.r) && dot.r > 0);
      }
      for (const line of frame.lines) {
        assert.ok([line.x1, line.y1, line.x2, line.y2].every(Number.isFinite));
      }
    }
  }
});
