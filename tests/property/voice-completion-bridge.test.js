// tests/property/voice-completion-bridge.test.js
//
// Property tests for the T-0008 completion-speech bridge (fix B). Two pure
// units under test, both in components/voice/voiceMachine.js:
//   * selectSpeakableCompletion — picks the next completion event to speak,
//     applying dedupe, history-skip, session-scope, and finish-order.
//   * SPEAK_COMPLETION reducer action — hold/skip/speak precedence.
//
// Both are pure ESM so we exercise them directly, no DOM.

import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  reducer,
  initialWrapper,
  isSpeakableCompletion,
  selectSpeakableCompletion,
  canSpeakCompletionNow,
} from "../../components/voice/voiceMachine.js";

function dispatch(wrapper, event) {
  return reducer(wrapper, event);
}

const BASE = Date.parse("2026-07-05T12:00:00.000Z");

// A completion-shaped event at `offsetMs` after BASE.
function completion(id, { offsetMs = 0, source = "voice/action", state = "complete", summary = "done", sessionId = "s1" } = {}) {
  return {
    id,
    sessionId,
    source,
    state,
    summary,
    updatedAt: new Date(BASE + offsetMs).toISOString(),
  };
}

// -------------------------------------------------------------------------
// Selector: shape predicate
// -------------------------------------------------------------------------

test("isSpeakableCompletion only accepts finished voice-lane completions with text", () => {
  assert.equal(isSpeakableCompletion(completion("a")), true);
  assert.equal(isSpeakableCompletion(completion("a", { source: "voice/data" })), true);
  assert.equal(isSpeakableCompletion(completion("a", { state: "error" })), true);
  // Rejections:
  assert.equal(isSpeakableCompletion(completion("a", { source: "voice/reply" })), false); // transcript-correction channel, not a completion
  assert.equal(isSpeakableCompletion(completion("a", { source: "hermes/tool" })), false);
  assert.equal(isSpeakableCompletion(completion("a", { state: "active" })), false);
  assert.equal(isSpeakableCompletion(completion("a", { state: "queued" })), false);
  assert.equal(isSpeakableCompletion(completion("a", { summary: "  " })), false);
  assert.equal(isSpeakableCompletion({ id: "", source: "voice/data", state: "complete", summary: "x" }), false);
  assert.equal(isSpeakableCompletion(null), false);
});

// -------------------------------------------------------------------------
// Selector: dedupe — a spoken id is never re-selected
// -------------------------------------------------------------------------

test("selectSpeakableCompletion never returns an already-spoken id", () => {
  fc.assert(
    fc.property(
      fc.array(fc.string({ minLength: 1, maxLength: 6 }), { minLength: 0, maxLength: 8 }),
      fc.array(fc.string({ minLength: 1, maxLength: 6 }), { minLength: 0, maxLength: 8 }),
      (ids, spokenList) => {
        // Unique ids so we can reason about membership.
        const uniqueIds = Array.from(new Set(ids));
        const events = uniqueIds.map((id, i) => completion(id, { offsetMs: i }));
        const spokenIds = new Set(spokenList);
        const picked = selectSpeakableCompletion(events, {
          spokenIds,
          pageLoadedAt: BASE - 1000,
        });
        if (picked === null) return true;
        return !spokenIds.has(picked.id);
      },
    ),
    { numRuns: 200 },
  );
});

// -------------------------------------------------------------------------
// Selector: history-skip — events strictly before page load never spoken
// -------------------------------------------------------------------------

test("selectSpeakableCompletion never selects an event created before page load", () => {
  fc.assert(
    fc.property(
      fc.array(fc.integer({ min: -5000, max: 5000 }), { minLength: 1, maxLength: 10 }),
      fc.integer({ min: -3000, max: 3000 }),
      (offsets, loadOffset) => {
        const events = offsets.map((off, i) => completion(`e${i}`, { offsetMs: off }));
        const pageLoadedAt = BASE + loadOffset;
        const picked = selectSpeakableCompletion(events, {
          spokenIds: new Set(),
          pageLoadedAt,
        });
        if (picked === null) return true;
        // The picked event's timestamp is at/after page load.
        return Date.parse(picked.updatedAt) >= pageLoadedAt;
      },
    ),
    { numRuns: 200 },
  );
});

// -------------------------------------------------------------------------
// Selector: finish-order — oldest eligible completion is returned first
// -------------------------------------------------------------------------

test("selectSpeakableCompletion returns the oldest unspoken completion first", () => {
  const events = [
    completion("c", { offsetMs: 300 }),
    completion("a", { offsetMs: 100 }),
    completion("b", { offsetMs: 200 }),
  ];
  const picked = selectSpeakableCompletion(events, { spokenIds: new Set(), pageLoadedAt: BASE });
  assert.equal(picked.id, "a");
  // After a is spoken, b is next.
  const next = selectSpeakableCompletion(events, { spokenIds: new Set(["a"]), pageLoadedAt: BASE });
  assert.equal(next.id, "b");
});

test("selectSpeakableCompletion honors sessionId scoping", () => {
  const events = [
    completion("mine", { offsetMs: 100, sessionId: "s1" }),
    completion("theirs", { offsetMs: 50, sessionId: "s2" }),
  ];
  const picked = selectSpeakableCompletion(events, {
    spokenIds: new Set(),
    pageLoadedAt: BASE,
    sessionId: "s1",
  });
  assert.equal(picked.id, "mine");
});

// -------------------------------------------------------------------------
// Reducer SPEAK_COMPLETION: hold / skip / speak precedence
// -------------------------------------------------------------------------

const HOLD_STATES = ["capturing", "transcribing", "thinking", "speaking"];
const REST_STATES = ["idle", "listening"];

function wrapperInState(state, configOverrides = {}) {
  const w = initialWrapper;
  return {
    state: {
      ...w.state,
      state,
      config: { ...w.state.config, autoSpeak: true, muteOutput: false, ...configOverrides },
    },
    effects: [],
  };
}

test("SPEAK_COMPLETION holds (no state change, no effects) while mid-interaction", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...HOLD_STATES),
      fc.string({ minLength: 1, maxLength: 40 }),
      (state, text) => {
        const before = wrapperInState(state);
        const after = dispatch(before, { type: "SPEAK_COMPLETION", text, entryId: "run-1" });
        // Held: state unchanged, no transcript write, no effects.
        return (
          after.state.state === state &&
          after.state.transcript === before.state.transcript &&
          after.effects.length === 0
        );
      },
    ),
    { numRuns: 100 },
  );
});

test("SPEAK_COMPLETION speaks from a rest state: appends transcript + emits callTTS", () => {
  for (const state of REST_STATES) {
    const before = wrapperInState(state);
    const after = dispatch(before, { type: "SPEAK_COMPLETION", text: "Your calendar is clear today.", entryId: "run-1" });
    assert.equal(after.state.state, "thinking", `should move to thinking from ${state}`);
    assert.equal(after.state.transcript.length, 1);
    const entry = after.state.transcript[0];
    assert.equal(entry.role, "hermes");
    assert.equal(entry.text, "Your calendar is clear today.");
    assert.equal(entry.id, "run-1");
    assert.deepEqual(after.effects, [{ kind: "callTTS", text: "Your calendar is clear today." }]);
  }
});

test("SPEAK_COMPLETION preserves the answer silently when autoSpeak is off or output muted", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...REST_STATES),
      fc.oneof(
        fc.constant({ autoSpeak: false }),
        fc.constant({ muteOutput: true }),
        fc.constant({ autoSpeak: false, muteOutput: true }),
      ),
      (state, cfg) => {
        const before = wrapperInState(state, cfg);
        const after = dispatch(before, { type: "SPEAK_COMPLETION", text: "hi", entryId: "r" });
        // The answer remains readable without synthesizing audio.
        return (
          after.effects.length === 0 &&
          after.state.transcript.at(-1)?.text === "hi"
        );
      },
    ),
    { numRuns: 100 },
  );
});

test("SPEAK_COMPLETION ignores blank text", () => {
  const before = wrapperInState("idle");
  const after = dispatch(before, { type: "SPEAK_COMPLETION", text: "   ", entryId: "r" });
  assert.equal(after.state.transcript, before.state.transcript);
  assert.equal(after.effects.length, 0);
});

test("canSpeakCompletionNow is true only from rest states", () => {
  for (const s of REST_STATES) assert.equal(canSpeakCompletionNow(s), true);
  for (const s of HOLD_STATES) assert.equal(canSpeakCompletionNow(s), false);
});

test("starting microphone holds completions", () => {
  assert.equal(canSpeakCompletionNow("starting"), false);
});
