// components/voice/voiceMachine.js
//
// Pure reducer for the Voice_Pipeline state machine described in
// .kiro/specs/mission-control-premium-redesign/design.md ("Voice State Machine").
//
// Module contract:
//   * No React, no DOM, no `Date.now`, no `Math.random`. All output is a pure
//     function of (prevWrapper, event).
//   * Default + named export `reducer(prevWrapper, event) -> nextWrapper`,
//     where `prevWrapper` is `{ state, effects }`.
//   * `state` is the inner Voice_Pipeline view (state, caption, permission,
//     permissionError, transcript, config, voices, serverStatus, settingsOpen,
//     continuousRequested).
//   * `effects` is the list of side-effect descriptors emitted during THIS
//     step only. Effects from the previous call are NOT carried over — the
//     consumer drains them between dispatches.
//
// Caption invariant (Req 3.5): every caption written into `state.caption`
// is at most 40 characters long and contains none of the banned standalone
// pronouns `it|its|they|them|their|theirs`. The `isCaptionSafe` helper makes
// the invariant directly testable.
//
// Side-effect descriptor shapes (kind discriminator + minimal payload):
//   { kind: "startRecorder" }
//   { kind: "stopRecorder", discard: boolean }
//   { kind: "stopAllTracks" }
//   { kind: "closeAudioContext" }
//   { kind: "stopVisualizer" }
//   { kind: "clearVadInterval" }
//   { kind: "callSTT" }
//   { kind: "callChat", text, textOnly?: boolean }
//   { kind: "callTTS", text }
//   { kind: "playAudio", url }
//   { kind: "stopAudio" }
//   { kind: "revokeURL", url }
//   { kind: "requestPermission" }
//   { kind: "syncContinuous", on: boolean }
//   { kind: "appendTranscript", entry }   // reserved; the reducer also
//                                         // mutates state.transcript directly
//   { kind: "emitActivity", activityKind, title, summary, source }
//
// The outer `kind` is the discriminant. The activity kind is carried in
// `activityKind` so it does not clobber the discriminant.

import { normalizeTranscriptEntries, publicReplyText } from "../../lib/publicReply.js";
import { MAX_USER_TEXT, MAX_ASSISTANT_TEXT, MAX_TRANSCRIPT_ENTRIES, spokenExcerpt } from "../../lib/conversation-limits.js";

export const defaultVoiceConfig = Object.freeze({
  ttsVoice: "en-US-AriaNeural",
  ttsRate: "+0%",
  ttsPitch: "+0Hz",
  ttsVolume: "+0%",
  sttLanguage: "en",
  voiceModelProvider: "",
  voiceModel: "",
  voiceReasoningEffort: "low",
  autoSpeak: true,
  micDeviceId: "",
  speakerDeviceId: "",
  muteOutput: false,
});

export const initial = Object.freeze({
  state: "idle",
  caption: "Idle. Press to start.",
  permission: "unknown",
  permissionError: null,
  transcript: [],
  config: defaultVoiceConfig,
  voices: [],
  serverStatus: "checking",
  settingsOpen: false,
  continuousRequested: false,
  lastError: null,
  requestKind: null,
  requestStartedAt: null,
  transcriptHydrated: false,
});

export const initialWrapper = Object.freeze({ state: initial, effects: [] });

// -------------------- caption rules --------------------

const BANNED_PRONOUNS = /\b(it|its|they|them|their|theirs)\b/i;
const MAX_CAPTION_LENGTH = 40;

const CAPTION_BY_STATE = Object.freeze({
  idle: "Idle. Press to start.",
  starting: "Starting microphone.",
  listening: "Listening.",
  capturing: "Capturing speech.",
  transcribing: "Transcribing.",
  thinking: "Hermes is thinking.",
  speaking: "Speaking.",
  error: "Voice error. Press Retry.",
});

const PENDING_CAPTION = "Waiting for microphone permission";
const DENIED_CAPTION = "Microphone blocked. Press Retry.";

/**
 * Public helper: deterministic caption string for a voice state.
 */
export function captionFor(state) {
  return CAPTION_BY_STATE[state] || CAPTION_BY_STATE.idle;
}

/**
 * Public helper: validates that a caption obeys Req 3.5.
 * Returns true when `c` is a string of length ≤ 40 that contains none of the
 * banned standalone pronouns.
 */
export function isCaptionSafe(c) {
  return (
    typeof c === "string" &&
    c.length <= MAX_CAPTION_LENGTH &&
    !BANNED_PRONOUNS.test(c)
  );
}

/**
 * Computes the effective caption for a candidate view, honoring the
 * permission-pending and permission-denied overrides.
 */
function captionForView(view) {
  if (view.permission === "pending") return PENDING_CAPTION;
  if (view.state === "error" && view.permission === "denied") {
    return DENIED_CAPTION;
  }
  return captionFor(view.state);
}

// -------------------- helpers --------------------

const TEXT_LIMIT = 500;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const AUTH_HEADER = /Authorization:\s*\S+/gi;
const BLOB_MARKER = /\[Blob:[^\]]+\]/gi;

/**
 * Sanitizes a free-form error string per Req 5.10 (control chars stripped,
 * Authorization headers and raw blob markers redacted). `limit` caps the
 * length (default 500); the completion path passes a larger limit so a full
 * spoken answer is never truncated mid-sentence (Law 8). Pure: only string ops.
 */
function sanitize(s, limit = TEXT_LIMIT, preserveFormatting = false) {
  let out = String(s == null ? "" : s);
  out = out.replace(preserveFormatting ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g : CONTROL_CHARS, "");
  out = out.replace(AUTH_HEADER, "[redacted]");
  out = out.replace(BLOB_MARKER, "[redacted]");
  if (out.length > limit) out = out.slice(0, limit);
  return out;
}

function restState(continuousRequested) {
  return continuousRequested ? "listening" : "idle";
}

function entryId(view, prefix) {
  let index = view.transcript.length;
  const ids = new Set(view.transcript.map((entry) => entry.id));
  while (ids.has(`${prefix}-${index}`)) index += 1;
  return `${prefix}-${index}`;
}

function makeUserEntry(view, text, opts) {
  const o = opts || {};
  const entry = {
    id: o.id || entryId(view, "user"),
    role: "user",
    text: String(text == null ? "" : text).slice(0, MAX_USER_TEXT),
    time: o.time || "",
  };
  if (o.isError) entry.isError = true;
  return entry;
}

function makeHermesEntry(view, text, opts) {
  const o = opts || {};
  const entry = {
    id: o.id || entryId(view, "hermes"),
    role: "hermes",
    text: publicReplyText(text).slice(0, MAX_ASSISTANT_TEXT),
    time: o.time || "",
  };
  if (o.audioUrl) entry.audioUrl = o.audioUrl;
  if (o.isError) entry.isError = true;
  if (o.pending) entry.pending = true;
  return entry;
}

function appendTranscript(view, entry) {
  if (!entry.text.trim()) return view;
  if (view.transcript.some((existing) => existing.id === entry.id)) return view;
  return { ...view, transcript: view.transcript.concat([entry]).slice(-MAX_TRANSCRIPT_ENTRIES) };
}

/**
 * Returns a new view with the given voice state, recomputing the caption.
 * Optional `overrides` object is merged in before the caption is computed.
 */
function withState(view, voiceState, overrides) {
  const merged = { ...view, ...(overrides || {}), state: voiceState };
  merged.caption = captionForView(merged);
  return merged;
}

function emitActivityEffect(summary) {
  return {
    kind: "emitActivity",
    activityKind: "log",
    title: "Voice",
    summary: sanitize(summary),
    source: "voice",
  };
}

// -------------------- completion-speech bridge (T-0008 fix B) ---------------
//
// Action/data lanes run detached; their real completion lands in the
// voice-activity store keyed by the run's actionId. The client polls that
// store and must speak each completion ONCE. This pure selector picks the
// single next completion event that is eligible to be spoken. All ordering,
// dedupe, and history-skipping decisions live here so they are property
// testable without a DOM.
//
// A completion is speakable when ALL of:
//   * source is a voice completion lane ("voice/action" or "voice/data"),
//   * state is "complete" or "error" (the run finished),
//   * it has a non-empty summary (the text to speak),
//   * its id has not already been spoken (dedupe), and
//   * it was created at/after page load (never recite history on startup).
// When several qualify, the OLDEST unspoken one is returned so completions
// are spoken in the order they finished.

const VOICE_COMPLETION_SOURCES = new Set(["voice/action", "voice/data"]);
const COMPLETION_STATES = new Set(["complete", "error"]);

function completionTimestamp(event) {
  const t = Date.parse(event && event.updatedAt ? event.updatedAt : "");
  return Number.isFinite(t) ? t : 0;
}

/**
 * Public helper: is this activity event a spoken-completion candidate?
 * Pure predicate — no dedupe/history filtering, just the shape check.
 */
export function isSpeakableCompletion(event) {
  return !!(
    event &&
    typeof event === "object" &&
    VOICE_COMPLETION_SOURCES.has(String(event.source || "")) &&
    COMPLETION_STATES.has(String(event.state || "")) &&
    String(event.summary || "").trim() &&
    String(event.id || "").trim()
  );
}

/**
 * Public helper: select the next completion event to speak, or null.
 *
 * @param {object[]} events    activity events (any order)
 * @param {object}   opts
 * @param {Set|object} opts.spokenIds   ids already spoken (Set or {has})
 * @param {number}   opts.pageLoadedAt  epoch ms; events strictly older are skipped
 * @param {string}   [opts.sessionId]   when set, only this session's events qualify
 * @returns {object|null}
 */
export function selectSpeakableCompletion(events, opts = {}) {
  const list = Array.isArray(events) ? events : [];
  const spoken = opts.spokenIds;
  const has = (id) =>
    spoken && typeof spoken.has === "function" ? spoken.has(id) : false;
  const pageLoadedAt = Number.isFinite(opts.pageLoadedAt) ? opts.pageLoadedAt : 0;
  const wantSession = opts.sessionId ? String(opts.sessionId) : null;

  const eligible = list.filter((event) => {
    if (!isSpeakableCompletion(event)) return false;
    if (has(String(event.id))) return false;
    if (completionTimestamp(event) < pageLoadedAt) return false;
    if (wantSession && String(event.sessionId || "") !== wantSession) return false;
    return true;
  });
  if (eligible.length === 0) return null;
  // Oldest-first so completions are spoken in finish order; id breaks ties
  // deterministically.
  eligible.sort((a, b) => {
    const ta = completionTimestamp(a);
    const tb = completionTimestamp(b);
    if (ta !== tb) return ta - tb;
    return String(a.id) < String(b.id) ? -1 : 1;
  });
  return eligible[0];
}

// States in which a queued completion must be HELD (not spoken yet): the user
// is mid-utterance or the assistant is already busy. Speaking only happens
// from idle/listening so a completion never talks over a live interaction.
const COMPLETION_HOLD_STATES = new Set([
  "starting",
  "capturing",
  "transcribing",
  "thinking",
  "speaking",
]);

/**
 * Public helper: may a completion be spoken right now given the voice state?
 * True only from idle/listening (rest states).
 */
export function canSpeakCompletionNow(voiceState) {
  return !COMPLETION_HOLD_STATES.has(String(voiceState || ""));
}

// -------------------- self-recovery decisions (T-0010 Law 9) ---------------
//
// Pure decision helpers for the "server redeployed → refresh my stale bundle"
// flow. The imperative shell owns the actual window.location.reload(); these
// functions decide WHETHER an update exists and WHETHER now is a safe moment,
// so the policy is property-testable without a DOM.

// A reload mid-utterance or mid-speech would drop the user's turn or cut Hermes
// off. Only reload from a true rest state; anything active HOLDS the update.
const RELOAD_UNSAFE_STATES = new Set([
  "starting",
  "capturing",
  "transcribing",
  "thinking",
  "speaking",
]);

/**
 * Is the server on a different build than this client bundle? Only a real,
 * known-vs-known difference counts — unknown/blank ids never trigger a reload
 * (avoids false "update ready" on a dev server or a status blip).
 */
export function isStaleBundle(clientBuildId, serverBuildId) {
  const c = String(clientBuildId == null ? "" : clientBuildId).trim();
  const s = String(serverBuildId == null ? "" : serverBuildId).trim();
  if (!c || !s) return false;
  if (c === "dev" || s === "dev") return false;
  return c !== s;
}

/**
 * Given the current voice state, is NOW a safe moment to reload the bundle?
 * True only from a rest state (idle/listening/error) — never mid-turn.
 */
export function canReloadNow(voiceState) {
  return !RELOAD_UNSAFE_STATES.has(String(voiceState || ""));
}

// -------------------- per-event step --------------------

function step(view, event) {
  switch (event.type) {
    case "HYDRATE_TRANSCRIPT": {
      if (view.transcriptHydrated) return [view, []];
      return [{ ...view, transcriptHydrated: true, transcript: normalizeTranscriptEntries([...(Array.isArray(event.entries) ? event.entries : []), ...view.transcript]) }, []];
    }
    case "CLEAR_ERROR":
      return [{ ...view, lastError: null }, []];
    case "CAPTURE_FAILED": {
      const message = sanitize(event.error) || "Voice capture failed";
      return [withState(view, "error", {
        continuousRequested: false,
        pttRequested: false,
        permission: event.stage === "permission" ? "denied" : view.permission,
        permissionError: event.stage === "permission" ? message : view.permissionError,
        requestPending: false,
        lastError: {
          stage: event.stage || "microphone",
          code: event.code || "CAPTURE_FAILED",
          message,
          retryable: event.retryable !== false,
        },
      }), [
        { kind: "clearVadInterval" },
        { kind: "stopRecorder", discard: true },
        { kind: "stopAllTracks" },
        { kind: "closeAudioContext" },
        emitActivityEffect(`capture error: ${message}`),
      ]];
    }
    case "RECORDER_STARTED":
      if (view.state !== "starting") return [view, []];
      return [withState(view, "capturing", { pttRequested: false }), []];
    case "MIC_READY":
      if (view.state !== "starting" || view.pttRequested || !view.continuousRequested) return [view, []];
      return [withState(view, "listening"), []];
    case "REQUEST_STARTED":
      return [{ ...view, requestKind: event.kind, requestStartedAt: event.at, lastError: null, activeRequestStatus: "Connecting to Hermes" }, []];
    case "REQUEST_PROGRESS":
      return [{ ...view, activeRequestStatus: sanitize(event.label, 160) }, []];
    case "RETRY_STT":
      return [withState(view, "transcribing", { lastError: null }), [{ kind: "callSTT" }]];
    case "RETRY_CHAT":
      return [withState(view, "thinking", { lastError: null }), [{ kind: "callChat", text: event.text, textOnly: event.textOnly, preserveContinuous: event.preserveContinuous }]];
    case "CANCEL_CURRENT":
      return [withState(view, "idle", { continuousRequested: false, pttRequested: false, permission: view.permission === "pending" ? "unknown" : view.permission, lastError: null, requestStartedAt: null, requestPending: false }), event.teardownHandled ? [] : [
        { kind: "cancelRequests" }, { kind: "stopAudio" }, { kind: "clearVadInterval" },
        { kind: "stopRecorder", discard: true }, { kind: "stopAllTracks" },
        { kind: "closeAudioContext" },
      ]];
    // ---------------- settings disclosure (Req 3.12) ----------------
    case "OPEN_SETTINGS": {
      if (view.settingsOpen) return [view, []];
      return [{ ...view, settingsOpen: true }, []];
    }
    case "CLOSE_SETTINGS": {
      if (!view.settingsOpen) return [view, []];
      return [{ ...view, settingsOpen: false }, []];
    }
    case "UPDATE_CONFIG": {
      const partial =
        event.partial && typeof event.partial === "object" ? event.partial : {};
      return [{ ...view, config: { ...view.config, ...partial } }, []];
    }

    // ---------------- voice catalog hydration ----------------
    case "LOAD_VOICES": {
      const voices = Array.isArray(event.voices) ? event.voices.slice() : [];
      return [{ ...view, voices }, []];
    }

    // ---------------- microphone permission flow (Req 3.8/3.9) ----------------
    case "SET_PERMISSION": {
      const value = event.value;
      const isError = value === "denied";
      const next = {
        ...view,
        permission: value,
        permissionError: isError ? sanitize(event.error) || null : null,
      };
      if (value === "granted") {
        if (view.pttRequested) {
          return [withState(next, "starting", { pttRequested: true, lastError: null }), [{ kind: "startRecorder", ptt: true }]];
        }
        if (view.continuousRequested) {
          return [
            withState(next, "starting"),
            [{ kind: "syncContinuous", on: true }],
          ];
        }
        if (view.state === "error") {
          return [withState(next, "idle"), []];
        }
        next.caption = captionForView(next);
        return [next, []];
      }
      if (value === "denied") {
        return [withState(next, "error"), []];
      }
      // "pending" or any other value: refresh caption only.
      next.caption = captionForView(next);
      return [next, []];
    }
    case "RETRY_PERMISSION": {
      // State is intentionally untouched — the imperative shell drives the
      // re-request and dispatches a follow-up SET_PERMISSION event.
      return [view, [{ kind: "requestPermission" }]];
    }

    // ---------------- continuous listening toggle ----------------
    case "TOGGLE_CONTINUOUS": {
      const v = view.state;
      if ((v === "idle" || v === "error") && !view.continuousRequested) {
        const next = { ...view, continuousRequested: true };
        if (view.permission === "granted") {
          return [
            withState(next, "starting"),
            [{ kind: "syncContinuous", on: true }],
          ];
        }
        // Law 2: a press must produce a visible state change within 100ms even
        // when permission is still resolving. We're firing a requestPermission
        // effect this very step, so promote the permission view to "pending"
        // and show the "Waiting for microphone permission" caption immediately
        // — no dead-looking control while getUserMedia is in flight. (The
        // follow-up SET_PERMISSION event carries the real granted/denied.)
        if (next.permission !== "granted") {
          next.permission = "pending";
        }
        next.caption = captionForView(next);
        return [next, [{ kind: "requestPermission" }]];
      }
      // Any active state -> ordered teardown to idle (Req 5.5).
      const next = withState(
        { ...view, continuousRequested: false, pttRequested: false, permission: view.permission === "pending" ? "unknown" : view.permission },
        "idle",
      );
      const effects = [
        { kind: "cancelRequests" },
        { kind: "stopAudio" },
        { kind: "stopRecorder", discard: true },
        { kind: "stopAllTracks" },
        { kind: "closeAudioContext" },
        { kind: "stopVisualizer" },
        { kind: "clearVadInterval" },
        { kind: "syncContinuous", on: false },
      ];
      return [next, event.teardownHandled ? [] : effects];
    }

    // ---------------- push-to-talk ----------------
    case "START_PTT": {
      if (view.pttRequested || !["idle", "listening", "speaking", "error"].includes(view.state)) return [view, []];
      if (view.permission !== "granted") {
        return [{ ...view, pttRequested: true, permission: "pending", caption: PENDING_CAPTION }, [{ kind: "requestPermission" }]];
      }
      return [withState(view, "starting", { pttRequested: true, lastError: null }), [...(view.state === "speaking" ? [{ kind: "stopAudio" }] : []), { kind: "startRecorder", ptt: true }]];
    }
    case "CANCEL_PTT": {
      if (!view.pttRequested && !["starting", "capturing"].includes(view.state)) return [view, []];
      return [withState(view, restState(view.continuousRequested), {
        pttRequested: false,
        permission: view.permission === "pending" && !view.continuousRequested ? "unknown" : view.permission,
      }), event.teardownHandled ? [] : [
        { kind: "stopRecorder", discard: true },
        ...(view.continuousRequested ? [{ kind: "syncContinuous", on: true }] : [
          { kind: "clearVadInterval" }, { kind: "stopAllTracks" }, { kind: "closeAudioContext" },
        ]),
      ]];
    }
    case "STOP_PTT": {
      // Honors both PTT release (continuousRequested === false) and the
      // VAD-silence path in continuous mode (continuousRequested === true).
      if (view.state === "starting") {
        return [withState(view, restState(view.continuousRequested), { pttRequested: false }), event.teardownHandled ? [] : [
          { kind: "stopRecorder", discard: true },
          ...(view.continuousRequested ? [{ kind: "syncContinuous", on: true }] : [{ kind: "cancelRequests" }, { kind: "stopAllTracks" }, { kind: "closeAudioContext" }]),
        ]];
      }
      if (view.state !== "capturing") {
        if (view.pttRequested) return [withState(view, "idle", { pttRequested: false, permission: "unknown" }), event.teardownHandled ? [] : [{ kind: "cancelRequests" }, { kind: "stopAllTracks" }, { kind: "closeAudioContext" }]];
        return [{ ...view, pttRequested: false }, []];
      }
      const next = withState(view, "transcribing");
      const effects = [
        { kind: "stopRecorder", discard: false },
      ];
      // PTT mode: also release the mic stream fully so macOS can flip a
      // Bluetooth headset back to A2DP before TTS plays. Continuous mode
      // keeps the mic open to keep listening.
      if (!view.continuousRequested) {
        effects.push({ kind: "releaseMicForPlayback" });
      }
      effects.push({ kind: "callSTT" });
      return [next, effects];
    }

    // ---------------- VAD onset (state diagram: listening -> capturing) ----
    case "VAD_ONSET": {
      if (view.state !== "listening") return [view, []];
      return [withState(view, "starting"), [{ kind: "startRecorder" }]];
    }
    case "VAD_SPEECH_START": {
      if (view.state !== "listening" || !view.continuousRequested) return [view, []];
      // Continuous speech is buffered by the Silero detector itself, including
      // pre-roll. No MediaRecorder starts here; onSpeechEnd supplies the WAV.
      return [withState(view, "capturing"), []];
    }
    case "VAD_MISFIRE": {
      if (view.state !== "capturing" || !view.continuousRequested) return [view, []];
      return [withState(view, "listening"), []];
    }
    case "VAD_SPEECH_END": {
      if (view.state !== "capturing" || !view.continuousRequested) return [view, []];
      return [withState(view, "transcribing"), [{ kind: "callSTT" }]];
    }

    // ---------------- barge-in (Req 3.10 / 5.8) ----------------
    case "BARGE_IN_DETECTED": {
      if (view.state !== "speaking") return [view, []];
      const effects = [{ kind: "stopAudio" }];
      if (event.url) effects.push({ kind: "revokeURL", url: event.url });
      effects.push({ kind: "startRecorder" });
      return [withState(view, "capturing"), effects];
    }

    // ---------------- STT outcomes ----------------
    case "STT_OK": {
      const text = String(event.text == null ? "" : event.text);
      if (!text.trim()) {
        return [withState(view, restState(view.continuousRequested)), []];
      }
      const truncated = text.slice(0, MAX_USER_TEXT);
      const userEntry = makeUserEntry(view, truncated, {
        id: event.id,
        time: event.time,
      });
      const next = withState(appendTranscript(view, userEntry), "thinking",
        { lastError: null, ...(event.textOnly && !event.preserveContinuous ? { continuousRequested: false } : {}) });
      const effects = [];
      // Switching from an open voice session to typed input must release the
      // microphone; typed replies never silently restart continuous listening.
      if (event.textOnly && view.continuousRequested && !event.preserveContinuous) {
        effects.push(
          { kind: "clearVadInterval" },
          { kind: "stopRecorder", discard: true },
          { kind: "stopAllTracks" },
          { kind: "closeAudioContext" },
          { kind: "syncContinuous", on: false },
        );
      }
      effects.push(event.textOnly
        ? { kind: "callChat", text: truncated, textOnly: true, preserveContinuous: event.preserveContinuous === true }
        : { kind: "callChat", text: truncated });
      return [next, effects];
    }
    case "STT_FAILED": {
      const message = sanitize(event.error) || "STT error";
      const next = withState(
        view,
        restState(view.continuousRequested),
        { lastError: { stage: "stt", message, code: event.code || "STT_UNAVAILABLE", retryable: event.retryable !== false } },
      );
      return [next, [emitActivityEffect(`stt error: ${message}`)]];
    }

    // ---------------- chat outcomes ----------------
    case "CHAT_PENDING":
      return [withState(view, "thinking", { requestPending: true, actionId: event.actionId }), []];
    case "CHAT_OK": {
      const response = publicReplyText(event.response);
      if (!response.trim()) {
        // No response field — Req 5.7: never call /api/voice/tts and fall
        // back to the rest state for the active mode.
        return [
          withState(view, event.textOnly && !event.preserveContinuous ? "idle" : restState(view.continuousRequested)),
          [],
        ];
      }
      const truncated = response.slice(0, MAX_ASSISTANT_TEXT);
      const hermesEntry = makeHermesEntry(view, truncated, {
        id: event.id,
        time: event.time,
        audioUrl: event.textOnly ? undefined : event.audioUrl,
        textOnly: event.textOnly,
        pending: event.pending,
      });
      const transcriptView = event.acknowledgement ? view : appendTranscript(view, hermesEntry);
      if (event.textOnly) {
        return [withState(transcriptView, event.preserveContinuous ? "listening" : "idle", { continuousRequested: event.preserveContinuous ? view.continuousRequested : false }), []];
      }
      if (event.audioUrl) {
        return [
          withState(transcriptView, "speaking"),
          [{ kind: "playAudio", url: event.audioUrl }],
        ];
      }
      // Voice state stays at thinking until TTS_DONE flips it to speaking.
      const merged = transcriptView;
      merged.caption = captionForView(merged);
      if (view.config.autoSpeak === false || view.config.muteOutput === true) {
        return [withState(merged, restState(view.continuousRequested)), []];
      }
      return [merged, [{ kind: "callTTS", text: spokenExcerpt(truncated) }]];
    }
    case "CHAT_FAILED": {
      const combined = `${event.error || ""} ${event.details || ""}`.trim();
      const message = publicReplyText(sanitize(combined)) || "Chat error";
      const next = withState(
        view,
        restState(view.continuousRequested),
        { requestPending: event.code === "CHAT_CONNECTION_LOST" ? view.requestPending : false, lastError: { stage: "chat", message, code: event.code || "CHAT_UNAVAILABLE", retryable: event.retryable === true } },
      );
      return [next, [emitActivityEffect(`chat error: ${message}`)]];
    }

    // ---------------- TTS lifecycle ----------------
    case "TTS_DONE": {
      // Reducer treats TTS_DONE as "audio is ready — begin playback".
      // The shell synthesizes the follow-up TTS_PLAYBACK_ENDED event when
      // the audio element naturally completes.
      if (!event.url) return [view, []];
      return [
        withState(view, "speaking"),
        [{ kind: "playAudio", url: event.url }],
      ];
    }
    case "TTS_PLAYBACK_ENDED": {
      const effects = [];
      if (event.url) effects.push({ kind: "revokeURL", url: event.url });
      return [
        withState(view, restState(view.continuousRequested)),
        effects,
      ];
    }
    case "TTS_FAILED": {
      const reason = sanitize(event.reason) || "tts error";
      const detail =
        event.statusCode != null
          ? `status_${event.statusCode}`
          : reason;
      const summary = `tts ${reason}: ${detail}`;
      const effects = [];
      if (event.url) effects.push({ kind: "revokeURL", url: event.url });
      effects.push({ kind: "stopAudio" });
      effects.push(emitActivityEffect(summary));
      return [
        withState(view, restState(view.continuousRequested), { lastError: { stage: "tts", code: "TTS_UNAVAILABLE", message: "Audio playback failed. Your answer is available in Chat.", retryable: false } }),
        effects,
      ];
    }

    // ---------------- transcript correction (T-0006 fast path) ------------
    // On the streaming-audio fast path the real reply text is only known once
    // the model stream completes — AFTER the audio response headers went out.
    // The route therefore seeds the transcript with a placeholder and later
    // persists the accumulated reply to the voice-activity store; the shell
    // reads it back and dispatches this to replace the placeholder in place.
    // Pure: rewrites at most one transcript entry's text, never touches the
    // voice state, caption, or effects. A no-op when nothing needs correcting.
    case "CORRECT_TRANSCRIPT": {
      const text = publicReplyText(sanitize(event.text, MAX_ASSISTANT_TEXT, true));
      // A blank or whitespace-only correction must never clobber a real reply.
      if (!text.trim()) return [view, []];
      const transcript = view.transcript || [];
      // Prefer an explicit entry id; otherwise correct the last hermes entry.
      let targetIndex = -1;
      if (event.entryId != null) {
        targetIndex = transcript.findIndex((e) => e && e.id === event.entryId);
      }
      if (targetIndex < 0 && event.entryId == null) {
        for (let i = transcript.length - 1; i >= 0; i -= 1) {
          if (transcript[i] && transcript[i].role === "hermes" && !transcript[i].isError) {
            targetIndex = i;
            break;
          }
        }
      }
      if (targetIndex < 0) return [view, []];
      const current = transcript[targetIndex];
      if (current.text === text) return [view, []];
      const nextTranscript = transcript.slice();
      nextTranscript[targetIndex] = { ...current, text, pending: false };
      return [{ ...view, transcript: nextTranscript }, []];
    }

    // ---------------- spoken completion bridge (T-0008 fix B) -------------
    // A detached action/data run finished; the client read its completion out
    // of the activity store and dispatches this to speak the result once.
    // Gated so it never talks over a live interaction:
    //   * HOLD (no-op, view unchanged) when mid-interaction — the shell keeps
    //     the id unspoken and retries on the next idle poll.
    //   * SKIP (no-op) when autoSpeak is off or output is muted — the id IS
    //     marked spoken by the shell so we don't retry forever; the feed
    //     already shows the text.
    //   * SPEAK from idle/listening: append a matching hermes transcript entry
    //     and synthesize via the normal TTS effect (mirrors CHAT_OK w/o audio).
    // The reducer stays pure; the shell owns the spoken-id set + retry timing.
    case "SPEAK_COMPLETION": {
      // Law 8: sanitize with the larger completion ceiling so a full spoken
      // answer isn't amputated at the generic 500-char cap.
      const text = publicReplyText(sanitize(event.text, MAX_ASSISTANT_TEXT, true));
      if (!text.trim()) return [view, []];
      if (event.entryId && view.transcript.some((entry) => entry.id === event.entryId)) return [view, []];
      const finishesCurrent = view.requestPending && (!event.actionId || event.actionId === view.actionId);
      if (event.isError) {
        return [withState(view, finishesCurrent ? restState(view.continuousRequested) : view.state, {
          requestPending: finishesCurrent ? false : view.requestPending,
          lastError: { stage: "chat", code: "RUN_FAILED", message: text, retryable: false },
        }), []];
      }
      // A typed action can finish while a later voice turn is active. Append
      // the result without changing that turn's state or producing audio.
      if (event.textOnly) {
        const entry = makeHermesEntry(view, text, {
          id: event.entryId,
          time: event.time,
          textOnly: true,
        });
        const updated = appendTranscript(view, entry);
        return [finishesCurrent ? withState(updated, "idle", { requestPending: false, requestStartedAt: null, lastError: event.isError ? { stage: "chat", code: "RUN_FAILED", message: text, retryable: false } : null }) : updated, []];
      }
      // Respect autoSpeak / muteOutput: do not synthesize, but the caller
      // treats this as "handled" (marks the id spoken) so it won't loop.
      const cfg = view.config || {};
      if (cfg.autoSpeak === false || cfg.muteOutput === true) {
        const updated = appendTranscript(view, makeHermesEntry(view, text, { id: event.entryId, time: event.time }));
        return [finishesCurrent ? withState(updated, restState(view.continuousRequested), { requestPending: false }) : updated, []];
      }
      // Hold while mid-interaction; the shell will re-dispatch when idle.
      if (!finishesCurrent && !canSpeakCompletionNow(view.state)) {
        return [view, []];
      }
      // Conversation history retains the full answer. Reading aloud has its
      // own limit and explicitly points to Chat when the answer is longer.
      const spoken = spokenExcerpt(text);
      const hermesEntry = makeHermesEntry(view, text, {
        id: event.entryId,
        time: event.time,
      });
      const merged = appendTranscript(view, hermesEntry);
      const next = withState(merged, "thinking", { requestPending: false });
      return [next, [{ kind: "callTTS", text: spoken }]];
    }

    // ---------------- teardown observability (Property 12) ----------------
    case "TEARDOWN_STEP_FAILED": {
      const stepName = sanitize(event.step) || "step";
      const message = sanitize(event.message);
      return [
        view,
        [emitActivityEffect(`teardown ${stepName}: ${message}`)],
      ];
    }

    default:
      return [view, []];
  }
}

// -------------------- public reducer --------------------

/**
 * Wrapper-shaped reducer. Each call returns a fresh `{ state, effects }`
 * wrapper; effects from the previous call are not carried over.
 *
 * @param {{ state: object, effects: object[] }} prevWrapper
 * @param {{ type: string }} event
 * @returns {{ state: object, effects: object[] }}
 */
export function reducer(prevWrapper, event) {
  const view =
    prevWrapper && typeof prevWrapper === "object" && prevWrapper.state
      ? prevWrapper.state
      : initial;
  if (!event || typeof event !== "object" || typeof event.type !== "string") {
    return { state: view, effects: [] };
  }
  const [nextView, effects] = step(view, event);
  return { state: nextView, effects: effects || [] };
}

export default reducer;
