// tests/property/voice-one-press.test.js
//
// T-0010 Law 1 — "One press = listening." Property + example tests proving the
// reducer state path from a single start gesture reaches "listening" with NO
// second user event, and that the press produces an immediate visible caption
// change (Law 2) even while permission/getUserMedia is still resolving.
//
// The imperative WebKit-gesture fix (create + resume the AudioContext inside
// the press handler via primeAudioStack) lives in VoiceProvider.jsx and is
// asserted structurally by tests/unit/voice-one-press-gesture.test.js. This
// file owns the pure state-path proof.

import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { reducer, initialWrapper } from "../../components/voice/voiceMachine.js";

function dispatch(wrapper, event) {
  return reducer(wrapper, event);
}

// The set of user-originated events. A "press" is exactly one TOGGLE_CONTINUOUS.
// SET_PERMISSION is dispatched by the imperative shell (getUserMedia result),
// NOT by the user — so it does not count as a press.
function isUserPress(event) {
  return event && event.type === "TOGGLE_CONTINUOUS";
}

test("Law 1: one TOGGLE_CONTINUOUS from idle (permission unknown) reaches listening after the shell's grant, with no second press", () => {
  // Press ONCE from a cold start (permission unknown).
  let w = dispatch(initialWrapper, { type: "TOGGLE_CONTINUOUS" });

  // The single press must (a) mark continuous requested, (b) fire exactly one
  // requestPermission effect, and (c) NOT already be listening (permission not
  // granted yet) — but crucially it must leave a path that needs no more presses.
  assert.equal(w.state.continuousRequested, true, "continuous requested after one press");
  const permEffects = w.effects.filter((e) => e.kind === "requestPermission");
  assert.equal(permEffects.length, 1, "exactly one permission request from one press");

  // Law 2: the press produced an immediate VISIBLE state change — the caption is
  // no longer the idle "Press to start." prompt while the mic warms.
  assert.notEqual(
    w.state.caption,
    "Idle. Press to start.",
    "caption changes immediately on press (no dead control)",
  );
  assert.equal(w.state.permission, "pending", "permission promoted to pending in-gesture");

  // The shell resolves getUserMedia and dispatches the grant. This is NOT a user
  // press. It must land us in listening because continuousRequested is set.
  w = dispatch(w, { type: "SET_PERMISSION", value: "granted" });
  assert.equal(w.state.state, "starting", "setup is visible until the mic is live");
  const sync = w.effects.filter((e) => e.kind === "syncContinuous" && e.on === true);
  assert.equal(sync.length, 1, "syncContinuous(on) starts the mic/VAD exactly once");
  w = dispatch(w, { type: "MIC_READY" });
  assert.equal(w.state.state, "listening", "listening reached without a second press");
});

test("Law 1: when permission is ALREADY granted, one press goes straight to listening", () => {
  let w = dispatch(initialWrapper, { type: "SET_PERMISSION", value: "granted" });
  w = dispatch(w, { type: "TOGGLE_CONTINUOUS" });
  assert.ok(
    w.effects.some((e) => e.kind === "syncContinuous" && e.on === true),
    "syncContinuous(on) emitted on the same press",
  );
  w = dispatch(w, { type: "MIC_READY" });
  assert.equal(w.state.state, "listening", "single press → live listening without another press");
});

test("Law 1: retry from an error state (denied) re-requests on one press and shows pending", () => {
  // Simulate a prior denial.
  let w = dispatch(initialWrapper, { type: "SET_PERMISSION", value: "denied", error: "no mic" });
  assert.equal(w.state.state, "error");
  // One press to try again.
  w = dispatch(w, { type: "TOGGLE_CONTINUOUS" });
  assert.equal(w.state.permission, "pending", "denied→pending on retry press");
  assert.equal(
    w.effects.filter((e) => e.kind === "requestPermission").length,
    1,
    "one permission request on retry press",
  );
  // Grant now lands in listening — still just the one press.
  w = dispatch(w, { type: "SET_PERMISSION", value: "granted" });
  w = dispatch(w, { type: "MIC_READY" });
  assert.equal(w.state.state, "listening");
});

test("Law 1 (property): across random pre-press event prefixes, a single start press + shell grant never needs a second press to listen", () => {
  const benignPrefix = fc.array(
    fc.oneof(
      fc.constant({ type: "OPEN_SETTINGS" }),
      fc.constant({ type: "CLOSE_SETTINGS" }),
      fc.constant({ type: "LOAD_VOICES", voices: [] }),
      fc.record({
        type: fc.constant("UPDATE_CONFIG"),
        partial: fc.constant({ autoSpeak: true }),
      }),
    ),
    { maxLength: 6 },
  );

  fc.assert(
    fc.property(benignPrefix, fc.boolean(), (prefix, preGranted) => {
      let w = initialWrapper;
      if (preGranted) w = dispatch(w, { type: "SET_PERMISSION", value: "granted" });
      for (const ev of prefix) w = dispatch(w, ev);

      // Exactly one user press.
      const before = w;
      w = dispatch(w, { type: "TOGGLE_CONTINUOUS" });
      assert.ok(isUserPress({ type: "TOGGLE_CONTINUOUS" }));

      if (preGranted) {
        w = dispatch(w, { type: "MIC_READY" });
        assert.equal(w.state.state, "listening");
        return true;
      }

      // Not granted yet: the press must have requested permission and shown a
      // non-idle caption; the shell's grant (not a press) reaches listening.
      assert.equal(w.state.caption !== before.state.caption || before.state.permission === "pending", true);
      assert.ok(w.effects.some((e) => e.kind === "requestPermission"));
      w = dispatch(w, { type: "SET_PERMISSION", value: "granted" });
      w = dispatch(w, { type: "MIC_READY" });
      assert.equal(w.state.state, "listening");
      return true;
    }),
    { numRuns: 200 },
  );
});
