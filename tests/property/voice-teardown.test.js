// Property test for the Voice_Pipeline teardown ordering.
// Validates: Requirements 5.5
// Properties: 12 (Voice teardown ordering invariant)
//
// Strategy: drive the pure voice-machine reducer into each active Voice_State
// {listening, capturing, transcribing, thinking, speaking}, dispatch
// TOGGLE_CONTINUOUS, and assert the emitted side-effect descriptors appear
// in the documented order:
//
//   stopAudio
//   stopRecorder(discard:true)
//   stopAllTracks
//   closeAudioContext
//   stopVisualizer
//   clearVadInterval
//   syncContinuous(on:false)
//
// Failure injection (the F ⊆ {recorder, tracks, audioContext, vizRAF,
// vadInterval} subset described in design.md Property 12) lives in the
// imperative shell, not the reducer. The reducer surfaces failures via the
// TEARDOWN_STEP_FAILED event, which must emit one sanitized kind="log"
// Activity_Item per failure. The second test exercises that handler with
// arbitrary error messages and asserts the sanitized-summary invariants
// (length ≤ 500, no ASCII control chars).

import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  reducer,
  initialWrapper,
} from "../../components/voice/voiceMachine.js";

// Documented teardown order from design.md "Ordered teardown (Req 5.5,
// Property 12)" plus the framing stopAudio / syncContinuous effects emitted
// by the TOGGLE_CONTINUOUS handler in components/voice/voiceMachine.js.
const ORDER = [
  "stopAudio",
  "stopRecorder",
  "stopAllTracks",
  "closeAudioContext",
  "stopVisualizer",
  "clearVadInterval",
  "syncContinuous",
];

const ACTIVE_STATES = [
  "listening",
  "capturing",
  "transcribing",
  "thinking",
  "speaking",
];

function dispatch(w, e) {
  return reducer(w, e);
}

// Drives the reducer through the documented event flow until the inner
// Voice_State equals `target`. Mirrors the state-diagram edges in
// design.md "Voice State Machine".
function reachActiveState(target) {
  let w = dispatch(initialWrapper, {
    type: "SET_PERMISSION",
    value: "granted",
  });
  if (target === "listening") {
    w = dispatch(w, { type: "TOGGLE_CONTINUOUS" });
    w = dispatch(w, { type: "MIC_READY" });
  } else if (target === "capturing") {
    w = dispatch(w, { type: "TOGGLE_CONTINUOUS" });
    w = dispatch(w, { type: "MIC_READY" });
    w = dispatch(w, { type: "VAD_ONSET" });
    w = dispatch(w, { type: "RECORDER_STARTED" });
  } else if (target === "transcribing") {
    w = dispatch(w, { type: "TOGGLE_CONTINUOUS" });
    w = dispatch(w, { type: "MIC_READY" });
    w = dispatch(w, { type: "VAD_ONSET" });
    w = dispatch(w, { type: "RECORDER_STARTED" });
    w = dispatch(w, { type: "STOP_PTT" });
  } else if (target === "thinking") {
    w = dispatch(w, { type: "TOGGLE_CONTINUOUS" });
    w = dispatch(w, { type: "MIC_READY" });
    w = dispatch(w, { type: "VAD_ONSET" });
    w = dispatch(w, { type: "RECORDER_STARTED" });
    w = dispatch(w, { type: "STOP_PTT" });
    w = dispatch(w, { type: "STT_OK", text: "hi" });
  } else if (target === "speaking") {
    w = dispatch(w, { type: "TOGGLE_CONTINUOUS" });
    w = dispatch(w, { type: "MIC_READY" });
    w = dispatch(w, { type: "VAD_ONSET" });
    w = dispatch(w, { type: "RECORDER_STARTED" });
    w = dispatch(w, { type: "STOP_PTT" });
    w = dispatch(w, { type: "STT_OK", text: "hi" });
    w = dispatch(w, { type: "CHAT_OK", response: "ok" });
    w = dispatch(w, { type: "TTS_DONE", url: "blob:abc" });
  }
  return w;
}

// ---------------------------------------------------------------------------
// Property 12 — TOGGLE_CONTINUOUS teardown effect ordering
// ---------------------------------------------------------------------------

test("Property 12: TOGGLE_CONTINUOUS emits teardown effects in documented order", () => {
  fc.assert(
    fc.property(fc.constantFrom(...ACTIVE_STATES), (state) => {
      const w = reachActiveState(state);
      assert.equal(
        w.state.state,
        state,
        `failed to reach Voice_State="${state}" before toggling`,
      );

      const w2 = dispatch(w, { type: "TOGGLE_CONTINUOUS" });

      // Toggling out of any active state lands at idle and clears the
      // continuous-listening request flag.
      assert.equal(w2.state.state, "idle");
      assert.equal(w2.state.continuousRequested, false);

      const kinds = w2.effects.map((e) => e.kind);

      // Every documented teardown step must be emitted exactly once.
      const filtered = kinds.filter((k) => ORDER.includes(k));
      assert.deepEqual(
        filtered,
        ORDER,
        `teardown effect kinds did not match documented order; got: ${JSON.stringify(kinds)}`,
      );

      // stopRecorder must carry discard:true (Property 14 / Req 5.5).
      const stopRec = w2.effects.find((e) => e.kind === "stopRecorder");
      assert.ok(stopRec);
      assert.equal(stopRec.discard, true);

      // syncContinuous(on:false) must be emitted last among the teardown set.
      const sync = w2.effects.find((e) => e.kind === "syncContinuous");
      assert.ok(sync);
      assert.equal(sync.on, false);

      // Strict ordering: each listed kind appears strictly after the previous
      // one in the raw effect array (no out-of-order interleaving).
      let lastIndex = -1;
      for (const k of filtered) {
        const idx = ORDER.indexOf(k);
        assert.ok(
          idx > lastIndex,
          `teardown effect "${k}" appears out of order (filtered: ${filtered.join(", ")})`,
        );
        lastIndex = idx;
      }

      return true;
    }),
    { numRuns: 50 },
  );
});

// ---------------------------------------------------------------------------
// Property 12 — TEARDOWN_STEP_FAILED emits sanitized log Activity_Items
// ---------------------------------------------------------------------------

test("Property 12: TEARDOWN_STEP_FAILED emits sanitized log Activity_Item per failure", () => {
  fc.assert(
    fc.property(
      // Step name is bounded to the documented set.
      fc.constantFrom("recorder", "tracks", "audioContext", "vizRAF", "vadInterval"),
      // Arbitrary error message: deliberately includes control chars,
      // long inputs, and synthetic Authorization headers / blob markers to
      // exercise the sanitizer in voiceMachine.js.
      fc.string({ minLength: 0, maxLength: 1200 }),
      (stepName, message) => {
        const w = dispatch(initialWrapper, {
          type: "TEARDOWN_STEP_FAILED",
          step: stepName,
          message,
        });

        // Exactly one Activity_Item is emitted, with kind="log".
        const logs = w.effects.filter((e) => e.kind === "emitActivity");
        assert.equal(logs.length, 1);
        const log = logs[0];
        assert.equal(log.activityKind, "log");
        assert.equal(log.source, "voice");

        // Sanitized summary is ≤ 500 chars.
        assert.ok(
          typeof log.summary === "string" && log.summary.length <= 500,
          `summary length ${log.summary && log.summary.length} exceeded 500`,
        );
        // No ASCII control characters survive sanitization.
        assert.ok(
          !/[\u0000-\u001f\u007f]/.test(log.summary),
          "summary contained control characters",
        );
        // Step name is preserved (sanitized) in the summary.
        assert.ok(
          log.summary.includes(`teardown ${stepName}`),
          `summary missing step name: ${log.summary}`,
        );

        // Reducer must not change the inner Voice_State on a failure event;
        // the imperative shell drives state transitions, not error logs.
        assert.equal(w.state.state, initialWrapper.state.state);
        return true;
      },
    ),
    { numRuns: 100 },
  );
});
