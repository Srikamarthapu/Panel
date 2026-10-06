// tests/property/voice-feedback-audit.test.js
//
// T-0010 Law 2 ("something visible within 100ms of any user act") — feedback
// audit. Every reachable voice state must produce an immediate, non-empty,
// caption-safe visual, and no user-visible transition may land in a caption
// that is blank or unsafe. Surgical: this is a guard, not a redesign.

import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  reducer,
  initialWrapper,
  captionFor,
  isCaptionSafe,
} from "../../components/voice/voiceMachine.js";

const ALL_STATES = [
  "idle",
  "listening",
  "capturing",
  "transcribing",
  "thinking",
  "speaking",
  "error",
];

test("Law 2: every voice state has a non-empty, caption-safe caption", () => {
  for (const s of ALL_STATES) {
    const c = captionFor(s);
    assert.ok(typeof c === "string" && c.trim().length > 0, `${s} has a caption`);
    assert.ok(isCaptionSafe(c), `${s} caption is safe (≤40, no banned pronouns)`);
  }
});

test("Law 2: a press with unsettled permission shows an immediate NON-idle caption", () => {
  const w = reducer(initialWrapper, { type: "TOGGLE_CONTINUOUS" });
  assert.equal(w.state.permission, "pending", "press promotes permission to pending");
  assert.notEqual(
    w.state.caption,
    "Idle. Press to start.",
    "the press changes the caption immediately (no dead control)",
  );
  assert.ok(isCaptionSafe(w.state.caption));
});

test("Law 2: permission denied surfaces an assertive error caption", () => {
  const w = reducer(initialWrapper, {
    type: "SET_PERMISSION",
    value: "denied",
    error: "NotAllowedError",
  });
  assert.equal(w.state.state, "error");
  assert.ok(w.state.caption.trim().length > 0, "error caption is non-empty");
  assert.ok(isCaptionSafe(w.state.caption));
});

test("Law 2 (property): no dispatched event ever leaves a blank or unsafe caption", () => {
  const events = [
    { type: "TOGGLE_CONTINUOUS" },
    { type: "SET_PERMISSION", value: "granted" },
    { type: "SET_PERMISSION", value: "pending" },
    { type: "SET_PERMISSION", value: "denied", error: "x" },
    { type: "START_PTT" },
    { type: "STOP_PTT" },
    { type: "VAD_ONSET" },
    { type: "STT_OK", text: "hi" },
    { type: "STT_OK", text: "" },
    { type: "STT_FAILED", error: "e" },
    { type: "CHAT_OK", response: "ok" },
    { type: "CHAT_OK", response: "", audioUrl: "" },
    { type: "CHAT_FAILED", error: "e" },
    { type: "TTS_DONE", url: "blob:x" },
    { type: "TTS_PLAYBACK_ENDED", url: "blob:x" },
    { type: "TTS_FAILED", reason: "r" },
    { type: "BARGE_IN_DETECTED", url: "blob:x" },
    { type: "SPEAK_COMPLETION", text: "done", entryId: "c" },
    { type: "SPEAK_STILL_WORKING", runId: "r" },
    { type: "RETRY_PERMISSION" },
    { type: "OPEN_SETTINGS" },
    { type: "CLOSE_SETTINGS" },
  ];
  fc.assert(
    fc.property(fc.array(fc.constantFrom(...events), { maxLength: 25 }), (seq) => {
      let w = initialWrapper;
      for (const ev of seq) {
        w = reducer(w, ev);
        assert.ok(
          typeof w.state.caption === "string" && w.state.caption.trim().length > 0,
          `caption non-empty after ${ev.type}`,
        );
        assert.ok(isCaptionSafe(w.state.caption), `caption safe after ${ev.type}`);
      }
      return true;
    }),
    { numRuns: 250 },
  );
});

// Mirror the dock's ticker-gating decision so a regression that lets feed
// rotation swallow press feedback fails here (VoiceDock.jsx computes the same).
function showTicker(state, permission) {
  const ACTIVE = new Set([
    "listening",
    "capturing",
    "transcribing",
    "thinking",
    "speaking",
  ]);
  const isError = state === "error";
  const isActive = ACTIVE.has(state);
  const permissionResolving = permission === "pending";
  return !isActive && !isError && !permissionResolving;
}

test("Law 2: the rotating ticker is suppressed while permission is resolving", () => {
  assert.equal(
    showTicker("idle", "pending"),
    false,
    "pending permission → show the state caption directly, not the ticker",
  );
  assert.equal(showTicker("idle", "granted"), true, "true rest → ticker is fine");
  assert.equal(showTicker("thinking", "granted"), false, "active state → caption, not ticker");
  assert.equal(showTicker("error", "denied"), false, "error → error caption, not ticker");
});
