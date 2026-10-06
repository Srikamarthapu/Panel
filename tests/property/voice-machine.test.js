// tests/property/voice-machine.test.js
//
// Property tests for components/voice/voiceMachine.js. The reducer is a pure
// ESM module so we can exercise it directly without a DOM or mocks.
//
// Validates:
//   - Property 4  (Voice_Dock state-driven controls + caption invariant +
//                  settings-disclosure isolation)
//   - Property 5  (Toggle-event side-effect isolation)
//   - Property 6  (Permission-flow invariant)
//   - Property 13 (STT/Chat error rendering invariant)
//   - Property 14 (Cancel-in-flight / STOP_PTT effect contract)

import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  reducer,
  initialWrapper,
  initial,
  captionFor,
  isCaptionSafe,
  defaultVoiceConfig,
} from "../../components/voice/voiceMachine.js";

function dispatch(wrapper, event) {
  return reducer(wrapper, event);
}

const VOICE_STATES = [
  "idle",
  "starting",
  "listening",
  "capturing",
  "transcribing",
  "thinking",
  "speaking",
  "error",
];

// -------------------------------------------------------------------------
// Property 4 — caption invariant for every reachable state
// -------------------------------------------------------------------------

test("Property 4: every voice state's caption obeys ≤40 chars + no banned pronouns", () => {
  // **Validates: Requirements 3.5**
  for (const v of VOICE_STATES) {
    const c = captionFor(v);
    assert.ok(
      isCaptionSafe(c),
      `caption for ${v} unsafe: ${JSON.stringify(c)}`,
    );
  }
  // The reducer also produces these two override captions:
  const pending = "Waiting for microphone permission";
  const denied = "Microphone blocked. Press Retry.";
  assert.ok(isCaptionSafe(pending), `pending caption unsafe: ${pending}`);
  assert.ok(isCaptionSafe(denied), `denied caption unsafe: ${denied}`);
  // initialWrapper.state.caption matches the safe rule.
  assert.ok(isCaptionSafe(initial.caption));
});

// -------------------------------------------------------------------------
// Property 4 — settings disclosure does not perturb voice state when active
// -------------------------------------------------------------------------

// Drives the reducer to a target voice state via a deterministic event path.
function reachActiveState(target) {
  let w = initialWrapper;
  w = dispatch(w, { type: "SET_PERMISSION", value: "granted" });
  w = dispatch(w, { type: "TOGGLE_CONTINUOUS" }); // -> listening
  w = dispatch(w, { type: "MIC_READY" });
  if (target === "listening") return w;
  w = dispatch(w, { type: "VAD_ONSET" }); // listening -> capturing
  w = dispatch(w, { type: "RECORDER_STARTED" });
  if (target === "capturing") return w;
  w = dispatch(w, { type: "STOP_PTT" }); // capturing -> transcribing
  if (target === "transcribing") return w;
  w = dispatch(w, { type: "STT_OK", text: "hello" }); // -> thinking
  if (target === "thinking") return w;
  w = dispatch(w, { type: "CHAT_OK", response: "world" }); // stays thinking, callTTS
  w = dispatch(w, { type: "TTS_DONE", url: "blob:fake" }); // -> speaking
  if (target === "speaking") return w;
  throw new Error(`unsupported target: ${target}`);
}

test("Property 4: settings disclosure events do not perturb active voice state", () => {
  // **Validates: Requirements 3.12, 3.5**
  const ACTIVE = ["listening", "capturing", "transcribing", "thinking", "speaking"];

  fc.assert(
    fc.property(
      fc.constantFrom(...ACTIVE),
      fc.array(
        fc.oneof(
          fc.record({ type: fc.constant("OPEN_SETTINGS") }),
          fc.record({ type: fc.constant("CLOSE_SETTINGS") }),
          fc.record({
            type: fc.constant("UPDATE_CONFIG"),
            partial: fc.record(
              {
                ttsRate: fc.constantFrom("+0%", "+10%", "-5%"),
                ttsVoice: fc.constantFrom(
                  "en-US-AriaNeural",
                  "en-US-GuyNeural",
                ),
                autoSpeak: fc.boolean(),
              },
              { requiredKeys: [] },
            ),
          }),
        ),
        { minLength: 1, maxLength: 30 },
      ),
      (target, events) => {
        const baseline = reachActiveState(target);
        const beforeState = baseline.state.state;
        const beforeContinuous = baseline.state.continuousRequested;
        const beforePermission = baseline.state.permission;
        const beforeTranscript = baseline.state.transcript;
        const beforeVoices = baseline.state.voices;

        let cur = baseline;
        for (const ev of events) cur = dispatch(cur, ev);

        // Voice state is byte-equal before/after settings disclosure events.
        if (cur.state.state !== beforeState) return false;
        if (cur.state.continuousRequested !== beforeContinuous) return false;
        if (cur.state.permission !== beforePermission) return false;
        // Transcript reference unchanged (no transcript writes from these events).
        if (cur.state.transcript !== beforeTranscript) return false;
        if (cur.state.voices !== beforeVoices) return false;
        return true;
      },
    ),
    { numRuns: 100 },
  );
});

// -------------------------------------------------------------------------
// Property 5 — TOGGLE_CONTINUOUS isolation
// -------------------------------------------------------------------------

test("Property 5: TOGGLE_CONTINUOUS only flips continuousRequested-related state", () => {
  // **Validates: Requirements 3.7, 3.12**
  // Set up a non-trivial baseline: granted permission, hydrated voices,
  // mutated config, settings open.
  let w = dispatch(initialWrapper, { type: "SET_PERMISSION", value: "granted" });
  w = dispatch(w, { type: "LOAD_VOICES", voices: [{ name: "v1" }, { name: "v2" }] });
  w = dispatch(w, { type: "UPDATE_CONFIG", partial: { ttsRate: "+10%" } });
  w = dispatch(w, { type: "OPEN_SETTINGS" });

  assert.equal(w.state.state, "idle");
  assert.equal(w.state.continuousRequested, false);

  const before = w.state;

  // Forward toggle: idle -> listening with continuousRequested = true.
  const starting = dispatch(w, { type: "TOGGLE_CONTINUOUS" });
  assert.equal(starting.state.state, "starting");
  assert.ok(starting.effects.some((e) => e.kind === "syncContinuous" && e.on === true));
  const w2 = dispatch(starting, { type: "MIC_READY" });
  assert.equal(w2.state.state, "listening");
  assert.equal(w2.state.continuousRequested, true);
  // Side-effect channels not touched by the toggle:
  assert.equal(w2.state.transcript, before.transcript);
  assert.deepEqual(w2.state.config, before.config);
  assert.equal(w2.state.voices, before.voices);
  assert.equal(w2.state.permission, before.permission);
  assert.equal(w2.state.settingsOpen, before.settingsOpen);
  assert.equal(w2.state.serverStatus, before.serverStatus);
  // syncContinuous(on:true) must be emitted.

  // Reverse toggle from an active state — should tear down to idle and emit
  // syncContinuous(on:false) without touching transcript/config/voices.
  const w3 = dispatch(w2, { type: "TOGGLE_CONTINUOUS" });
  assert.equal(w3.state.state, "idle");
  assert.equal(w3.state.continuousRequested, false);
  assert.equal(w3.state.transcript, before.transcript);
  assert.deepEqual(w3.state.config, before.config);
  assert.equal(w3.state.voices, before.voices);
  assert.equal(w3.state.permission, before.permission);
  assert.equal(w3.state.settingsOpen, before.settingsOpen);
  assert.ok(
    w3.effects.some((e) => e.kind === "syncContinuous" && e.on === false),
    `expected syncContinuous(on:false), got ${JSON.stringify(w3.effects)}`,
  );
});

// -------------------------------------------------------------------------
// Property 6 — Permission flow invariant
// -------------------------------------------------------------------------

test("Property 6: N consecutive denials hold error; grant routes by continuousRequested", () => {
  // **Validates: Requirements 3.8, 3.9**
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 10 }),
      fc.boolean(),
      (n, continuous) => {
        let w = initialWrapper;
        if (continuous) {
          w = dispatch(w, { type: "TOGGLE_CONTINUOUS" });
          // From idle without permission, the toggle only flips the flag and
          // requests permission — voice state stays idle until permission is
          // granted.
          if (w.state.continuousRequested !== true) return false;
        }

        for (let i = 0; i < n; i++) {
          w = dispatch(w, {
            type: "SET_PERMISSION",
            value: "denied",
            error: "blocked",
          });
          if (w.state.state !== "error") return false;
          if (w.state.permission !== "denied") return false;
        }

        // Grant: continuous→listening with syncContinuous; otherwise→idle
        // (or stay idle when n==0 and we never entered error).
        w = dispatch(w, { type: "SET_PERMISSION", value: "granted" });
        const grantEffects = w.effects;
        if (continuous) w = dispatch(w, { type: "MIC_READY" });
        const expected = continuous ? "listening" : "idle";
        if (w.state.state !== expected) return false;
        if (w.state.permission !== "granted") return false;

        if (continuous) {
          if (
            !grantEffects.some(
              (e) => e.kind === "syncContinuous" && e.on === true,
            )
          ) {
            return false;
          }
        }
        return true;
      },
    ),
    { numRuns: 200 },
  );
});

// -------------------------------------------------------------------------
// Property 13 — STT/Chat error rendering invariant
// -------------------------------------------------------------------------

test("STT failures expose a bounded retryable error without inventing a transcript message", () => {
  // **Validates: Requirements 5.6, 5.10**
  fc.assert(
    fc.property(
      fc.string({ minLength: 0, maxLength: 2000 }),
      fc.boolean(),
      (errStr, continuous) => {
        let w = dispatch(initialWrapper, {
          type: "SET_PERMISSION",
          value: "granted",
        });
        if (continuous) {
          w = dispatch(w, { type: "TOGGLE_CONTINUOUS" }); // -> listening
          w = dispatch(w, { type: "VAD_ONSET" }); // listening -> capturing
        } else {
          w = dispatch(w, { type: "START_PTT" }); // idle -> capturing
        }
        w = dispatch(w, { type: "STOP_PTT" }); // capturing -> transcribing
        w = dispatch(w, { type: "STT_FAILED", error: errStr });

        const expectedState = continuous ? "listening" : "idle";
        if (w.state.state !== expectedState) return false;

        if (w.state.transcript.length !== 0) return false;
        if (w.state.lastError.stage !== "stt") return false;
        if (w.state.lastError.message.length > 500) return false;
        if (w.state.lastError.retryable !== true) return false;
        return true;
      },
    ),
    { numRuns: 75 },
  );
});

test("Property 13: CHAT_FAILED with no error/details falls back to 'Chat error'", () => {
  // **Validates: Requirements 5.7, 5.10**
  let w = dispatch(initialWrapper, { type: "SET_PERMISSION", value: "granted" });
  w = dispatch(w, { type: "START_PTT" });
  w = dispatch(w, { type: "STOP_PTT" });
  w = dispatch(w, { type: "STT_OK", text: "hi" });
  w = dispatch(w, { type: "CHAT_FAILED" });
  const last = w.state.transcript[w.state.transcript.length - 1];
  assert.ok(last);
  assert.equal(last.role, "user");
  assert.equal(w.state.lastError.message, "Chat error");
  assert.equal(w.state.lastError.stage, "chat");
});

test("Property 13: CHAT_OK with no response field never emits callTTS", () => {
  // **Validates: Requirements 5.7**
  fc.assert(
    fc.property(
      // Try empty, missing, whitespace-only, and null/undefined responses.
      fc.oneof(
        fc.constant(undefined),
        fc.constant(null),
        fc.constant(""),
        fc.constantFrom(" ", "\t", "\n", "   "),
      ),
      fc.boolean(),
      (response, continuous) => {
        let w = dispatch(initialWrapper, {
          type: "SET_PERMISSION",
          value: "granted",
        });
        if (continuous) {
          w = dispatch(w, { type: "TOGGLE_CONTINUOUS" });
          w = dispatch(w, { type: "VAD_ONSET" });
        } else {
          w = dispatch(w, { type: "START_PTT" });
        }
        w = dispatch(w, { type: "STOP_PTT" });
        w = dispatch(w, { type: "STT_OK", text: "hi" });

        const event =
          response === undefined ? { type: "CHAT_OK" } : { type: "CHAT_OK", response };
        const next = dispatch(w, event);

        if (next.effects.some((e) => e.kind === "callTTS")) return false;
        const expectedState = continuous ? "listening" : "idle";
        if (next.state.state !== expectedState) return false;
        return true;
      },
    ),
    { numRuns: 50 },
  );
});

// -------------------------------------------------------------------------
// Property 14 — STOP_PTT effect contract
// -------------------------------------------------------------------------

test("Property 14: STOP_PTT from capturing emits stopRecorder + callSTT", () => {
  // **Validates: Requirements 5.6, 5.9**
  // Both the PTT path (continuousRequested=false) and the VAD-silence path
  // (continuousRequested=true) drive the same transcribing transition.
  for (const continuous of [false, true]) {
    let w = dispatch(initialWrapper, {
      type: "SET_PERMISSION",
      value: "granted",
    });
    if (continuous) {
      w = dispatch(w, { type: "TOGGLE_CONTINUOUS" });
      w = dispatch(w, { type: "MIC_READY" });
      w = dispatch(w, { type: "VAD_ONSET" });
    } else {
      w = dispatch(w, { type: "START_PTT" });
    }
    w = dispatch(w, { type: "RECORDER_STARTED" });
    assert.equal(w.state.state, "capturing");

    w = dispatch(w, { type: "STOP_PTT" });
    assert.equal(w.state.state, "transcribing");

    const kinds = w.effects.map((e) => e.kind);
    assert.ok(
      kinds.includes("stopRecorder"),
      `missing stopRecorder for continuous=${continuous}: ${JSON.stringify(w.effects)}`,
    );
    assert.ok(
      kinds.includes("callSTT"),
      `missing callSTT for continuous=${continuous}: ${JSON.stringify(w.effects)}`,
    );
    // stopRecorder for STOP_PTT keeps the buffer (discard:false) so STT can
    // consume it.
    const stop = w.effects.find((e) => e.kind === "stopRecorder");
    assert.equal(stop.discard, false);
  }
});

test("Property 14: STOP_PTT outside capturing is a no-op", () => {
  // **Validates: Requirements 5.6, 5.9**
  // From idle, STOP_PTT must not emit stopRecorder / callSTT.
  const w = dispatch(initialWrapper, { type: "STOP_PTT" });
  assert.equal(w.state.state, "idle");
  assert.deepEqual(w.effects, []);
});

// -------------------------------------------------------------------------
// T-0006 fast path — CHAT_OK audioUrl branch (thinking -> speaking + playAudio)
// -------------------------------------------------------------------------

test("T-0006: CHAT_OK with audioUrl transitions thinking->speaking and emits playAudio", () => {
  // The streaming fast path returns the audio inline, so CHAT_OK carries an
  // audioUrl. That branch must NOT call callTTS again — it must go straight to
  // speaking and play the already-streaming audio. Model-based: any non-empty
  // reply + any non-empty url reaches the same contract.
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0),
      fc.boolean(),
      (reply, continuous) => {
        // Reach thinking via the deterministic path, honoring continuous mode.
        let w = dispatch(initialWrapper, { type: "SET_PERMISSION", value: "granted" });
        if (continuous) {
          w = dispatch(w, { type: "TOGGLE_CONTINUOUS" });
          w = dispatch(w, { type: "VAD_ONSET" });
        } else {
          w = dispatch(w, { type: "START_PTT" });
        }
        w = dispatch(w, { type: "STOP_PTT" });
        w = dispatch(w, { type: "STT_OK", text: "hi" });
        if (w.state.state !== "thinking") return false;

        const url = "blob:voice-fast-path";
        const next = dispatch(w, { type: "CHAT_OK", response: reply, audioUrl: url });

        // Fast-path contract: speaking, a playAudio effect for that url, and
        // NO callTTS (the audio is already synthesized and streaming).
        if (next.state.state !== "speaking") return false;
        const play = next.effects.find((e) => e.kind === "playAudio");
        if (!play || play.url !== url) return false;
        if (next.effects.some((e) => e.kind === "callTTS")) return false;
        // The reply lands in the transcript as the latest hermes entry.
        const last = next.state.transcript[next.state.transcript.length - 1];
        if (!last || last.role !== "hermes") return false;
        return true;
      },
    ),
    { numRuns: 50 },
  );
});

test("T-0006: CHAT_OK without audioUrl still uses callTTS (thinking stays thinking)", () => {
  // Guard the branch boundary: the non-audio reply path must keep the existing
  // callTTS contract so the audioUrl branch is proven to be the differentiator.
  let w = reachActiveState("thinking");
  const next = dispatch(w, { type: "CHAT_OK", response: "plain reply" });
  assert.equal(next.state.state, "thinking");
  assert.ok(next.effects.some((e) => e.kind === "callTTS"));
  assert.ok(!next.effects.some((e) => e.kind === "playAudio"));
});

// -------------------------------------------------------------------------
// T-0006 fast path — CORRECT_TRANSCRIPT replaces the streaming placeholder
// -------------------------------------------------------------------------

// Mirror the reducer's private sanitize(): strip control chars, redact
// Authorization headers + raw blob markers, cap at 500 chars. No space or
// hyphen stripping — the reducer does not do that.
function expectedSanitized(s) {
  let out = String(s == null ? "" : s);
  out = out.replace(/[\u0000-\u001f\u007f]/g, "");
  out = out.replace(/Authorization:\s*\S+/gi, "[redacted]");
  out = out.replace(/\[Blob:[^\]]+\]/gi, "[redacted]");
  if (out.length > 500) out = out.slice(0, 500);
  return out;
}

test("T-0006: CORRECT_TRANSCRIPT replaces the last hermes entry text in place", () => {
  // The streaming fast path seeds the transcript with a placeholder and later
  // corrects it once the real reply is known. CORRECT_TRANSCRIPT must rewrite
  // exactly the last hermes entry, preserve its id/role/audioUrl, add no
  // effects, and never touch the voice state.
  fc.assert(
    fc.property(
      // Constrain to text whose sanitized form is non-empty (empty
      // corrections are a no-op, exercised separately below).
      fc
        .string({ minLength: 1, maxLength: 300 })
        .filter((s) => expectedSanitized(s).trim().length > 0),
      (realReply) => {
        // Drive to speaking with the placeholder via the audioUrl fast path.
        let w = reachActiveState("thinking");
        const url = "blob:fast";
        w = dispatch(w, { type: "CHAT_OK", response: "Spoken reply.", audioUrl: url });
        if (w.state.state !== "speaking") return false;
        const before = w.state.transcript[w.state.transcript.length - 1];
        const stateBefore = w.state.state;

        const next = dispatch(w, { type: "CORRECT_TRANSCRIPT", text: realReply });

        // No effects, voice state untouched.
        if (next.effects.length !== 0) return false;
        if (next.state.state !== stateBefore) return false;

        const after = next.state.transcript[next.state.transcript.length - 1];
        // Same identity, corrected text (sanitized/truncated to <=500).
        if (after.id !== before.id) return false;
        if (after.role !== "hermes") return false;
        if (after.audioUrl !== before.audioUrl) return false;
        if (after.text !== expectedSanitized(realReply)) return false;
        // Earlier entries (the user turn) are untouched.
        if (next.state.transcript.length !== w.state.transcript.length) return false;
        return true;
      },
    ),
    { numRuns: 50 },
  );
});

test("T-0006: CORRECT_TRANSCRIPT is a no-op with no hermes entry or empty text", () => {
  // No transcript yet -> nothing to correct.
  const empty = dispatch(initialWrapper, { type: "CORRECT_TRANSCRIPT", text: "hello" });
  assert.equal(empty.state.transcript.length, 0);
  assert.deepEqual(empty.effects, []);

  // Empty/whitespace correction text is ignored even when a hermes entry exists.
  let w = reachActiveState("speaking");
  const lastBefore = w.state.transcript[w.state.transcript.length - 1];
  const next = dispatch(w, { type: "CORRECT_TRANSCRIPT", text: "   " });
  const lastAfter = next.state.transcript[next.state.transcript.length - 1];
  assert.equal(lastAfter.text, lastBefore.text);
  assert.deepEqual(next.effects, []);
});

test("T-0006: CORRECT_TRANSCRIPT honors an explicit entryId match", () => {
  // When the correction names a specific transcript entry id, that entry is
  // the one rewritten (not merely the last hermes entry).
  let w = reachActiveState("thinking");
  w = dispatch(w, { type: "CHAT_OK", response: "Spoken reply.", audioUrl: "blob:x" });
  const target = w.state.transcript[w.state.transcript.length - 1];
  const next = dispatch(w, {
    type: "CORRECT_TRANSCRIPT",
    entryId: target.id,
    text: "the corrected words",
  });
  const corrected = next.state.transcript.find((e) => e.id === target.id);
  assert.equal(corrected.text, "the corrected words");
  assert.deepEqual(next.effects, []);
});
