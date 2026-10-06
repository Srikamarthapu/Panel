// tests/property/voice-completion-length.test.js
//
// T-0010 Law 8 ("complete thoughts"): the reducer's SPEAK_COMPLETION must hand
// the FULL answer to TTS, not clip it at the generic 500-char TEXT_LIMIT that
// amputated long tool-backed replies. The transcript entry stays capped for
// display, but the SPOKEN (callTTS) text carries the full reply up to the
// completion ceiling.

import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { reducer, initialWrapper } from "../../components/voice/voiceMachine.js";

import { MAX_SPOKEN_TEXT, MAX_ASSISTANT_TEXT, spokenExcerpt } from "../../lib/conversation-limits.js";
const COMPLETION_TEXT_LIMIT = MAX_SPOKEN_TEXT;
const DISPLAY_LIMIT = MAX_ASSISTANT_TEXT;

function idleGranted() {
  // idle + permission granted + autoSpeak on (default config) — a rest state
  // where a completion may be spoken.
  return reducer(initialWrapper, { type: "SET_PERMISSION", value: "granted" });
}

test("Law 8: an 800-char completion is spoken IN FULL (not clipped at 500)", () => {
  const w0 = idleGranted();
  const answer =
    "Here is the full rundown. " + "You have a meeting. ".repeat(40); // ~820 chars
  assert.ok(answer.length > 500);
  const w1 = reducer(w0, {
    type: "SPEAK_COMPLETION",
    text: answer,
    entryId: "completion-run-1:complete",
  });
  const tts = w1.effects.find((e) => e.kind === "callTTS");
  assert.ok(tts, "SPEAK_COMPLETION from a rest state emits callTTS");
  assert.ok(
    tts.text.length > 500,
    `spoken text must exceed the old 500-char cap, got ${tts.text.length}`,
  );
  assert.equal(tts.text.length, answer.length, "the whole answer is spoken");
});

test("Law 8: spoken completion is capped only at the large completion ceiling", () => {
  const w0 = idleGranted();
  const answer = "A complete sentence. ".repeat(1200);
  const w1 = reducer(w0, {
    type: "SPEAK_COMPLETION",
    text: answer,
    entryId: "completion-run-2:complete",
  });
  const tts = w1.effects.find((e) => e.kind === "callTTS");
  assert.ok(tts);
  assert.ok(
    tts.text.length <= COMPLETION_TEXT_LIMIT,
    "the completion ceiling still bounds truly runaway output",
  );
  assert.ok(
    w1.state.transcript.at(-1).text.length > tts.text.length,
    "the full answer remains visible beyond the spoken excerpt",
  );
});

test("Law 8 (property): spoken length == min(answer, ceiling), transcript entry ≤ display cap", () => {
  // Printable-ASCII words only, so the reducer's control-char sanitize is a
  // no-op and lengths compare cleanly.
  const word = fc.stringMatching(/^[a-zA-Z]{1,8}$/);
  const answerArb = fc
    .array(word, { minLength: 1, maxLength: 500 })
    .map((words) => words.join(" "));
  fc.assert(
    fc.property(answerArb, (answer) => {
      if (!answer.trim()) return true;
      const w0 = idleGranted();
      const w1 = reducer(w0, {
        type: "SPEAK_COMPLETION",
        text: answer,
        entryId: "completion-x",
      });
      const tts = w1.effects.find((e) => e.kind === "callTTS");
      // A rest state with autoSpeak on always speaks.
      assert.ok(tts, "should speak from idle+granted");
      const expected = spokenExcerpt(answer).length;
      assert.ok(
        Math.abs(tts.text.length - expected) <= 2,
        `spoken length ${tts.text.length} ~ expected ${expected}`,
      );
      // The appended transcript entry is display-capped.
      const entry = w1.state.transcript[w1.state.transcript.length - 1];
      assert.ok(entry.role === "hermes");
      assert.ok(
        entry.text.length <= DISPLAY_LIMIT,
        `transcript entry ${entry.text.length} must stay ≤ ${DISPLAY_LIMIT}`,
      );
      return true;
    }),
    { numRuns: 150 },
  );
});
