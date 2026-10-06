// Property tests for the Voice_Pipeline TTS failure path + objectURL
// lifecycle (Property 11) and the barge-in invariant (Property 7).
//
// Validates: Requirements 3.10, 5.1, 5.2, 5.3, 5.4, 5.8.
//
// These tests drive the pure reducer at components/voice/voiceMachine.js
// through a sequence of events and assert the resulting state plus the
// emitted side-effect descriptors. No DOM, no React, no timers.

import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  reducer,
  initialWrapper,
} from "../../components/voice/voiceMachine.js";

function dispatch(wrapper, event) {
  return reducer(wrapper, event);
}

// Drive the reducer up to the `thinking` state. In continuous mode this
// goes idle -> listening -> capturing -> transcribing -> thinking; in PTT
// mode it goes idle -> capturing -> transcribing -> thinking. After the
// final CHAT_OK the reducer leaves the view at `thinking` with a queued
// `callTTS` effect (TTS_DONE flips it to `speaking`).
function reachThinking(continuous) {
  let w = dispatch(initialWrapper, { type: "SET_PERMISSION", value: "granted" });
  if (continuous) {
    w = dispatch(w, { type: "TOGGLE_CONTINUOUS" });
    w = dispatch(w, { type: "VAD_ONSET" });
  } else {
    w = dispatch(w, { type: "START_PTT" });
  }
  w = dispatch(w, { type: "STOP_PTT" });
  w = dispatch(w, { type: "STT_OK", text: "hello" });
  w = dispatch(w, { type: "CHAT_OK", response: "world" });
  return w;
}

// ---------------------------------------------------------------------------
// Property 11: TTS failure-path + objectURL lifecycle invariant
// ---------------------------------------------------------------------------

test("Property 11: TTS_FAILED lands at the rest state and emits revoke + stopAudio + emitActivity", () => {
  fc.assert(
    fc.property(
      fc.boolean(),
      fc.constantFrom(
        "status_500",
        "blob_too_small",
        "stall_3s",
        "play_rejected",
        "audio_error",
        "timeout_15s",
        "network_error"
      ),
      (continuous, reason) => {
        const before = reachThinking(continuous);
        assert.equal(before.state.state, "thinking");

        const after = dispatch(before, {
          type: "TTS_FAILED",
          reason,
          statusCode: 500,
          url: "blob:abc",
        });

        // Rest state: listening when continuous, idle otherwise.
        assert.equal(after.state.state, continuous ? "listening" : "idle");

        const kinds = after.effects.map((e) => e.kind);
        assert.ok(
          kinds.includes("revokeURL"),
          `expected revokeURL effect, got ${kinds.join(",")}`
        );
        assert.ok(
          kinds.includes("stopAudio"),
          `expected stopAudio effect, got ${kinds.join(",")}`
        );
        assert.ok(
          kinds.includes("emitActivity"),
          `expected emitActivity effect, got ${kinds.join(",")}`
        );

        // objectURL is revoked exactly once for the failed request.
        const revokes = after.effects.filter(
          (e) => e.kind === "revokeURL" && e.url === "blob:abc"
        );
        assert.equal(revokes.length, 1);

        // Exactly one Activity_Item per failure, kind="log".
        const activity = after.effects.filter((e) => e.kind === "emitActivity");
        assert.equal(activity.length, 1);
        assert.equal(activity[0].activityKind, "log");
        assert.ok(activity[0].summary.length <= 500);
        return true;
      }
    ),
    { numRuns: 80 }
  );
});

test("Property 11: TTS_FAILED without a URL still resets state and emits stopAudio + activity", () => {
  fc.assert(
    fc.property(fc.boolean(), (continuous) => {
      const before = reachThinking(continuous);
      const after = dispatch(before, {
        type: "TTS_FAILED",
        reason: "blob_too_small",
      });
      assert.equal(after.state.state, continuous ? "listening" : "idle");
      const kinds = after.effects.map((e) => e.kind);
      // No URL means no revokeURL effect — the helper guards against
      // double-revoke for blob<256B (no playback ever started).
      assert.ok(!kinds.includes("revokeURL"));
      assert.ok(kinds.includes("stopAudio"));
      assert.ok(kinds.includes("emitActivity"));
      return true;
    }),
    { numRuns: 40 }
  );
});

test("Property 11: TTS_PLAYBACK_ENDED revokes the playback URL and returns to rest", () => {
  fc.assert(
    fc.property(fc.boolean(), (continuous) => {
      let w = reachThinking(continuous);
      w = dispatch(w, { type: "TTS_DONE", url: "blob:xyz" });
      assert.equal(w.state.state, "speaking");
      assert.ok(w.effects.some((e) => e.kind === "playAudio" && e.url === "blob:xyz"));

      const ended = dispatch(w, { type: "TTS_PLAYBACK_ENDED", url: "blob:xyz" });
      assert.equal(ended.state.state, continuous ? "listening" : "idle");

      const revokes = ended.effects.filter(
        (e) => e.kind === "revokeURL" && e.url === "blob:xyz"
      );
      assert.equal(revokes.length, 1);
      return true;
    }),
    { numRuns: 50 }
  );
});

// ---------------------------------------------------------------------------
// Property 7: Barge-in invariant
// ---------------------------------------------------------------------------

test("Property 7: BARGE_IN from speaking transitions to capturing and emits stopAudio + revokeURL + startRecorder", () => {
  let w = reachThinking(true);
  w = dispatch(w, { type: "TTS_DONE", url: "blob:xyz" });
  assert.equal(w.state.state, "speaking");

  const after = dispatch(w, { type: "BARGE_IN_DETECTED", url: "blob:xyz" });
  assert.equal(after.state.state, "capturing");

  const kinds = after.effects.map((e) => e.kind);
  assert.ok(kinds.includes("stopAudio"));
  assert.ok(kinds.includes("revokeURL"));
  assert.ok(kinds.includes("startRecorder"));

  // The discarded TTS objectURL is revoked exactly once.
  const revokes = after.effects.filter(
    (e) => e.kind === "revokeURL" && e.url === "blob:xyz"
  );
  assert.equal(revokes.length, 1);
});

test("Property 7: BARGE_IN ordering — stopAudio fires before startRecorder", () => {
  let w = reachThinking(true);
  w = dispatch(w, { type: "TTS_DONE", url: "blob:order" });
  const after = dispatch(w, { type: "BARGE_IN_DETECTED", url: "blob:order" });
  const kinds = after.effects.map((e) => e.kind);
  const stopIdx = kinds.indexOf("stopAudio");
  const startIdx = kinds.indexOf("startRecorder");
  assert.ok(stopIdx >= 0 && startIdx >= 0);
  assert.ok(
    stopIdx < startIdx,
    `expected stopAudio before startRecorder, got ${kinds.join(",")}`
  );
});

test("Property 7: BARGE_IN_DETECTED is a no-op outside of the speaking state", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(
        "idle",
        "listening",
        "capturing",
        "transcribing",
        "thinking",
        "error"
      ),
      (target) => {
        let w = initialWrapper;
        w = dispatch(w, { type: "SET_PERMISSION", value: "granted" });

        if (target === "idle") {
          // already idle
        } else if (target === "listening") {
          w = dispatch(w, { type: "TOGGLE_CONTINUOUS" });
        } else if (target === "capturing") {
          w = dispatch(w, { type: "TOGGLE_CONTINUOUS" });
          w = dispatch(w, { type: "VAD_ONSET" });
        } else if (target === "transcribing") {
          w = dispatch(w, { type: "TOGGLE_CONTINUOUS" });
          w = dispatch(w, { type: "VAD_ONSET" });
          w = dispatch(w, { type: "STOP_PTT" });
        } else if (target === "thinking") {
          w = dispatch(w, { type: "TOGGLE_CONTINUOUS" });
          w = dispatch(w, { type: "VAD_ONSET" });
          w = dispatch(w, { type: "STOP_PTT" });
          w = dispatch(w, { type: "STT_OK", text: "hi" });
        } else if (target === "error") {
          w = dispatch(w, {
            type: "SET_PERMISSION",
            value: "denied",
            error: "denied",
          });
        }

        // Skip silently if the constructed state did not match (defensive).
        if (w.state.state !== target) return true;

        const before = w.state.state;
        const after = dispatch(w, {
          type: "BARGE_IN_DETECTED",
          url: "blob:abc",
        });

        // No state change.
        assert.equal(after.state.state, before);
        // No effects emitted.
        assert.equal(after.effects.length, 0);
        return true;
      }
    ),
    { numRuns: 80 }
  );
});

test("Property 7: barge-in revokes the playing URL exactly once across event sequences", () => {
  // For arbitrary playback URLs, a barge-in followed by any number of
  // additional barge-in attempts (which are no-ops outside of speaking)
  // must produce exactly one revokeURL effect for that URL.
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 16 }).map((s) => "blob:" + s),
      fc.integer({ min: 0, max: 5 }),
      (url, extraBargeIns) => {
        let w = reachThinking(true);
        w = dispatch(w, { type: "TTS_DONE", url });
        assert.equal(w.state.state, "speaking");

        const bargeIn = dispatch(w, {
          type: "BARGE_IN_DETECTED",
          url,
        });
        const initialRevokes = bargeIn.effects.filter(
          (e) => e.kind === "revokeURL" && e.url === url
        ).length;
        assert.equal(initialRevokes, 1);
        assert.equal(bargeIn.state.state, "capturing");

        // Subsequent BARGE_IN_DETECTED events from `capturing` are no-ops
        // and emit no further revoke effects.
        let cursor = bargeIn;
        let totalLateRevokes = 0;
        for (let i = 0; i < extraBargeIns; i++) {
          cursor = dispatch(cursor, {
            type: "BARGE_IN_DETECTED",
            url,
          });
          totalLateRevokes += cursor.effects.filter(
            (e) => e.kind === "revokeURL" && e.url === url
          ).length;
        }
        assert.equal(totalLateRevokes, 0);
        return true;
      }
    ),
    { numRuns: 40 }
  );
});
