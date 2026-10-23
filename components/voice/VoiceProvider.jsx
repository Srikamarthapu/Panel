"use client";

// VoiceProvider — owns the entire Voice_Pipeline (state machine + imperative
// shells). Exposes useVoice() context consumed by VoiceDock, MissionOrb, and
// VoiceSettingsPage.
//
// Implements Requirements 3.7, 3.8, 3.10, 3.11, 3.12, 5.1–5.10, 8.4, 8.6,
// 10.2, 10.3, 10.6.
// Implements Properties 5, 6, 7, 11, 12, 13, 14, 15, 23, 32.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { usePathname } from "next/navigation";
import { useReducedMotion } from "motion/react";
import { completionRunId, isTextCompletion, voiceChatRequest } from "./voiceTransport.js";
import { isMicrophoneGenerationEffect, queuedVoiceReducer } from "./voiceEffects.js";
import { createPushToTalkGesture, subscribeNativeVoiceEvent } from "./voiceLifecycle.js";
import { MAX_USER_TEXT, spokenExcerpt } from "@/lib/conversation-limits.js";
import {
  initialWrapper,
  selectSpeakableCompletion,
  canHandleCompletionNow,
  isStaleBundle,
  canReloadNow,
} from "./voiceMachine.js";
import { normalizeTranscriptEntries } from "@/lib/publicReply.js";
import {
  isLiveAudioStream,
  microphoneConstraints,
  createVoiceRecorder,
  recorderFileName,
  VoiceCaptureTimeoutError,
  withCaptureTimeout,
} from "./voiceCapture.js";
import { createContinuousSpeechDetector, preloadContinuousSpeechDetector, pcm16kToWavBlob, vadFrameStatus } from "./voiceVad.js";
import { createNativeToolVoiceFeedbackSelector, isActiveToolProgress, selectEarlyVoiceFeedback, selectProgressVoiceFeedback } from "./voiceFeedback.js";
import { canStreamVoiceFeedback, createVoiceFeedbackHandoff, persistVoiceFeedback, playVoiceFeedbackAudio, prepareVoiceFeedbackAudio, streamVoiceFeedback } from "./voiceFeedbackPlayback.js";
import { createVoiceSessionId, resolveVoiceSessionId, voicePendingRunsKey } from "./voiceSession.js";
import { createAnswerAudioTiming, createAnswerReconnectBackoff, createAnswerSpeechBuffer, readAnswerEvents } from "./voiceAnswerStream.js";
import { canAcceptVoiceCapture, conversationModeForPathname, resolveTextOnlyMode, shouldSuppressVoiceOutput } from "./voiceResponseMode.js";

export const VoiceContext = createContext(null);

export function useVoice() {
  return useContext(VoiceContext);
}

// ---------- constants ----------

const VAD_MIN_UTTERANCE_MS = 250;

// Voice_Pipeline reliability constants per design.md.
const TTS_TIMEOUT_MS = 15000;
const TTS_MIN_BYTES = 256;
const TTS_STALL_MS = 6000;
const VOICE_FEEDBACK_THROTTLE_MS = 8000;
const ACTIVITY_DEDUP_MS = 1000;
const TEXT_LIMIT = 500;
const SERVER_POLL_MS = 15000;
// T-0008 completion-speech bridge: while a detached action/data run is in
// flight for this session we poll the activity store fast so the spoken reply
// doesn't feel dead; otherwise we idle at the slow cadence.
const COMPLETION_POLL_FAST_MS = 2000;
const COMPLETION_POLL_IDLE_MS = 15000;

// T-0010 Law 9 (self-recovery): the build id baked into THIS client bundle.
// The server reports its own build id from /api/voice/status (same
// NEXT_PUBLIC_BUILD_ID). On a mismatch the server was redeployed and this
// bundle is stale, so we reload ourselves at a safe moment — no manual Tauri
// reload. Falls back to "dev" (never triggers a reload) when unset.
const BUILD_ID =
  (typeof process !== "undefined" &&
    process.env &&
    process.env.NEXT_PUBLIC_BUILD_ID) ||
  "dev";
// A pending run older than this is assumed finished/dead — stop fast-polling
// so a lost completion can't pin us to the 2s cadence forever.
const COMPLETION_PENDING_TTL_MS = 30 * 60 * 1000;

// Sanitization patterns per Property 15.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const AUTH_HEADER = /Authorization:\s*\S+/gi;
const BLOB_MARKER = /\[Blob:[^\]]+\]/gi;

// Banned activity-emission patterns are already enforced inside the reducer's
// `sanitize()`. We re-implement here for the imperative shell so summary
// strings constructed at the provider level (which never pass through the
// reducer) obey Property 15 too.
function sanitize(s) {
  let out = String(s == null ? "" : s);
  out = out.replace(CONTROL_CHARS, "");
  out = out.replace(AUTH_HEADER, "[redacted]");
  out = out.replace(BLOB_MARKER, "[redacted]");
  if (out.length > TEXT_LIMIT) out = out.slice(0, TEXT_LIMIT);
  return out;
}

function announceVoiceActivity(event) {
  if (typeof window === "undefined" || !event) return;
  window.dispatchEvent(new CustomEvent("voice-activity", { detail: event }));
}

// ---------- provider ----------

// Managed sessions are immutable for a mount: the parent keys this provider by
// sessionId so switching also tears down every old audio/request resource.
export default function VoiceProvider({ children, testRuntime = null, sessionId = null, initialTranscript = [], serverTranscript = null, initialActiveRun = null }) {
  const managedSessionRef = useRef(typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : null);
  const initialTranscriptRef = useRef(initialTranscript);
  const initialActiveRunRef = useRef(initialActiveRun);
  const pendingRunsStorageKey = voicePendingRunsKey(managedSessionRef.current);
  const runtimeRef = useRef(testRuntime);
  runtimeRef.current = testRuntime;
  const runtimeFetch = useCallback((...args) => (runtimeRef.current?.fetch || globalThis.fetch)(...args), []);
  const runtimeStorage = useCallback(() => runtimeRef.current?.storage || (typeof window !== "undefined" ? window.localStorage : null), []);
  const runtimeMediaDevices = useCallback(() => runtimeRef.current?.mediaDevices || (typeof navigator !== "undefined" ? navigator.mediaDevices : null), []);
  const runtimeAudioContext = useCallback(() => runtimeRef.current?.AudioContext || (typeof window !== "undefined" ? (window.AudioContext || window.webkitAudioContext) : null), []);
  const runtimeMediaRecorder = useCallback(() => runtimeRef.current?.MediaRecorder || (typeof window !== "undefined" ? window.MediaRecorder : null), []);
  const runtimeAudio = useCallback(() => runtimeRef.current?.Audio || (typeof window !== "undefined" ? window.Audio : null), []);
  const runtimeSpeechDetector = useCallback((options) =>
    (runtimeRef.current?.createSpeechDetector || createContinuousSpeechDetector)(options), []);
  const [wrapper, dispatch] = useReducer(queuedVoiceReducer, initialWrapper);
  // Keep the visible conversation available across Talk/Chat navigation and
  // browser restarts. Hermes also resumes its server-side conversation.
  useEffect(() => {
    if (managedSessionRef.current) {
      dispatch({ type: "HYDRATE_TRANSCRIPT", entries: initialTranscriptRef.current });
      return;
    }
    if (typeof window === "undefined") return;
    let stored = [];
    try {
      stored = JSON.parse(runtimeStorage()?.getItem("hermes.voice.transcript") || "[]");
    } catch {
      stored = [];
    }
    dispatch({ type: "HYDRATE_TRANSCRIPT", entries: stored });
  }, []);
  useEffect(() => {
    if (!managedSessionRef.current || !Array.isArray(serverTranscript)) return;
    dispatch({ type: "RECONCILE_SERVER_TRANSCRIPT", entries: serverTranscript });
  }, [serverTranscript]);
  useEffect(() => {
    if (managedSessionRef.current) return; // Server history owns managed sessions.
    if (!wrapper.state.transcriptHydrated || typeof window === "undefined") return;
    try {
      const entries = normalizeTranscriptEntries(wrapper.state.transcript);
      runtimeStorage()?.setItem("hermes.voice.transcript", JSON.stringify(entries));
    } catch {
      /* local storage can be unavailable in private or embedded contexts */
    }
  }, [wrapper.state.transcript, wrapper.state.transcriptHydrated, runtimeStorage]);
  const reduceMotion = useReducedMotion();
  const pathname = usePathname();
  const conversationMode = conversationModeForPathname(pathname);
  const conversationModeRef = useRef(conversationMode);
  conversationModeRef.current = conversationMode;
  const previousConversationModeRef = useRef(conversationMode);
  const voiceInputGenerationRef = useRef(0);
  // Device changes invalidate microphone acquisition without invalidating
  // submitted STT, accepted chat work, or reply playback.
  const microphoneAcquisitionGenerationRef = useRef(0);
  const [serverStatus, setServerStatus] = useState("checking");
  // CHAT_PENDING is optimistic. Detaching a session is safe only after the
  // server has acknowledged this exact immutable run id.
  const [acceptedActionId, setAcceptedActionId] = useState(null);
  const [configSaveStatus, setConfigSaveStatus] = useState("idle");
  const [configSaveError, setConfigSaveError] = useState("");
  const configSaveSequenceRef = useRef(0);
  const configSaveQueueRef = useRef(Promise.resolve());
  // Law 9: set true once the server reports a different build id than this
  // bundle. The dock surfaces a one-tap "Update ready" affordance; when we're
  // at a safe rest moment we also auto-reload. Sticky — once an update exists
  // it stays flagged until the reload happens.
  const [updateReady, setUpdateReady] = useState(false);
  const updateReadyRef = useRef(false);
  updateReadyRef.current = updateReady;

  // Latest committed view — read from inside async callbacks. Updating during
  // render is safe because we only ever read it from event handlers, never as
  // a render input.
  const wrapperRef = useRef(wrapper);
  wrapperRef.current = wrapper;

  // Imperative resource handles.
  const mediaStreamRef = useRef(null);
  // Law 1: the in-gesture getUserMedia promise started by primeAudioStack, so
  // ensureMicAndVad / requestPermission reuse the SAME stream instead of racing
  // a second prompt.
  const pendingStreamPromiseRef = useRef(null);
  // Law 9 (mic-loss recovery): guards so a device disconnect fires the
  // "reconnecting" flow exactly once per loss and we don't stack re-acquire
  // attempts. micTrackHandledRef marks the currently-attached track's ended
  // handler so we don't double-attach across ensure calls.
  const micRecoveringRef = useRef(false);
  const invalidateMicrophoneInputRef = useRef(null);
  const handledTrackIdsRef = useRef(new Set());
  const mediaRecorderRef = useRef(null);
  const recorderStopRef = useRef(null);
  const audioChunksRef = useRef([]);
  const audioContextRef = useRef(null);
  const speechDetectorRef = useRef(null);
  const speechDetectorPromiseRef = useRef(null);
  const speechDetectorReadinessRef = useRef(null);
  const speechDetectorReadyTimerRef = useRef(null);
  const speechDetectorSignalTimerRef = useRef(null);
  const speechDetectorGenerationRef = useRef(0);
  const speechDetectorControlRef = useRef(Promise.resolve());
  const captureSourceRef = useRef(null);
  const captureSubmissionCommittedRef = useRef(false);
  const pttGestureRef = useRef(null);
  if (!pttGestureRef.current) pttGestureRef.current = createPushToTalkGesture();
  // React publishes reducer state after the initiating callback. Keep a
  // synchronous ownership bit so a completion continuation in that small gap
  // cannot mistake the previous idle render for permission to speak.
  const completionInputOwnershipRef = useRef(false);
  if (["starting", "capturing", "transcribing"].includes(wrapper.state.state)) {
    completionInputOwnershipRef.current = true;
  } else if (!pttGestureRef.current.isHeld() && !captureSubmissionCommittedRef.current) {
    completionInputOwnershipRef.current = false;
  }
  const toggleContinuousRef = useRef(null);
  const speechStartedAtRef = useRef(0);
  const discardOnStopRef = useRef(false);
  const latestBlobRef = useRef(null);
  const currentTtsRef = useRef(null);
  const primedPlaybackRef = useRef(null);
  const ttsAbortRef = useRef(null);
  const ttsPrefetchRef = useRef(null);
  const voiceFeedbackRef = useRef(null);
  const preparedVoiceFeedbackRef = useRef(null);
  const voiceStartupAtRef = useRef(0);
  const speechEndedAtRef = useRef(0);
  const finalTtsStartedAtRef = useRef(0);
  const answerAudioTimingRef = useRef(null);
  if (!answerAudioTimingRef.current) answerAudioTimingRef.current = createAnswerAudioTiming();
  const voiceFeedbackCacheRef = useRef(new Map());
  const voicedFeedbackKeysRef = useRef(new Set());
  const lastVoiceFeedbackAtRef = useRef(0);
  const stopVoiceFeedbackRef = useRef(null);
  const retireVoiceFeedbackRef = useRef(null);
  const playToolProgressRef = useRef(null);
  const selectToolProgressRef = useRef(null);
  if (!selectToolProgressRef.current) selectToolProgressRef.current = createNativeToolVoiceFeedbackSelector();
  const sttAbortRef = useRef(null);
  const chatAbortRef = useRef(null);
  const operationEpochRef = useRef(0);
  const operationAbortRef = useRef(new AbortController());
  const lastRequestRef = useRef(null);
  const submissionLockRef = useRef(false);
  const playbackEndedAtRef = useRef(0);
  useEffect(() => {
    if (["idle", "listening", "error"].includes(wrapper.state.state)) submissionLockRef.current = false;
  }, [wrapper.state.state]);
  // Teardown handle for the CURRENTLY playing audio element (T-0009 fix B).
  // playAudio() sets this to a function that clears its stall interval, cancels
  // its MediaSource stream reader, and detaches its listeners. Barge-in and
  // any new turn call it before starting the next clip so the old clip's 250ms
  // stall interval and stream reader don't leak across turns (the barge-in path
  // previously left the interval running, which then fired a spurious
  // TTS_FAILED mid next-turn).
  const currentPlaybackCleanupRef = useRef(null);
  // Streaming handoff: callTTS stashes the in-flight body + MediaSource here
  // so playAudio() can attach a SourceBuffer and pump bytes as they arrive.
  // Cleared by playAudio after attach, by stopAudio on barge-in, and by the
  // unmount cleanup. Buffered (non-stream) playback ignores this entirely.
  const ttsStreamRef = useRef(null);
  const sttMsRef = useRef(null);

  // objectURL bookkeeping per design.md (Property 11). revokedURLs is a
  // dedup guard so a URL is only ever revoked once; it's bounded (T-0009 fix
  // B) so a long session can't grow it without limit — object URLs are minted
  // one-per-turn, and once revoked+dropped the string is never seen again.
  const revokedURLs = useRef(new Set()).current;
  const REVOKED_URL_CAP = 200;

  // Activity-emission dedup map per Req 5.10 / Property 15. Bounded (T-0009
  // fix B): entries older than the dedup window are useless, so we prune them
  // on write instead of letting the map grow one entry per unique summary for
  // the life of the session.
  const recentSummariesRef = useRef(new Map());
  const RECENT_SUMMARIES_CAP = 100;

  // ---------- completion-speech bridge (T-0008 fix B) ----------
  // Page-load epoch: completions created strictly before this are history and
  // are never recited on startup. Set once at mount.
  const pageLoadedAtRef = useRef(Date.now());
  // Ids of completions we've already spoken (or resolved as skip). The pure
  // selector uses this to dedupe; the poller adds to it after handling.
  const spokenCompletionIdsRef = useRef(new Set());
  // Map of pending run actionId -> epoch enqueued. Non-empty means a detached
  // run is in flight for this session, which speeds up the completion poll.
  const pendingRunsRef = useRef(new Map());
  // Terminal runs may remain alive briefly while a requested stop or late tool
  // receipt is reconciled. Keep their visible transcript outcome fresh until
  // the runtime reports execution inactive.
  const pendingOutcomeRefreshRef = useRef(new Map());
  const textRunIdsRef = useRef(new Set());
  const cancelledRunIdsRef = useRef(new Set());
  const completionWakeRef = useRef(null);
  const voicesRequestRef = useRef(null);
  const answerStreamsRef = useRef(new Map());
  const streamedRunsRef = useRef(new Map());
  const startAnswerStreamRef = useRef(null);
  const warmRuntimeRequestRef = useRef(null);
  const [runtimeStatus, setRuntimeStatus] = useState("idle");
  const [runtimeError, setRuntimeError] = useState("");
  const [pendingPermission, setPendingPermission] = useState(null);
  const [permissionSaving, setPermissionSaving] = useState(false);
  const [permissionError, setPermissionError] = useState("");

  // Stable session id used by /api/voice/chat. Persisted in localStorage so
  // every voice turn from this Mac resumes the SAME Hermes session instead
  // of minting a fresh one per page load.
  const sessionIdRef = useRef(managedSessionRef.current);
  if (sessionIdRef.current === null) {
    if (typeof window !== "undefined") {
      try { sessionIdRef.current = resolveVoiceSessionId(runtimeStorage()); }
      catch { sessionIdRef.current = createVoiceSessionId(); }
    } else {
      sessionIdRef.current = createVoiceSessionId();
    }
  }

  // ---------- helpers ----------

  function revokeOnce(url) {
    if (!url || revokedURLs.has(url)) return;
    revokedURLs.add(url);
    // Bound the dedup set: drop the oldest ids once we exceed the cap. Set
    // preserves insertion order, so the first key is the oldest. A URL that
    // old has long since been revoked and will never be seen again, so
    // forgetting it is safe.
    if (revokedURLs.size > REVOKED_URL_CAP) {
      const oldest = revokedURLs.values().next().value;
      if (oldest !== undefined) revokedURLs.delete(oldest);
    }
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* noop */
    }
    if (currentTtsRef.current && currentTtsRef.current.src === url) {
      currentTtsRef.current = null;
    }
  }

  const publishVoiceActivity = useCallback((descriptor = {}) => {
    const now = Date.now();
    const event = {
      id: descriptor.id || `voice-${now}`,
      sessionId: sessionIdRef.current,
      kind: descriptor.kind || descriptor.activityKind || "status",
      state: descriptor.state || "active",
      title: sanitize(descriptor.title || "Voice activity"),
      summary: sanitize(descriptor.summary || ""),
      target: sanitize(descriptor.target || ""),
      source: descriptor.source || "voice",
      updatedAt: new Date(now).toISOString(),
    };
    announceVoiceActivity(event);
    try {
      runtimeFetch("/api/voice/activity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
      })
        .then((res) => res.json().catch(() => ({})))
        .then((json) => {
          if (json && json.event) announceVoiceActivity(json.event);
        })
        .catch(() => {});
    } catch {
      /* noop */
    }
  }, []);

  const emitActivity = useCallback((descriptor) => {
    const summary = sanitize(descriptor && descriptor.summary);
    if (!summary) return;
    const now = Date.now();
    const map = recentSummariesRef.current;
    const last = map.get(summary);
    if (last !== undefined && now - last <= ACTIVITY_DEDUP_MS) return;
    // Re-inserting moves this key to the end (freshest); delete first so the
    // Map's insertion order stays a true LRU for the prune below.
    map.delete(summary);
    map.set(summary, now);
    // Bound the dedup map: entries older than the dedup window can never
    // suppress anything again, so evict the oldest once we exceed the cap.
    if (map.size > RECENT_SUMMARIES_CAP) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
    publishVoiceActivity({
      id: `voice-${now}`,
      kind: descriptor && descriptor.activityKind ? descriptor.activityKind : "log",
      source: descriptor && descriptor.source ? descriptor.source : "voice",
      title: descriptor && descriptor.title ? descriptor.title : "Voice",
      summary,
    });
  }, [publishVoiceActivity]);

  // Register a detached run as pending so the completion-speech poller speeds
  // up to ~2s until its completion is spoken (or the run TTLs out). Idempotent.
  const markRunPending = useCallback((actionId, textOnly = false) => {
    if (!actionId) return;
    const id = String(actionId);
    pendingRunsRef.current.set(id, Date.now());
    if (textOnly) {
      textRunIdsRef.current.add(id);
      if (textRunIdsRef.current.size > 200) {
        textRunIdsRef.current.delete(textRunIdsRef.current.values().next().value);
      }
    }
    try {
      runtimeStorage()?.setItem(pendingRunsStorageKey, JSON.stringify([...pendingRunsRef.current].map(([id, at]) => ({ id, at, textOnly: textRunIdsRef.current.has(id) }))));
    } catch { /* storage unavailable */ }
    completionWakeRef.current?.();
  }, []);

  const warmVoiceRuntime = useCallback(() => {
    if (warmRuntimeRequestRef.current) return warmRuntimeRequestRef.current;
    setRuntimeStatus("warming");
    setRuntimeError("");
    const request = runtimeFetch("/api/voice/runtime", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: sessionIdRef.current,
        surface: conversationModeRef.current === "talk" ? "talk" : "chat",
      }),
      signal: AbortSignal.timeout(60000),
    }).then(async (response) => {
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ready !== true) {
        const message = result.code === "working_directory_unavailable" && typeof result.error === "string"
          ? result.error
          : "The voice runtime could not get ready. Sending a request will retry the connection.";
        throw new Error(message);
      }
      setRuntimeStatus("ready");
    }).catch((error) => {
      setRuntimeStatus("error");
      setRuntimeError(error.message || "The voice runtime could not get ready.");
    }).finally(() => {
      if (warmRuntimeRequestRef.current === request) warmRuntimeRequestRef.current = null;
    });
    warmRuntimeRequestRef.current = request;
    return request;
  }, [runtimeFetch]);

  const observeRun = useCallback((run) => {
    if (!run?.id || !pendingRunsRef.current.has(run.id) || cancelledRunIdsRef.current.has(run.id)) return false;
    const previous = streamedRunsRef.current.get(run.id);
    if (previous?.updatedAt && run.updatedAt && Date.parse(previous.updatedAt) > Date.parse(run.updatedAt)) return false;
    if (previous && JSON.stringify(previous) === JSON.stringify(run)) return false;
    streamedRunsRef.current.set(run.id, run);
    const feedback = voiceFeedbackRef.current;
    if (feedback?.runId === run.id) {
      if (run.permission || ["error", "cancelled", "interrupted"].includes(run.state)) stopVoiceFeedbackRef.current?.();
      else if (feedback.toolCallId && !isActiveToolProgress(run, feedback.toolCallId)) retireVoiceFeedbackRef.current?.();
    }
    if (run.permission) setPendingPermission({ ...run.permission, actionId: run.id });
    else setPendingPermission((current) => current?.actionId === run.id ? null : current);
    if (run.statusLabel) dispatch({ type: "REQUEST_PROGRESS", label: run.statusLabel });
    playToolProgressRef.current?.(run);
    if (["complete", "error", "cancelled", "interrupted"].includes(run.state)) completionWakeRef.current?.();
    return true;
  }, []);

  const startAnswerStream = useCallback((actionId, textOnly = false) => {
    if (answerStreamsRef.current.has(actionId) || !pendingRunsRef.current.has(actionId)) return;
    const controller = new AbortController();
    const buffer = createAnswerSpeechBuffer();
    const entry = { controller, buffer, textOnly };
    answerStreamsRef.current.set(actionId, entry);
    const current = () => !controller.signal.aborted && answerStreamsRef.current.get(actionId) === entry && pendingRunsRef.current.has(actionId) && !cancelledRunIdsRef.current.has(actionId);
    void (async () => {
      const reconnectBackoff = createAnswerReconnectBackoff();
      while (current()) {
        let meaningful = false;
        try {
          const response = await runtimeFetch(`/api/voice/runs/${encodeURIComponent(actionId)}/events?sessionId=${encodeURIComponent(sessionIdRef.current)}&after=${buffer.sequence}`, { cache: "no-store", signal: controller.signal });
          if (!current()) { await response.body?.cancel(); break; }
          const supported = await readAnswerEvents(response, (type, event) => {
            if (!current()) return;
            if (type === "run") {
              const changed = observeRun(event);
              meaningful = changed || meaningful;
              return;
            }
            if (event.runId !== actionId) return;
            const holdSpeech = !canHandleCompletionNow(wrapperRef.current.state, {
              actionId,
              textOnly: shouldSuppressVoiceOutput(conversationModeRef.current, textOnly),
            }, { inputOwned: completionInputOwnershipRef.current });
            const result = buffer.accept(event, { holdSpeech });
            if (!result) return;
            meaningful = true;
            retireVoiceFeedbackRef.current?.();
            dispatch({ type: "STREAM_TEXT", actionId, text: result.text });
            dispatch({
              type: "STREAM_SPEECH_CHUNKS",
              actionId,
              textOnly: shouldSuppressVoiceOutput(conversationModeRef.current, textOnly),
              chunks: result.chunks,
            });
          }, controller.signal);
          if (!supported || ["complete", "error", "cancelled", "interrupted"].includes(streamedRunsRef.current.get(actionId)?.state)) break;
        } catch {
          if (!current()) break;
        }
        // Polling remains the durable fallback. Reconnect only reads events;
        // it never resubmits a prompt or repeats an action.
        const delay = reconnectBackoff.next({ meaningful });
        await new Promise((resolve) => {
          const done = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", done); resolve(); };
          const timer = setTimeout(done, delay);
          controller.signal.addEventListener("abort", done, { once: true });
        });
      }
    })();
  }, [observeRun, runtimeFetch]);
  startAnswerStreamRef.current = startAnswerStream;

  const respondToPermission = useCallback(async (optionId) => {
    if (!pendingPermission || permissionSaving || !pendingRunsRef.current.has(pendingPermission.actionId)) return false;
    const request = pendingPermission;
    setPermissionSaving(true);
    setPermissionError("");
    try {
      const response = await runtimeFetch("/api/voice/runtime", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sessionIdRef.current, actionId: request.actionId, requestId: request.requestId, optionId }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error("The permission response could not be saved. Try again or stop the request.");
      setPendingPermission((current) => current?.requestId === request.requestId ? null : current);
      completionWakeRef.current?.();
      return true;
    } catch (error) {
      if (pendingRunsRef.current.has(request.actionId)) setPermissionError(error.message);
      throw error;
    } finally {
      setPermissionSaving(false);
    }
  }, [pendingPermission, permissionSaving, runtimeFetch]);

  useEffect(() => {
    try {
      const active = initialActiveRunRef.current;
      const saved = managedSessionRef.current
        ? active?.id && !["complete", "error", "cancelled", "interrupted"].includes(active.state) ? [{ id: active.id, at: Date.now() }] : []
        : JSON.parse(runtimeStorage()?.getItem(pendingRunsStorageKey) || "[]");
      for (const entry of Array.isArray(saved) ? saved : []) {
        if (entry?.id && Date.now() - entry.at < COMPLETION_PENDING_TTL_MS) {
          markRunPending(entry.id, true); // restore silently after reload
          if (managedSessionRef.current && active?.id === entry.id) setAcceptedActionId(entry.id);
          dispatch({ type: "CHAT_PENDING", textOnly: true, actionId: entry.id });
          startAnswerStreamRef.current?.(entry.id, true);
        }
      }
    } catch { /* malformed storage */ }
  }, [markRunPending]);

  useEffect(() => { void warmVoiceRuntime(); }, [warmVoiceRuntime]);

  // ---------- microphone permission ----------

  const awaitCaptureOperation = useCallback((promise, signal, timeoutMs) => {
    if (signal?.aborted) return Promise.reject(new DOMException("Cancelled", "AbortError"));
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(new DOMException("Cancelled", "AbortError"));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    return withCaptureTimeout(Promise.race([promise, aborted]), timeoutMs)
      .finally(() => signal?.removeEventListener("abort", onAbort));
  }, []);

  const acquireMediaStream = useCallback(async (constraints, epoch, signal) => {
    const mediaDevices = runtimeMediaDevices();
    if (!mediaDevices?.getUserMedia) throw new Error("Microphone unavailable");
    const generation = voiceInputGenerationRef.current;
    const microphoneGeneration = microphoneAcquisitionGenerationRef.current;
    if (conversationModeRef.current === "chat") throw new DOMException("Voice capture is unavailable in Chat", "AbortError");
    const raw = Promise.resolve(mediaDevices.getUserMedia(constraints)).then((stream) => {
      if (microphoneGeneration !== microphoneAcquisitionGenerationRef.current || epoch !== operationEpochRef.current || !canAcceptVoiceCapture({
        startedGeneration: generation,
        currentGeneration: voiceInputGenerationRef.current,
        conversationMode: conversationModeRef.current,
        signal,
      })) {
        try { stream.getTracks().forEach((track) => track.stop()); } catch { /* noop */ }
        throw new DOMException("Cancelled", "AbortError");
      }
      return stream;
    });
    // `getUserMedia` itself cannot be aborted. The epoch check above still
    // stops a stream that arrives after our bounded wait has timed out.
    void raw.catch(() => {});
    return awaitCaptureOperation(raw, signal);
  }, [awaitCaptureOperation, runtimeMediaDevices]);

  const requestPermission = useCallback(async () => {
    const epoch = operationEpochRef.current;
    const generation = voiceInputGenerationRef.current;
    const microphoneGeneration = microphoneAcquisitionGenerationRef.current;
    const signal = operationAbortRef.current.signal;
    const mediaDevices = runtimeMediaDevices();
    if (!mediaDevices?.getUserMedia) {
      publishVoiceActivity({
        kind: "error",
        state: "error",
        title: "Microphone unavailable",
        summary: "Voice mode could not access a microphone device.",
        source: "voice/microphone",
      });
      dispatch({
        type: "SET_PERMISSION",
        value: "denied",
        error: "Microphone unavailable",
      });
      return;
    }
    dispatch({ type: "SET_PERMISSION", value: "pending" });
    try {
      // Law 1: reuse the getUserMedia the press gesture already kicked off via
      // primeAudioStack, so we never open a second, competing prompt. If none
      // is in flight (non-gesture entry), open one here.
      let stream;
      if (isLiveAudioStream(mediaStreamRef.current)) {
        stream = mediaStreamRef.current;
      } else if (pendingStreamPromiseRef.current) {
        stream = await awaitCaptureOperation(pendingStreamPromiseRef.current, signal);
      } else {
        stream = await acquireMediaStream(microphoneConstraints(wrapperRef.current.state.config?.micDeviceId), epoch, signal);
      }
      if (microphoneGeneration !== microphoneAcquisitionGenerationRef.current || epoch !== operationEpochRef.current || !canAcceptVoiceCapture({
        startedGeneration: generation,
        currentGeneration: voiceInputGenerationRef.current,
        conversationMode: conversationModeRef.current,
        signal,
      })) { stream.getTracks().forEach((track) => track.stop()); return; }
      mediaStreamRef.current = stream;
      dispatch({ type: "SET_PERMISSION", value: "granted" });
    } catch (err) {
      if (microphoneGeneration !== microphoneAcquisitionGenerationRef.current || epoch !== operationEpochRef.current || generation !== voiceInputGenerationRef.current || conversationModeRef.current === "chat" || signal.aborted) return;
      if (err instanceof VoiceCaptureTimeoutError) {
        operationEpochRef.current += 1;
        pendingStreamPromiseRef.current = null;
      }
      publishVoiceActivity({
        kind: "error",
        state: "error",
        title: "Microphone denied",
        summary: err && err.message ? err.message : String(err),
        source: "voice/microphone",
      });
      dispatch({ type: "CAPTURE_FAILED", stage: "permission", code: err instanceof VoiceCaptureTimeoutError ? "MIC_PERMISSION_TIMEOUT" : "MIC_PERMISSION_DENIED", error: err instanceof VoiceCaptureTimeoutError ? "Microphone permission took too long. Check the browser prompt and retry." : (err && err.message ? err.message : String(err)), retryable: true });
    }
  }, [acquireMediaStream, awaitCaptureOperation, publishVoiceActivity, runtimeMediaDevices]);

  // ---------- mic + VAD lifecycle ----------

  const ensureContinuousSpeechDetector = useCallback(async (epoch, signal, { preserveSubmittedWork = false } = {}) => {
    if (speechDetectorRef.current) {
      const detector = speechDetectorRef.current;
      const resume = speechDetectorControlRef.current.catch(() => {}).then(async () => {
        if (speechDetectorRef.current !== detector) return;
        await detector.start?.();
      });
      speechDetectorControlRef.current = resume;
      await awaitCaptureOperation(resume, signal, 5000);
      if (speechDetectorRef.current !== detector) return null;
      if (wrapperRef.current.state.state === "starting" && wrapperRef.current.state.continuousRequested) dispatch({ type: "MIC_READY" });
      return detector;
    }
    if (speechDetectorPromiseRef.current) {
      return awaitCaptureOperation(speechDetectorPromiseRef.current, signal, 12000);
    }
    const stream = mediaStreamRef.current;
    const audioContext = audioContextRef.current;
    if (!isLiveAudioStream(stream) || !audioContext) throw new Error("Microphone audio is not ready");
    let ready = false;
    let signalObserved = false;
    const detectorStartedAt = Date.now();
    const generation = speechDetectorGenerationRef.current + 1;
    speechDetectorGenerationRef.current = generation;
    let resolveReadiness;
    const readiness = { generation, promise: new Promise((resolve) => { resolveReadiness = resolve; }), resolve: (value) => resolveReadiness?.(value) };
    speechDetectorReadinessRef.current = readiness;
    const rawDetectorPromise = runtimeSpeechDetector({
      audioContext,
      stream,
      onFrameProcessed: (probabilities, frame) => {
        if (generation !== speechDetectorGenerationRef.current) return;
        const status = vadFrameStatus(probabilities, frame);
        if (status.hasSignal && !signalObserved) {
          signalObserved = true;
          if (speechDetectorSignalTimerRef.current) clearTimeout(speechDetectorSignalTimerRef.current);
          speechDetectorSignalTimerRef.current = null;
        }
        if (ready || !status.inferred) return;
        ready = true;
        readiness.resolve(true);
        publishVoiceActivity({ source: "voice/timing", title: "Speech detection ready", summary: `Detector initialization: ${Date.now() - detectorStartedAt}ms; Start conversation to ready: ${voiceStartupAtRef.current ? Date.now() - voiceStartupAtRef.current : Date.now() - detectorStartedAt}ms.` });
        if (speechDetectorReadyTimerRef.current) clearTimeout(speechDetectorReadyTimerRef.current);
        speechDetectorReadyTimerRef.current = null;
        if (wrapperRef.current.state.state === "starting" && wrapperRef.current.state.continuousRequested) {
          dispatch({ type: "MIC_READY" });
        }
        if (!signalObserved) {
          speechDetectorSignalTimerRef.current = setTimeout(() => {
            speechDetectorSignalTimerRef.current = null;
            if (signalObserved || generation !== speechDetectorGenerationRef.current) return;
            publishVoiceActivity({ kind: "warn", state: "listening", title: "Microphone signal is very quiet", summary: "Speech detection is ready, but the microphone has remained silent. Check the selected input if Hermes does not react when you speak.", source: "voice/vad" });
          }, 10000);
        }
      },
      onSpeechRealStart: () => {
        if (generation !== speechDetectorGenerationRef.current) return;
        if (captureSourceRef.current === "ptt") return;
        if (wrapperRef.current.state.state === "listening" && wrapperRef.current.state.continuousRequested) {
          captureSubmissionCommittedRef.current = false;
          completionInputOwnershipRef.current = true;
          captureSourceRef.current = "silero";
          dispatch({ type: "VAD_SPEECH_START" });
        }
      },
      onSpeechEnd: (audio) => {
        if (generation !== speechDetectorGenerationRef.current) return;
        const view = wrapperRef.current.state;
        if (view.state !== "capturing" || !view.continuousRequested || captureSourceRef.current !== "silero") return;
        captureSourceRef.current = null;
        completionInputOwnershipRef.current = true;
        speechEndedAtRef.current = Date.now();
        // Commit before dispatch: a device selection can arrive before React
        // publishes VAD_SPEECH_END's transcribing state.
        captureSubmissionCommittedRef.current = true;
        latestBlobRef.current = pcm16kToWavBlob(audio);
        dispatch({ type: "VAD_SPEECH_END" });
      },
      onVADMisfire: () => {
        if (generation !== speechDetectorGenerationRef.current) return;
        if (captureSourceRef.current === "silero" && wrapperRef.current.state.state === "capturing" && wrapperRef.current.state.continuousRequested) {
          captureSourceRef.current = null;
          dispatch({ type: "VAD_MISFIRE" });
        }
      },
    });
    const detectorPromise = Promise.resolve(rawDetectorPromise).then(async (detector) => {
      if (epoch !== operationEpochRef.current || generation !== speechDetectorGenerationRef.current) {
        if (speechDetectorGenerationRef.current === generation) speechDetectorGenerationRef.current += 1;
        readiness.resolve(false);
        await detector.destroy?.();
        throw new DOMException("Cancelled", "AbortError");
      }
      return detector;
    });
    speechDetectorPromiseRef.current = detectorPromise;
    try {
      const detector = await awaitCaptureOperation(detectorPromise, signal, 12000);
      if (epoch !== operationEpochRef.current || generation !== speechDetectorGenerationRef.current) {
        readiness.resolve(false);
        await detector.destroy?.();
        throw new DOMException("Cancelled", "AbortError");
      }
      speechDetectorRef.current = detector;
      if (!ready) {
        speechDetectorReadyTimerRef.current = setTimeout(() => {
          speechDetectorReadyTimerRef.current = null;
          if (ready || generation !== speechDetectorGenerationRef.current) return;
          readiness.resolve(false);
          dispatch({ type: preserveSubmittedWork ? "MIC_RECOVERY_FAILED" : "CAPTURE_FAILED", stage: "microphone", code: "VAD_NO_FRAMES", error: "The speech detector started but received no microphone audio. Push to talk is still available.", retryable: true });
        }, 5000);
      }
      return detector;
    } finally {
      if (speechDetectorPromiseRef.current === detectorPromise) speechDetectorPromiseRef.current = null;
    }
  }, [awaitCaptureOperation, publishVoiceActivity, runtimeSpeechDetector]);

  // ---------- one-press audio-stack priming (T-0010 Law 1) ----------
  //
  // WebKit (Safari / WKWebView / Tauri on macOS) gates AudioContext activation
  // on a user gesture: an AudioContext created OUTSIDE the gesture call stack
  // comes up `suspended` and its speech detector never receives samples, and the
  // first getUserMedia() only "arms" the permission prompt. The old flow
  // created the context and called getUserMedia inside the async effect-runner
  // — a full React commit AFTER the click returned — so the FIRST press only
  // primed the stack and the SECOND press was the one that actually reached a
  // live detector. That is the "always press twice" bug.
  //
  // primeAudioStack() runs SYNCHRONOUSLY inside the click/pointerdown handler
  // (see VoiceDock → primeAudio in context). It (a) creates the AudioContext
  // right now, in-gesture, and (b) calls resume() on it in-gesture — both are
  // the operations WebKit ties to the gesture. getUserMedia is kicked off here
  // too and its promise is stashed so ensureMicAndVad awaits the SAME stream
  // instead of racing a second prompt. Idempotent: safe to call on every press.
  const primeAudioStack = useCallback(() => {
    if (conversationModeRef.current === "chat") return;
    const epoch = operationEpochRef.current;
    const generation = voiceInputGenerationRef.current;
    const microphoneGeneration = microphoneAcquisitionGenerationRef.current;
    if (typeof window === "undefined") return;
    // (a) Create + resume the AudioContext in-gesture. This is the load-bearing
    // WebKit step: a context created/resumed inside the gesture stack starts
    // (or transitions to) "running"; one created later stays "suspended".
    try {
      const Ctx = runtimeAudioContext();
      if (Ctx && !audioContextRef.current) {
        audioContextRef.current = new Ctx();
      }
      const ctx = audioContextRef.current;
      // resume() MUST be called from within the gesture handler. Calling it
      // later (in the effect-runner) is a no-op on WebKit — the context is
      // already stuck suspended and the detector sees silence forever.
      if (ctx && ctx.state === "suspended" && typeof ctx.resume === "function") {
        ctx.resume().catch(() => {});
      }
    } catch {
      /* fall through — ensureMicAndVad will surface a hard failure */
    }
    // Prime a reusable HTMLAudioElement in the same gesture. Safari/WebKit can
    // allow an AudioContext yet still reject a newly-created media element
    // after the async TTS request has consumed user activation.
    try {
      const AudioClass = runtimeAudio();
      if (!primedPlaybackRef.current && typeof AudioClass === "function") {
        const audio = new AudioClass("data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQQAAACAgICA");
        audio.muted = true;
        primedPlaybackRef.current = audio;
        const unlock = audio.play();
        if (unlock && typeof unlock.then === "function") {
          unlock.then(() => { audio.pause(); audio.currentTime = 0; }).catch(() => {});
        }
      }
    } catch {
      /* playAudio will expose a useful playback failure if priming is blocked */
    }
    // (b) Kick getUserMedia in-gesture (first prompt is also gesture-gated on
    // some WebKit builds) and stash the promise so ensureMicAndVad reuses this
    // exact stream instead of opening a second, competing request.
    if (
      !mediaStreamRef.current &&
      !pendingStreamPromiseRef.current &&
      runtimeMediaDevices()?.getUserMedia
    ) {
      const cfg = wrapperRef.current?.state?.config;
      const deviceId = cfg?.micDeviceId;
      const constraints = microphoneConstraints(deviceId);
      try {
        const raw = runtimeMediaDevices()
          .getUserMedia(constraints)
          .then((stream) => {
            if (microphoneGeneration !== microphoneAcquisitionGenerationRef.current || epoch !== operationEpochRef.current || !canAcceptVoiceCapture({
              startedGeneration: generation,
              currentGeneration: voiceInputGenerationRef.current,
              conversationMode: conversationModeRef.current,
            })) { stream.getTracks().forEach((track) => track.stop()); throw new DOMException("Cancelled", "AbortError"); }
            mediaStreamRef.current = stream;
            return stream;
          });
        const pending = raw.catch((err) => {
            if (pendingStreamPromiseRef.current === pending) pendingStreamPromiseRef.current = null;
            throw err;
          });
        pendingStreamPromiseRef.current = pending;
        // Short taps can release the primed microphone before a consumer
        // starts awaiting it. Handle cancellation without an unhandled promise.
        void pendingStreamPromiseRef.current.catch(() => {});
      } catch {
        pendingStreamPromiseRef.current = null;
      }
    }
  }, [runtimeAudio, runtimeAudioContext, runtimeMediaDevices]);

  const ensureMicAndVad = useCallback(async ({ preserveSubmittedWork = false, awaitDetectorReady = false } = {}) => {
    const epoch = operationEpochRef.current;
    const generation = voiceInputGenerationRef.current;
    const microphoneGeneration = microphoneAcquisitionGenerationRef.current;
    const signal = operationAbortRef.current.signal;
    if (typeof window === "undefined" || conversationModeRef.current === "chat") return false;
    if (!isLiveAudioStream(mediaStreamRef.current)) {
      mediaStreamRef.current = null;
      const pending = pendingStreamPromiseRef.current;
      try {
        // Reuse the in-gesture getUserMedia the click already started (Law 1),
        // so we never open a second, racing permission request.
        let stream;
        if (pending) {
          stream = await awaitCaptureOperation(pending, signal);
        } else {
          const cfg = wrapperRef.current?.state?.config;
          const deviceId = cfg?.micDeviceId;
          const constraints = microphoneConstraints(deviceId);
          stream = await acquireMediaStream(constraints, epoch, signal);
        }
        if (microphoneGeneration !== microphoneAcquisitionGenerationRef.current || epoch !== operationEpochRef.current || !canAcceptVoiceCapture({
          startedGeneration: generation,
          currentGeneration: voiceInputGenerationRef.current,
          conversationMode: conversationModeRef.current,
          signal,
        })) {
          stream?.getTracks().forEach((track) => track.stop());
          return false;
        }
        mediaStreamRef.current = stream;
      } catch (err) {
        if (microphoneGeneration !== microphoneAcquisitionGenerationRef.current || epoch !== operationEpochRef.current || generation !== voiceInputGenerationRef.current || conversationModeRef.current === "chat" || signal.aborted) return false;
        pendingStreamPromiseRef.current = null;
        if (err instanceof VoiceCaptureTimeoutError) operationEpochRef.current += 1;
        dispatch({ type: preserveSubmittedWork ? "MIC_RECOVERY_FAILED" : "CAPTURE_FAILED", stage: "permission", code: err instanceof VoiceCaptureTimeoutError ? "MIC_PERMISSION_TIMEOUT" : "MIC_UNAVAILABLE", error: err instanceof VoiceCaptureTimeoutError ? "Microphone permission took too long. Check the browser prompt and retry." : (err && err.message ? err.message : String(err)), retryable: true });
        return false;
      } finally {
        if (pendingStreamPromiseRef.current === pending) pendingStreamPromiseRef.current = null;
      }
    }
    if (microphoneGeneration !== microphoneAcquisitionGenerationRef.current || epoch !== operationEpochRef.current || generation !== voiceInputGenerationRef.current || conversationModeRef.current === "chat" || signal.aborted) return false;
    if (!wrapperRef.current.state.continuousRequested && !["starting", "capturing"].includes(wrapperRef.current.state.state)) {
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
      return false;
    }
    // The AudioContext was (ideally) created + resumed in-gesture by
    // primeAudioStack. Create it here only as a fallback for non-gesture entry
    // paths (e.g. continuous resumed programmatically), then resume it
    // defensively before starting the speech detector.
    if (!audioContextRef.current) {
      try {
        const Ctx = runtimeAudioContext();
        if (!Ctx) {
          dispatch({ type: preserveSubmittedWork ? "MIC_RECOVERY_FAILED" : "CAPTURE_FAILED", stage: "microphone", code: "AUDIO_CONTEXT_UNSUPPORTED", error: "This browser cannot start the microphone audio engine. Use typed chat or a supported browser.", retryable: false });
          return false;
        }
        audioContextRef.current = new Ctx();
      } catch (err) {
        dispatch({ type: preserveSubmittedWork ? "MIC_RECOVERY_FAILED" : "CAPTURE_FAILED", stage: "microphone", code: "AUDIO_CONTEXT_FAILED", error: "The microphone audio engine could not start. Retry voice capture.", retryable: true });
        return false;
      }
    }
    const ctx = audioContextRef.current;
    if (ctx && ctx.state === "suspended" && typeof ctx.resume === "function") {
      try {
        await awaitCaptureOperation(ctx.resume(), signal, 5000);
      } catch {
        if (microphoneGeneration !== microphoneAcquisitionGenerationRef.current || epoch !== operationEpochRef.current || generation !== voiceInputGenerationRef.current || conversationModeRef.current === "chat" || signal.aborted) return false;
        dispatch({ type: preserveSubmittedWork ? "MIC_RECOVERY_FAILED" : "CAPTURE_FAILED", stage: "microphone", code: "AUDIO_CONTEXT_SUSPENDED", error: "The microphone audio engine stayed paused. Press Retry to start voice again.", retryable: true });
        return false;
      }
    }
    if (microphoneGeneration !== microphoneAcquisitionGenerationRef.current || epoch !== operationEpochRef.current || generation !== voiceInputGenerationRef.current || conversationModeRef.current === "chat" || signal.aborted) return false;
    if (wrapperRef.current.state.continuousRequested) {
      try {
        const detector = await ensureContinuousSpeechDetector(epoch, signal, { preserveSubmittedWork });
        if (!detector) return false;
      } catch (err) {
        if (microphoneGeneration !== microphoneAcquisitionGenerationRef.current || epoch !== operationEpochRef.current || generation !== voiceInputGenerationRef.current || conversationModeRef.current === "chat" || signal.aborted || err?.name === "AbortError") return false;
        dispatch({ type: preserveSubmittedWork ? "MIC_RECOVERY_FAILED" : "CAPTURE_FAILED", stage: "microphone", code: "VAD_INIT_FAILED", error: "Speech detection could not start. Push to talk is still available.", retryable: true });
        return false;
      }
    }
    if (microphoneGeneration !== microphoneAcquisitionGenerationRef.current || epoch !== operationEpochRef.current || generation !== voiceInputGenerationRef.current || conversationModeRef.current === "chat" || signal.aborted) return false;
    if (awaitDetectorReady && wrapperRef.current.state.continuousRequested) {
      const readiness = speechDetectorReadinessRef.current;
      if (readiness && readiness.generation === speechDetectorGenerationRef.current) {
        const ready = await awaitCaptureOperation(readiness.promise, signal, 6000).catch(() => false);
        if (!ready || microphoneGeneration !== microphoneAcquisitionGenerationRef.current || signal.aborted) return false;
      }
    }
    // Law 9: watch the live mic track for loss (device unplug, OS revoke) so
    // we can announce + re-acquire instead of dying silently in "listening".
    // Called through a ref to avoid a definition-order cycle with reacquireMic.
    if (attachMicLossHandlersRef.current) attachMicLossHandlersRef.current();
    return true;
  }, [acquireMediaStream, awaitCaptureOperation, ensureContinuousSpeechDetector, runtimeAudioContext]);

  // ---------- mic-loss self-recovery (T-0010 Law 9) ----------
  //
  // A mic can vanish mid-session: a Bluetooth headset drops, a USB interface is
  // unplugged, or the OS revokes access. The MediaStreamTrack fires "ended".
  // Without handling this the client sits in "listening" forever hearing
  // nothing (the no-onset watchdog eventually warns, but the mic is just gone).
  // Law 9 says recovery is HERS: announce "I lost the mic, reconnecting…" and
  // re-acquire automatically.
  const reacquireMic = useCallback(async () => {
    if (typeof window === "undefined" || conversationModeRef.current === "chat") return;
    if (micRecoveringRef.current) return;
    micRecoveringRef.current = true;
    // Speak/show the loss so the user isn't left wondering (Law 4: never
    // silent). This goes to the activity feed + dock; it is not a fake answer.
    publishVoiceActivity({
      kind: "warn",
      state: "listening",
      title: "Microphone lost",
      summary: "I lost the mic, reconnecting…",
      source: "voice/recovery",
    });
    const state = wrapperRef.current.state;
    const wantsListening = state.continuousRequested || state.state === "listening";
    const preserveSubmittedWork = captureSubmissionCommittedRef.current || state.requestPending || ["transcribing", "thinking", "speaking"].includes(state.state);
    // Use the same capture-only invalidation boundary as an explicit device
    // change. It rotates pending getUserMedia work, destroys the detector bound
    // to the ended stream, and preserves a recorder/STT result that was already
    // committed. The shared AudioContext stays gesture-unlocked for playback.
    invalidateMicrophoneInputRef.current?.(state);
    const recoveryMicrophoneGeneration = microphoneAcquisitionGenerationRef.current;
    if (!wantsListening) {
      dispatch({ type: preserveSubmittedWork ? "MIC_RECOVERY_FAILED" : "CAPTURE_FAILED", stage: "microphone", code: "MIC_STREAM_ENDED", error: "The microphone disconnected during capture. Retry voice capture.", retryable: true });
      micRecoveringRef.current = false;
      return;
    }
    completionInputOwnershipRef.current = true;
    dispatch({ type: "MIC_RECOVERY_STARTED" });
    try {
      const recovered = await ensureMicAndVad({ preserveSubmittedWork, awaitDetectorReady: true });
      if (!recovered) {
        completionInputOwnershipRef.current = false;
        // A detector that never becomes ready must not remain bound to a dead
        // replacement stream. Do not touch a newer user-selected acquisition.
        if (recoveryMicrophoneGeneration === microphoneAcquisitionGenerationRef.current) {
          invalidateMicrophoneInputRef.current?.(wrapperRef.current.state);
        }
        return;
      }
      dispatch({ type: "MIC_RECOVERY_READY" });
      completionInputOwnershipRef.current = false;
      publishVoiceActivity({
        kind: "info",
        state: "listening",
        title: "Microphone reconnected",
        summary: "Mic is back — listening again.",
        source: "voice/recovery",
      });
    } catch {
      completionInputOwnershipRef.current = false;
      /* ensureMicAndVad surfaces its own failure */
    } finally {
      micRecoveringRef.current = false;
    }
  }, [ensureMicAndVad, publishVoiceActivity]);

  // Attach an "ended" listener to each live mic track exactly once. When a
  // track ends unexpectedly (not from our own teardown), trigger recovery.
  const attachMicLossHandlers = useCallback(() => {
    const stream = mediaStreamRef.current;
    if (!stream) return;
    let tracks = [];
    try {
      tracks = stream.getAudioTracks();
    } catch {
      return;
    }
    for (const track of tracks) {
      const key = track.id || String(tracks.indexOf(track));
      if (handledTrackIdsRef.current.has(key)) continue;
      handledTrackIdsRef.current.add(key);
      const onEnded = () => {
        // Ignore losses we caused ourselves (teardown stops tracks): if the
        // stream ref was already cleared, this is an intentional stop.
        if (mediaStreamRef.current !== stream) return;
        void reacquireMic();
      };
      try {
        track.addEventListener("ended", onEnded, { once: true });
      } catch {
        // Older WebKit: fall back to the onended property.
        track.onended = onEnded;
      }
    }
  }, [reacquireMic]);

  // Ref indirection so ensureMicAndVad (defined above) can invoke the latest
  // attachMicLossHandlers without a useCallback dependency cycle.
  const attachMicLossHandlersRef = useRef(null);
  attachMicLossHandlersRef.current = attachMicLossHandlers;

  const startUtteranceRecorder = useCallback(() => {
    const stream = mediaStreamRef.current;
    if (!isLiveAudioStream(stream)) {
      // We're in "capturing" per the reducer but the mic stream vanished
      // (permission revoked mid-session, device unplugged, teardown race).
      // Surface it instead of silently sitting in capturing until the valve
      // fires an empty STOP_PTT — that path looks like "spoke, nothing
      // happened" from the outside.
      publishVoiceActivity({
        kind: "error",
        state: "error",
        title: "Recorder failed",
        summary: "Microphone stream unavailable at capture start.",
        source: "voice/recorder",
      });
      dispatch({ type: "CAPTURE_FAILED", stage: "recorder", code: "MIC_STREAM_ENDED", error: "The microphone disconnected before recording started. Retry voice capture.", retryable: true });
      return;
    }
    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state !== "inactive"
    ) {
      return;
    }
    audioChunksRef.current = [];
    discardOnStopRef.current = false;
    // WKWebView (Tauri on macOS) may not support audio/webm — detect the
    // best supported mimeType at runtime instead of hardcoding webm.
    const Recorder = runtimeMediaRecorder();
    if (!Recorder) {
      dispatch({ type: "CAPTURE_FAILED", stage: "recorder", code: "RECORDER_UNSUPPORTED", error: "This browser cannot record microphone audio. Use typed chat or a supported browser.", retryable: false });
      return;
    }
    try {
      const rec = createVoiceRecorder(stream, Recorder, (chunk) => audioChunksRef.current.push(chunk));
      // Pass a 100ms timeslice so ondataavailable fires periodically — some
      // WebKit builds don't flush data reliably when start() is called with
      // no timeslice and stop() is the only trigger.
      rec.start(100);
      mediaRecorderRef.current = rec;
      speechStartedAtRef.current = performance.now();
      dispatch({ type: "RECORDER_STARTED" });
    } catch (err) {
      publishVoiceActivity({
        kind: "error",
        state: "error",
        title: "Recorder failed",
        summary: err && err.message ? err.message : String(err),
        source: "voice/recorder",
      });
      dispatch({ type: "CAPTURE_FAILED", stage: "recorder", code: "RECORDER_START_FAILED", error: "Recording could not start. Retry voice capture.", retryable: true });
    }
  }, [publishVoiceActivity, runtimeMediaRecorder]);

  const stopUtteranceRecorder = useCallback((discard) => {
    if (!discard) speechEndedAtRef.current = Date.now();
    if (recorderStopRef.current) {
      if (discard) discardOnStopRef.current = true;
      return recorderStopRef.current;
    }
    const result = new Promise((resolve) => {
      const rec = mediaRecorderRef.current;
      if (!rec) {
        latestBlobRef.current = null;
        resolve();
        return;
      }
      discardOnStopRef.current = !!discard;
      const stopTimer = setTimeout(() => {
        rec.onstop = null;
        if (mediaRecorderRef.current === rec) mediaRecorderRef.current = null;
        latestBlobRef.current = null;
        audioChunksRef.current = [];
        if (!discardOnStopRef.current) dispatch({ type: "STT_FAILED", error: "The microphone did not finish this recording. Please try speaking again.", code: "RECORDER_TIMEOUT", retryable: false });
        resolve();
      }, 3000);
      rec.onstop = () => {
        clearTimeout(stopTimer);
        const chunks = audioChunksRef.current;
        audioChunksRef.current = [];
        // Use the recorder's actual mimeType — matches what WKWebView
        // really encoded (may be audio/mp4 on macOS, not webm).
        const actualMime = rec.mimeType || "audio/webm";
        const blob = new Blob(chunks, { type: actualMime });
        const dur = performance.now() - speechStartedAtRef.current;
        mediaRecorderRef.current = null;
        if (
          discardOnStopRef.current ||
          dur < VAD_MIN_UTTERANCE_MS ||
          blob.size < 100
        ) {
          // Surface WHY the blob was discarded so we're not debugging blind.
          const reason = discardOnStopRef.current
            ? "discarded by caller"
            : dur < VAD_MIN_UTTERANCE_MS
              ? `too short (${Math.round(dur)}ms < ${VAD_MIN_UTTERANCE_MS}ms)`
              : `too small (${blob.size} bytes < 100)`;
          publishVoiceActivity({
            kind: "info",
            state: "listening",
            title: "Utterance skipped",
            summary: `${reason} — mime=${actualMime}, chunks=${chunks.length}`,
            source: "voice/recorder",
          });
          latestBlobRef.current = null;
          resolve();
          return;
        }
        latestBlobRef.current = blob;
        resolve();
      };
      try {
        rec.stop();
      } catch {
        clearTimeout(stopTimer);
        latestBlobRef.current = null;
        resolve();
      }
    });
    recorderStopRef.current = result;
    void result.finally(() => { if (recorderStopRef.current === result) recorderStopRef.current = null; });
    return result;
  }, []);

  const destroySpeechDetector = useCallback(() => {
    speechDetectorGenerationRef.current += 1;
    speechDetectorReadinessRef.current?.resolve(false);
    speechDetectorReadinessRef.current = null;
    if (speechDetectorReadyTimerRef.current) clearTimeout(speechDetectorReadyTimerRef.current);
    speechDetectorReadyTimerRef.current = null;
    if (speechDetectorSignalTimerRef.current) clearTimeout(speechDetectorSignalTimerRef.current);
    speechDetectorSignalTimerRef.current = null;
    const detector = speechDetectorRef.current;
    speechDetectorRef.current = null;
    speechDetectorPromiseRef.current = null;
    if (detector) void Promise.resolve(detector.destroy?.()).catch(() => {});
  }, []);

  const stopAllTracks = useCallback(() => {
    destroySpeechDetector();
    const stream = mediaStreamRef.current;
    mediaStreamRef.current = null;
    pendingStreamPromiseRef.current = null;
    handledTrackIdsRef.current.clear();
    if (!stream) return;
    try {
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      /* noop */
    }
  }, [destroySpeechDetector]);

  const closeAudioContext = useCallback(async () => {
    const ctx = audioContextRef.current;
    if (!ctx) return;
    audioContextRef.current = null;
    try {
      if (ctx.state !== "closed") await ctx.close();
    } catch {
      /* noop */
    }
  }, []);

  const releaseMicForPlayback = useCallback(() => {
    stopAllTracks();
    // Keep the gesture-unlocked AudioContext alive. A replacement created
    // after async STT/chat/TTS work may remain suspended in WebKit.
  }, [stopAllTracks]);

  const invalidateMicrophoneInput = useCallback((state) => {
    microphoneAcquisitionGenerationRef.current += 1;
    operationAbortRef.current.abort();
    operationAbortRef.current = new AbortController();
    pttGestureRef.current.reset();
    captureSourceRef.current = null;
    // A pending getUserMedia call cannot itself be cancelled. Its captured
    // microphone generation stops the late stream when it eventually resolves.
    pendingStreamPromiseRef.current = null;
    const oldStream = mediaStreamRef.current;
    mediaStreamRef.current = null;
    handledTrackIdsRef.current.clear();
    destroySpeechDetector();
    const releaseOldStream = () => {
      try { oldStream?.getTracks().forEach((track) => track.stop()); } catch { /* noop */ }
    };
    if (["starting", "capturing"].includes(state.state) && !captureSubmissionCommittedRef.current) {
      // This utterance has not been submitted. Discard it before releasing the
      // track so a device change cannot create a partial transcript.
      void Promise.resolve(stopUtteranceRecorder(true)).catch(() => {}).finally(releaseOldStream);
      return;
    }
    if (recorderStopRef.current) {
      // STOP_PTT has already committed the utterance. Let MediaRecorder flush
      // its final blob before the old input track is released.
      void Promise.resolve(recorderStopRef.current).catch(() => {}).finally(releaseOldStream);
      return;
    }
    const recorder = mediaRecorderRef.current;
    if ((state.state === "transcribing" || captureSubmissionCommittedRef.current) && recorder && recorder.state !== "inactive") {
      void Promise.resolve(stopUtteranceRecorder(false)).catch(() => {}).finally(releaseOldStream);
      return;
    }
    releaseOldStream();
  }, [destroySpeechDetector, stopUtteranceRecorder]);
  invalidateMicrophoneInputRef.current = invalidateMicrophoneInput;

  // ---------- STT / Chat / TTS ----------

  const callSTT = useCallback(async () => {
    const blob = latestBlobRef.current;
    latestBlobRef.current = null;
    captureSubmissionCommittedRef.current = false;
    if (!blob) {
      // Empty utterance — fall back to rest state without erroring.
      dispatch({ type: "STT_OK", text: "" });
      return;
    }
    const startedAt = Date.now();
    const epoch = operationEpochRef.current;
    sttAbortRef.current?.abort();
    const controller = new AbortController();
    sttAbortRef.current = controller;
    const timer = setTimeout(() => controller.abort(new DOMException("Speech recognition timed out", "TimeoutError")), 30000);
    lastRequestRef.current = { kind: "stt", blob };
    dispatch({ type: "REQUEST_STARTED", kind: "voice", at: startedAt });
    const current = () => operationEpochRef.current === epoch && sttAbortRef.current === controller;
    try {
      const fd = new FormData();
      fd.append("file", blob, recorderFileName(blob.type));
      const res = await runtimeFetch("/api/voice/stt", { method: "POST", body: fd, signal: controller.signal });
      if (!current()) return;
      sttMsRef.current = Date.now() - startedAt;
      if (!res.ok) {
        const failure = await res.json().catch(() => ({}));
        if (!current()) return;
        const text = failure?.message || "Speech recognition is unavailable. Try again.";
        publishVoiceActivity({
          kind: "error",
          state: "error",
          title: "Transcription failed",
          summary: text,
          source: "voice/stt",
        });
        dispatch({ type: "STT_FAILED", error: text, code: failure.code, retryable: failure.retryable });
        return;
      }
      const json = await res.json().catch(() => ({}));
      if (!current()) return;
      const heard = json && json.text ? json.text : "";
      publishVoiceActivity({ source: "voice/timing", title: "Transcription ready", summary: `Transcription request: ${Date.now() - startedAt}ms${speechEndedAtRef.current ? `; detected speech end to transcript: ${Date.now() - speechEndedAtRef.current}ms` : ""}.` });
      // Diagnosability: put the ACTUAL heard text (truncated) into the activity
      // feed so a mishearing is visible to the user instead of an opaque
      // "Transcript updated". sanitize() (Property 15) strips control chars /
      // auth headers / blob markers; we also cap length so a long utterance
      // can't dominate the feed. Empty utterances stay silent (no summary).
      if (heard.trim()) {
        const summary =
          heard.length > 120 ? `${heard.slice(0, 117)}...` : heard;
        const conf =
          typeof json.confidence === "number"
            ? ` (${Math.round(json.confidence * 100)}%)`
            : "";
        publishVoiceActivity({
          kind: "log",
          state: "active",
          title: "Heard",
          summary: `"${summary}"${conf}`,
          source: "voice/stt",
        });
      }
      dispatch({ type: "STT_OK", text: heard, textOnly: resolveTextOnlyMode(false, conversationModeRef.current) });
    } catch (err) {
      if (!current() || (controller.signal.aborted && controller.signal.reason?.name !== "TimeoutError")) return;
      sttMsRef.current = Date.now() - startedAt;
      publishVoiceActivity({
        kind: "error",
        state: "error",
        title: "Transcription failed",
        summary: "Speech recognition could not connect. Retry this recording or type your message.",
        source: "voice/stt",
      });
      dispatch({
        type: "STT_FAILED",
        error: "Speech recognition could not connect. Retry this recording or type your message.",
        code: controller.signal.aborted ? "STT_TIMEOUT" : "STT_NETWORK_ERROR",
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
      if (sttAbortRef.current === controller) sttAbortRef.current = null;
    }
  }, [publishVoiceActivity]);

  const cleanupVoiceFeedback = useCallback((active) => {
    if (!active) return;
    active.handoff?.finish();
    if (voiceFeedbackRef.current === active) voiceFeedbackRef.current = null;
    try { active.controller?.abort(); } catch { /* noop */ }
    if (active.timeout) clearTimeout(active.timeout);
    try { active.stream?.cancel(); } catch { /* noop */ }
    if (active.finish) {
      active.audio?.removeEventListener?.("ended", active.finish);
      active.audio?.removeEventListener?.("error", active.finish);
    }
    active.audio?.removeEventListener?.("playing", active.onPlaying);
    try { active.audio?.pause(); } catch { /* noop */ }
    if (active.url) revokeOnce(active.url);
    if (currentTtsRef.current === active.audio) currentTtsRef.current = null;
  }, []);
  const stopVoiceFeedback = useCallback(() => {
    const prepared = preparedVoiceFeedbackRef.current;
    preparedVoiceFeedbackRef.current = null;
    prepared?.controller.abort();
    cleanupVoiceFeedback(voiceFeedbackRef.current);
  }, [cleanupVoiceFeedback]);
  stopVoiceFeedbackRef.current = stopVoiceFeedback;
  retireVoiceFeedbackRef.current = () => voiceFeedbackRef.current?.handoff.retire();

  const prepareVoiceFeedback = useCallback((phrase) => {
    const cfg = wrapperRef.current.state.config || {};
    const signature = JSON.stringify([cfg.ttsBackend, cfg.ttsVoice, cfg.elevenlabsVoiceId, cfg.elevenlabsModel, cfg.ttsRate, cfg.ttsPitch, cfg.ttsVolume]);
    return prepareVoiceFeedbackAudio({ phrase, signature, cache: voiceFeedbackCacheRef.current, fetcher: runtimeFetch, minBytes: TTS_MIN_BYTES });
  }, [runtimeFetch]);

  const playVoiceFeedback = useCallback(async (phrase, key, runId, expectedStatus = null, prepared = null, options = {}) => {
    const cfg = wrapperRef.current.state.config || {};
    const feedbackKey = String(key || phrase || "");
    const now = Date.now();
    const view = wrapperRef.current.state;
    if (!phrase || !runId || shouldSuppressVoiceOutput(conversationModeRef.current) || view.state !== "thinking" || !view.requestPending || view.actionId !== runId || cfg.autoSpeak === false || cfg.muteOutput === true || voicedFeedbackKeysRef.current.has(feedbackKey) || now - lastVoiceFeedbackAtRef.current < VOICE_FEEDBACK_THROTTLE_MS || options.isCurrent && !options.isCurrent()) { prepared?.controller.abort(); return; }
    voicedFeedbackKeysRef.current.add(feedbackKey);
    while (voicedFeedbackKeysRef.current.size > 200) voicedFeedbackKeysRef.current.delete(voicedFeedbackKeysRef.current.values().next().value);
    lastVoiceFeedbackAtRef.current = now;
    stopVoiceFeedback();
    const source = prepared || prepareVoiceFeedback(phrase);
    const { controller, signature, cacheKey } = source;
    const active = { controller, audio: null, url: null, stream: null, runId, toolCallId: options.toolCallId };
    active.handoff = createVoiceFeedbackHandoff({ cancelPlayback: () => cleanupVoiceFeedback(active) });
    voiceFeedbackRef.current = active;
    const isCurrentFeedback = () => {
      const latest = wrapperRef.current.state;
      const playable = voiceFeedbackRef.current === active && latest.state === "thinking" && latest.actionId === runId && latest.config.autoSpeak !== false && !latest.config.muteOutput;
      // Once audible, finish the short phrase across normal text/tool updates.
      // Explicit Stop, errors and permission waits still tear it down at once.
      return playable && (active.handoff.started || (latest.requestPending && (!expectedStatus || latest.activeRequestStatus === expectedStatus) && (!options.isCurrent || options.isCurrent())));
    };
    const announceStart = (cached = false) => publishVoiceActivity({
      source: "voice/timing",
      title: options.toolCallId ? "Tool progress audio started" : "Voice acknowledgement started",
      summary: options.toolCallId
        ? `Native tool start to progress playback: ${Date.now() - options.toolStartedAt}ms. ${phrase}`
        : `Cue preparation to playback: ${Date.now() - source.requestedAt}ms${cached ? " (cached)" : ""}.`,
      target: runId,
    });
    let streamOwnsTimeout = false;
    const timeout = setTimeout(() => {
      controller.abort(new DOMException("Voice feedback timed out", "TimeoutError"));
      active.stream?.cancel();
    }, 10000);
    active.timeout = timeout;
    try {
      const payload = await source.promise;
      if (!payload || controller.signal.aborted) { cleanupVoiceFeedback(active); return; }
      const cached = payload.blob;
      while (voiceFeedbackCacheRef.current.size > 12) voiceFeedbackCacheRef.current.delete(voiceFeedbackCacheRef.current.keys().next().value);
      const currentView = wrapperRef.current.state;
      if (!isCurrentFeedback() || currentView.state !== "thinking") { cleanupVoiceFeedback(active); return; }
      const AudioClass = runtimeAudio();
      if (!AudioClass) { cleanupVoiceFeedback(active); return; }
      const audio = primedPlaybackRef.current || new AudioClass();
      active.audio = audio;
      active.onPlaying = () => active.handoff.markStarted();
      audio.addEventListener?.("playing", active.onPlaying, { once: true });
      primedPlaybackRef.current = audio;
      currentTtsRef.current = audio;
      audio.pause();
      const finish = () => {
        active.handoff.finish();
        audio.removeEventListener?.("playing", active.onPlaying);
        audio.removeEventListener?.("ended", finish);
        audio.removeEventListener?.("error", finish);
        try { active.stream?.cancel(); } catch { /* noop */ }
        if (voiceFeedbackRef.current === active) voiceFeedbackRef.current = null;
        if (currentTtsRef.current === audio) currentTtsRef.current = null;
        if (active.url) revokeOnce(active.url);
      };
      active.finish = finish;
      audio.addEventListener?.("ended", finish, { once: true });
      audio.addEventListener?.("error", finish, { once: true });
      let blob = cached instanceof Blob ? cached : null;
      if (!blob) {
        const res = payload.response;
        const afterFetch = wrapperRef.current.state;
        if (!isCurrentFeedback() || afterFetch.state !== "thinking") {
          try { await res.body?.cancel(); } catch { /* noop */ }
          return;
        }
        if (canStreamVoiceFeedback(res)) {
          const stream = streamVoiceFeedback({
            response: res,
            audio,
            isCurrent: isCurrentFeedback,
          });
          active.stream = stream;
          active.url = stream.url;
          streamOwnsTimeout = true;
          void stream.complete.then((completeBlob) => {
            if (!completeBlob || completeBlob.size < TTS_MIN_BYTES) return;
            voiceFeedbackCacheRef.current.set(cacheKey, completeBlob);
            void persistVoiceFeedback(signature, phrase, completeBlob);
          }, () => {
            if (voiceFeedbackRef.current === active) stopVoiceFeedback();
          }).then(() => clearTimeout(timeout));
          await stream.started;
          if (isCurrentFeedback()) announceStart();
          if (!isCurrentFeedback()) cleanupVoiceFeedback(active);
          return;
        }
        blob = await res.blob();
        if (!blob || blob.size < TTS_MIN_BYTES) throw new Error("Voice feedback unavailable");
        voiceFeedbackCacheRef.current.set(cacheKey, blob);
        void persistVoiceFeedback(signature, phrase, blob);
      }
      const beforePlay = wrapperRef.current.state;
      if (!isCurrentFeedback() || beforePlay.state !== "thinking") return;
      const url = URL.createObjectURL(blob);
      active.url = url;
      audio.src = url;
      audio.currentTime = 0;
      audio.muted = false;
      await playVoiceFeedbackAudio(audio, isCurrentFeedback);
      if (isCurrentFeedback()) announceStart(Boolean(cached));
    } catch {
      if (voiceFeedbackRef.current === active) cleanupVoiceFeedback(active);
    } finally {
      if (!streamOwnsTimeout) clearTimeout(timeout);
    }
  }, [cleanupVoiceFeedback, stopVoiceFeedback, prepareVoiceFeedback, publishVoiceActivity]);
  playToolProgressRef.current = (run) => {
    const view = wrapperRef.current.state;
    if (shouldSuppressVoiceOutput(conversationModeRef.current) || view.state !== "thinking" || !view.requestPending || view.actionId !== run.id || view.config.autoSpeak === false || view.config.muteOutput || Date.now() - lastVoiceFeedbackAtRef.current < VOICE_FEEDBACK_THROTTLE_MS) return;
    const stream = answerStreamsRef.current.get(run.id);
    const phrase = selectToolProgressRef.current(run, { textOnly: textRunIdsRef.current.has(run.id), hasAnswer: stream?.buffer.received === true });
    if (!phrase) return;
    const callId = run.toolProgress.callId;
    void playVoiceFeedback(phrase, `${run.id}:tool-progress`, run.id, null, null, {
      toolCallId: callId,
      toolStartedAt: Date.parse(run.toolProgress.startedAt) || Date.now(),
      isCurrent: () => isActiveToolProgress(streamedRunsRef.current.get(run.id), callId) && !answerStreamsRef.current.get(run.id)?.buffer.received,
    });
  };

  const callChat = useCallback(async (text, textOnly = false, preserveContinuous = false) => {
    const surface = conversationModeRef.current === "talk" ? "talk" : "chat";
    const resolvedTextOnly = resolveTextOnlyMode(textOnly, conversationModeRef.current);
    setAcceptedActionId(null);
    stopVoiceFeedback();
    const submittedAt = Date.now();
    const epoch = operationEpochRef.current;
    const voiceGeneration = voiceInputGenerationRef.current;
    chatAbortRef.current?.abort();
    const controller = new AbortController();
    chatAbortRef.current = controller;
    const timer = setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), 30000);
    const current = () => operationEpochRef.current === epoch && chatAbortRef.current === controller;
    lastRequestRef.current = { kind: "chat", text, textOnly: resolvedTextOnly, preserveContinuous };
    const actionId = crypto.randomUUID();
    markRunPending(actionId, resolvedTextOnly);
    dispatch({ type: "REQUEST_STARTED", kind: resolvedTextOnly ? "text" : "voice", at: Date.now() });
    dispatch({ type: "CHAT_PENDING", textOnly: resolvedTextOnly, actionId });
    try {
      const cfg = wrapperRef.current?.state?.config || {};
      const cue = !resolvedTextOnly && !shouldSuppressVoiceOutput(conversationModeRef.current) && cfg.autoSpeak !== false && !cfg.muteOutput && Date.now() - lastVoiceFeedbackAtRef.current >= VOICE_FEEDBACK_THROTTLE_MS ? selectEarlyVoiceFeedback(text) : null;
      // Prepare only the finite, guarded acknowledgement phrase in parallel.
      // Playback still waits for server acceptance and checks this run's state.
      const prepared = cue ? prepareVoiceFeedback(cue) : null;
      preparedVoiceFeedbackRef.current = prepared;
      const target = surface === "talk" ? "Talk model route" : "Chat model route";
      const res = await runtimeFetch("/api/voice/chat", voiceChatRequest({
        text,
        actionId,
        sessionId: sessionIdRef.current,
        surface,
        textOnly: resolvedTextOnly,
        sttMs: sttMsRef.current,
        history: normalizeTranscriptEntries(wrapperRef.current.state.transcript).filter((entry) => !entry.isError).slice(-30),
        signal: controller.signal,
      }));
      if (!current()) { try { await res.body?.cancel(); } catch {} return; }
      const contentType = res.headers.get("Content-Type") || "";
      if (!contentType.includes("application/json")) {
        try { await res.body?.cancel(); } catch {}
        throw new Error("Hermes returned an unexpected response. Check the request status before retrying.");
      }
      const json = await res.json().catch(() => ({}));
      if (!current()) return;
      if (res.ok && json.pending && json.actionId) {
        if (json.actionId === actionId) setAcceptedActionId(actionId);
        // Registered before POST. Completion may already have arrived through
        // the durable poller; an acknowledgement must never restart that run.
        publishVoiceActivity({ source: "voice/timing", title: "Request accepted", summary: `Submission to acceptance: ${Date.now() - submittedAt}ms.`, target: actionId });
        startAnswerStream(json.actionId, resolvedTextOnly);
        if (preparedVoiceFeedbackRef.current === prepared) preparedVoiceFeedbackRef.current = null;
        if (cue && prepared && !prepared.controller.signal.aborted) void playVoiceFeedback(cue, `${actionId}:accepted`, actionId, null, prepared);
        return;
      }
      stopVoiceFeedback();
      if (!res.ok || !json || !json.response) {
        stopVoiceFeedback();
        pendingRunsRef.current.delete(actionId);
        try { runtimeStorage()?.setItem(pendingRunsStorageKey, JSON.stringify([...pendingRunsRef.current].map(([id, at]) => ({ id, at, textOnly: textRunIdsRef.current.has(id) })))); } catch {}
        publishVoiceActivity({
          kind: "error",
          state: "error",
          title: "Model request failed",
          summary: (json && (json.details || json.error)) || "Hermes did not return a voice response.",
          target,
          source: "voice/chat",
        });
        dispatch({
          type: "CHAT_FAILED",
          error: json && json.error,
          details: json && json.details,
          code: json?.code,
          retryable: json?.retryable === true,
        });
        return;
      }
      // T-0008: JSON action/data response also runs detached — register the
      // pending run so the completion poller speaks the real reply.
      const pendingRun = (json.mode === "action" || json.mode === "data") && Boolean(json.actionId);
      if (pendingRun) {
        markRunPending(json.actionId, resolvedTextOnly);
      } else {
        // A direct response is already terminal. Give it the same stable
        // identity as durable run history and remove the optimistic poller
        // registration so a legacy/immediate response cannot time out later.
        pendingRunsRef.current.delete(actionId);
        textRunIdsRef.current.delete(actionId);
        try { runtimeStorage()?.setItem(pendingRunsStorageKey, JSON.stringify([...pendingRunsRef.current].map(([id, at]) => ({ id, at, textOnly: textRunIdsRef.current.has(id) })))); } catch {}
      }
      dispatch({ type: "CHAT_OK", response: json.response, id: `${actionId}:result`, actionId, textOnly: resolveTextOnlyMode(resolvedTextOnly, conversationModeRef.current) || voiceGeneration !== voiceInputGenerationRef.current, preserveContinuous, pendingRun });
    } catch (err) {
      stopVoiceFeedback();
      if (!current() || (controller.signal.aborted && controller.signal.reason?.name !== "TimeoutError")) return;
      publishVoiceActivity({
        kind: "error",
        state: "error",
        title: "Model request failed",
        summary: err && err.message ? err.message : String(err),
        source: "voice/chat",
      });
      dispatch({
        type: "CHAT_FAILED",
        error: "The connection was interrupted. Hermes may still be working; check activity before sending the same request again.",
        code: "CHAT_CONNECTION_LOST",
        retryable: false,
      });
    } finally {
      clearTimeout(timer);
      if (chatAbortRef.current === controller) chatAbortRef.current = null;
    }
  }, [publishVoiceActivity, markRunPending, playVoiceFeedback, stopVoiceFeedback, prepareVoiceFeedback, startAnswerStream]);

  const callTTS = useCallback(async (text) => {
    retireVoiceFeedbackRef.current?.();
    finalTtsStartedAtRef.current = Date.now();
    const epoch = operationEpochRef.current;
    if (shouldSuppressVoiceOutput(conversationModeRef.current)) {
      dispatch({ type: "TTS_PLAYBACK_ENDED" });
      return;
    }
    if (wrapperRef.current.state.config.autoSpeak === false || wrapperRef.current.state.config.muteOutput) {
      dispatch({ type: "TTS_PLAYBACK_ENDED" });
      return;
    }
    // Abort any prior in-flight TTS so we never have two concurrent fetches.
    if (ttsAbortRef.current) {
      try {
        ttsAbortRef.current.abort();
      } catch {
        /* noop */
      }
    }
    const prefetched = ttsPrefetchRef.current?.text === text ? ttsPrefetchRef.current : null;
    if (prefetched) ttsPrefetchRef.current = null;
    const ctrl = prefetched?.controller || new AbortController();
    ttsAbortRef.current = ctrl;
    const timer = setTimeout(
      () => ctrl.abort(new DOMException("timeout", "TimeoutError")),
      TTS_TIMEOUT_MS
    );
    try {
      const preparedResponse = prefetched ? await prefetched.promise : null;
      const res = preparedResponse || await runtimeFetch("/api/voice/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: spokenExcerpt(text) }),
        signal: ctrl.signal,
      });
      if (epoch !== operationEpochRef.current || ttsAbortRef.current !== ctrl) { try { await res.body?.cancel(); } catch {} return; }
      if (!res.ok) {
        publishVoiceActivity({
          kind: "error",
          state: "error",
          title: "Voice synthesis failed",
          summary: `TTS returned status ${res.status}.`,
          source: "voice/tts",
        });
        dispatch({
          type: "TTS_FAILED",
          reason: `status_${res.status}`,
          statusCode: res.status,
        });
        return;
      }

      // Streaming path: MediaSource lets us play as bytes arrive instead of
      // waiting for the full MP3 to land. Same final audio, big perceptual
      // win on first-sound latency.
      const backend = res.headers.get("X-TTS-Backend") || "";
      const canStream =
        typeof window !== "undefined" &&
        typeof window.MediaSource !== "undefined" &&
        typeof window.MediaSource.isTypeSupported === "function" &&
        window.MediaSource.isTypeSupported('audio/mpeg') &&
        res.body &&
        backend.includes("stream");

      if (canStream) {
        await voiceFeedbackRef.current?.handoff.wait();
        if (epoch !== operationEpochRef.current || ttsAbortRef.current !== ctrl) { try { await res.body?.cancel(); } catch {} return; }
        // Barge-in race: the user may have started speaking before bytes
        // arrived. Cancel silently — no URL was created.
        if (wrapperRef.current.state.state !== "thinking") {
          try { res.body.cancel(); } catch { /* noop */ }
          return;
        }
        const ms = new MediaSource();
        const url = URL.createObjectURL(ms);
        // Hand the URL to the reducer; the shell pumps bytes into the
        // SourceBuffer in playAudio() — see how it detects MediaSource.
        ttsStreamRef.current = { mediaSource: ms, body: res.body };
        dispatch({ type: "TTS_DONE", url });
        return;
      }

      // Buffered fallback (edge-tts or MSE-less browser).
      const blob = await res.blob();
      await voiceFeedbackRef.current?.handoff.wait();
      if (epoch !== operationEpochRef.current || ttsAbortRef.current !== ctrl) return;
      if (blob.size < TTS_MIN_BYTES) {
        publishVoiceActivity({
          kind: "error",
          state: "error",
          title: "Voice synthesis failed",
          summary: "The generated audio was too small to play safely.",
          source: "voice/tts",
        });
        dispatch({
          type: "TTS_FAILED",
          reason: "blob_too_small",
          statusCode: res.status,
        });
        return;
      }
      if (wrapperRef.current.state.state !== "thinking") {
        return;
      }
      const url = URL.createObjectURL(blob);
      dispatch({ type: "TTS_DONE", url });
    } catch (err) {
      if (epoch !== operationEpochRef.current || ttsAbortRef.current !== ctrl || (ctrl.signal.aborted && ctrl.signal.reason?.name !== "TimeoutError")) return;
      const reason =
        ctrl.signal.reason?.name === "TimeoutError" ? "timeout_15s" : "network_error";
      publishVoiceActivity({
        kind: "error",
        state: "error",
        title: "Voice synthesis failed",
        summary: reason,
        source: "voice/tts",
      });
      dispatch({ type: "TTS_FAILED", reason });
    } finally {
      clearTimeout(timer);
      if (ttsAbortRef.current === ctrl) ttsAbortRef.current = null;
    }
  }, [publishVoiceActivity, stopVoiceFeedback]);

  // Keep one following phrase ready while the current phrase is audible.
  // This bounds synthesis work and avoids a network-sized pause at every
  // sentence boundary. Stop owns and aborts this request with current audio.
  useEffect(() => {
    const state = wrapper.state;
    const text = state.state === "speaking" && state.streamSpeechActive && state.config.autoSpeak !== false && !state.config.muteOutput ? state.streamSpeechQueue?.[0] : null;
    if (!text || ttsPrefetchRef.current) return;
    const controller = new AbortController();
    const prepared = { text, controller, promise: null };
    const timer = setTimeout(() => controller.abort(new DOMException("Voice prefetch timed out", "TimeoutError")), TTS_TIMEOUT_MS);
    prepared.promise = runtimeFetch("/api/voice/tts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: spokenExcerpt(text) }), signal: controller.signal,
    }).then(async (response) => {
      if (controller.signal.aborted || !response.ok) { await response.body?.cancel(); return null; }
      return response;
    }).catch(() => null).finally(() => clearTimeout(timer));
    ttsPrefetchRef.current = prepared;
  }, [wrapper.state.state, wrapper.state.streamSpeechActive, wrapper.state.streamSpeechQueue, wrapper.state.config.autoSpeak, wrapper.state.config.muteOutput, runtimeFetch]);

  const playAudio = useCallback((url) => {
    if (!url) return;
    // Tear down any still-running playback before starting the next clip.
    // Without this a barge-in (or a rapid new turn) leaves the previous clip's
    // 250ms stall interval and MediaSource stream reader running forever — the
    // interval later fires a spurious TTS_FAILED into the NEXT turn, and the
    // orphaned reader keeps draining a stream nobody plays (T-0009 fix B).
    if (currentPlaybackCleanupRef.current) {
      try { currentPlaybackCleanupRef.current(); } catch { /* noop */ }
      currentPlaybackCleanupRef.current = null;
    }
    let audio;
    try {
      const AudioClass = runtimeAudio();
      if (!AudioClass) throw new Error("Audio playback is unavailable");
      audio = primedPlaybackRef.current || new AudioClass();
      primedPlaybackRef.current = audio;
      audio.pause();
      audio.src = url;
      audio.currentTime = 0;
      audio.muted = false;
    } catch (err) {
      revokeOnce(url);
      dispatch({
        type: "TTS_FAILED",
        reason: `audio_error: ${err && err.message ? err.message : String(err)}`,
        url,
      });
      return;
    }
    currentTtsRef.current = audio;

    // Streaming attach: if callTTS stashed a MediaSource for this URL, plug
    // it in now and pump fetched bytes into a SourceBuffer as they arrive.
    // `cancelStream` lets the playback cleanup abort the reader on barge-in.
    let cancelStream = null;
    const streamHandoff = ttsStreamRef.current;
    if (streamHandoff && streamHandoff.mediaSource) {
      ttsStreamRef.current = null;
      const { mediaSource: ms, body } = streamHandoff;
      const reader = body.getReader();
      let sourceBuffer = null;
      let sawError = false;
      let pendingChunk = null;
      let fetchDone = false;
      // Barge-in abort: stop the read loop and release the reader so it can't
      // keep pumping bytes into a MediaSource that's no longer being played.
      cancelStream = () => {
        sawError = true;
        try { reader.cancel(); } catch { /* noop */ }
      };

      const handleStreamError = (reason) => {
        if (sawError) return;
        sawError = true;
        try { reader.cancel(); } catch { /* noop */ }
        try {
          if (ms.readyState === "open") ms.endOfStream("decode");
        } catch { /* noop */ }
        revokeOnce(url);
        dispatch({ type: "TTS_FAILED", reason: `stream_error: ${reason}`, url });
      };

      const finishStream = () => {
        if (sawError) return;
        try {
          if (ms.readyState === "open") ms.endOfStream();
        } catch { /* noop */ }
      };

      const pump = () => {
        if (sawError) return;
        if (pendingChunk == null) {
          if (fetchDone) {
            finishStream();
            return;
          }
          // Wait for next fetched chunk; pumpFetch will re-invoke pump.
          return;
        }
        if (!sourceBuffer || sourceBuffer.updating) return;
        const chunk = pendingChunk;
        pendingChunk = null;
        try {
          sourceBuffer.appendBuffer(chunk);
        } catch (err) {
          handleStreamError(err && err.message ? err.message : String(err));
        }
      };

      const pumpFetch = async () => {
        try {
          while (!sawError) {
            const { done, value } = await reader.read();
            if (done) {
              fetchDone = true;
              if (!sourceBuffer || !sourceBuffer.updating) finishStream();
              return;
            }
            if (!value || !value.byteLength) continue;
            // Wait until the current append finishes before queuing the next.
            while (sourceBuffer && sourceBuffer.updating) {
              await new Promise((r) => sourceBuffer.addEventListener("updateend", r, { once: true }));
              if (sawError) return;
            }
            pendingChunk = value;
            pump();
          }
        } catch (err) {
          handleStreamError(err && err.message ? err.message : String(err));
        }
      };

      const onSourceOpen = () => {
        try {
          sourceBuffer = ms.addSourceBuffer('audio/mpeg');
        } catch (err) {
          handleStreamError(err && err.message ? err.message : String(err));
          return;
        }
        sourceBuffer.addEventListener("updateend", pump);
        sourceBuffer.addEventListener("error", () => handleStreamError("sourcebuffer_error"));
        pumpFetch();
      };

      if (ms.readyState === "open") {
        onSourceOpen();
      } else {
        ms.addEventListener("sourceopen", onSourceOpen, { once: true });
      }
    }

    // Route to the selected output device when the browser supports
    // setSinkId(). Silently no-ops on browsers that don't (older Safari).
    const cfg = wrapperRef.current?.state?.config;
    const sinkId = cfg?.speakerDeviceId;
    if (sinkId && typeof audio.setSinkId === "function") {
      audio.setSinkId(sinkId).catch(() => {
        /* fall back to default output */
      });
    }

    // Honor the mute toggle.
    if (cfg?.muteOutput) {
      audio.muted = true;
    }

    let lastT = 0;
    let playbackStarted = false;
    let lastProgressAt = Date.now();
    const timing = { runId: wrapperRef.current.state.actionId, ttsStartedAt: finalTtsStartedAtRef.current, speechEndedAt: speechEndedAtRef.current };
    const stallId = setInterval(() => {
      if (audio.currentTime !== lastT) {
        if (!playbackStarted && timing.ttsStartedAt) publishVoiceActivity(answerAudioTimingRef.current({ ...timing, at: Date.now() }));
        playbackStarted = true;
        lastT = audio.currentTime;
        lastProgressAt = Date.now();
      } else if (Date.now() - lastProgressAt > (playbackStarted ? TTS_STALL_MS : 10000)) {
        teardownPlayback();
        try {
          audio.pause();
        } catch {
          /* noop */
        }
        revokeOnce(url);
        dispatch({ type: "TTS_FAILED", reason: "playback_stalled", url });
      }
    }, 250);

    // Single teardown for THIS clip: clears the stall interval, detaches the
    // ended/error listeners, and cancels the MediaSource stream reader. Every
    // terminal path (ended, error, stall, play-rejected) and barge-in
    // (stopAudio → currentPlaybackCleanupRef) routes through here, so no
    // interval or reader survives the clip that owns it (T-0009 fix B).
    let torndown = false;
    const teardownPlayback = () => {
      if (torndown) return;
      torndown = true;
      clearInterval(stallId);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
      if (cancelStream) {
        try { cancelStream(); } catch { /* noop */ }
      }
      if (currentPlaybackCleanupRef.current === teardownPlayback) {
        currentPlaybackCleanupRef.current = null;
      }
    };

    const onEnded = () => {
      playbackEndedAtRef.current = performance.now();
      teardownPlayback();
      revokeOnce(url);
      if (currentTtsRef.current === audio) currentTtsRef.current = null;
      dispatch({ type: "TTS_PLAYBACK_ENDED", url });
    };
    const onError = (e) => {
      teardownPlayback();
      revokeOnce(url);
      const msg = e && e.error ? String(e.error) : "audio_error";
      dispatch({ type: "TTS_FAILED", reason: `audio_error: ${msg}`, url });
    };
    audio.addEventListener("ended", onEnded, { once: true });
    audio.addEventListener("error", onError, { once: true });
    currentPlaybackCleanupRef.current = teardownPlayback;

    const playPromise = audio.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch((err) => {
        if (torndown) return;
        teardownPlayback();
        revokeOnce(url);
        dispatch({
          type: "TTS_FAILED",
          reason: `play_rejected: ${err && err.message ? err.message : String(err)}`,
          url,
        });
      });
    }
  }, []);

  const stopAudio = useCallback(() => {
    ttsPrefetchRef.current?.controller.abort();
    ttsPrefetchRef.current = null;
    playbackEndedAtRef.current = performance.now();
    // Tear down the currently-playing clip's stall interval, listeners, and
    // stream reader FIRST so barge-in doesn't leave them running across the
    // next turn (T-0009 fix B). Safe when nothing is playing.
    if (currentPlaybackCleanupRef.current) {
      try { currentPlaybackCleanupRef.current(); } catch { /* noop */ }
      currentPlaybackCleanupRef.current = null;
    }
    const audio = currentTtsRef.current;
    if (audio) {
      try {
        audio.pause();
      } catch {
        /* noop */
      }
      if (audio.src) revokeOnce(audio.src);
      if (currentTtsRef.current === audio) currentTtsRef.current = null;
    }
    const stream = ttsStreamRef.current;
    if (stream) {
      ttsStreamRef.current = null;
      try { stream.body?.cancel(); } catch { /* noop */ }
      try {
        if (stream.mediaSource && stream.mediaSource.readyState === "open") {
          stream.mediaSource.endOfStream();
        }
      } catch { /* noop */ }
    }
    if (ttsAbortRef.current) {
      try {
        ttsAbortRef.current.abort();
      } catch {
        /* noop */
      }
      ttsAbortRef.current = null;
    }
  }, []);

  // ---------- effect runner ----------

  const cancelRequests = useCallback(() => {
    setAcceptedActionId(null);
    stopVoiceFeedbackRef.current?.();
    for (const stream of answerStreamsRef.current.values()) stream.controller.abort();
    answerStreamsRef.current.clear();
    streamedRunsRef.current.clear();
    setPendingPermission(null);
    setPermissionError("");
    dispatch({ type: "STREAM_RESET" });
    operationEpochRef.current += 1;
    operationAbortRef.current.abort();
    operationAbortRef.current = new AbortController();
    // Detach immediately so a new gesture can acquire P2 while an uncancellable
    // browser permission prompt P1 is still unresolved. P1's epoch guard stops
    // its stream if it eventually resolves.
    pendingStreamPromiseRef.current = null;
    sttAbortRef.current?.abort();
    chatAbortRef.current?.abort();
    ttsAbortRef.current?.abort();
    ttsPrefetchRef.current?.controller.abort();
    ttsPrefetchRef.current = null;
    sttAbortRef.current = null;
    chatAbortRef.current = null;
    ttsAbortRef.current = null;
    latestBlobRef.current = null;
    for (const actionId of pendingRunsRef.current.keys()) {
      const textOnly = textRunIdsRef.current.has(actionId);
      cancelledRunIdsRef.current.add(actionId);
      runtimeFetch("/api/voice/runs", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: sessionIdRef.current, actionId }), signal: AbortSignal.timeout(10000) })
        .then(async (res) => {
          const json = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error("Cancellation could not be confirmed. Check Activity before retrying the task.");
          const run = json?.run;
          if (!run?.outcome) return;
          const entryId = `completion-${actionId}:cancelled`;
          spokenCompletionIdsRef.current.add(`${run.id || actionId}:failed`);
          dispatch({
            type: "SPEAK_COMPLETION",
            actionId,
            textOnly: true,
            isError: true,
            text: run.error || "Stop requested.",
            entryId,
            outcome: run.outcome,
          });
          if (run.outcome.execution?.active === true) {
            cancelledRunIdsRef.current.delete(actionId);
            pendingOutcomeRefreshRef.current.set(actionId, JSON.stringify(run.outcome));
            markRunPending(actionId, textOnly);
          }
        })
        .catch((error) => dispatch({ type: "CHAT_FAILED", error: error.message, code: "CANCEL_UNCONFIRMED", retryable: false }));
    }
    pendingRunsRef.current.clear();
    try { runtimeStorage()?.removeItem(pendingRunsStorageKey); } catch {}
  }, [markRunPending]);

  const enterChatResponseMode = useCallback(() => {
    const state = wrapperRef.current.state;
    pttGestureRef.current.reset();
    captureSourceRef.current = null;
    completionInputOwnershipRef.current = false;
    voiceInputGenerationRef.current += 1;
    operationAbortRef.current.abort();
    operationAbortRef.current = new AbortController();
    sttAbortRef.current?.abort();
    sttAbortRef.current = null;
    pendingStreamPromiseRef.current = null;
    if (["starting", "capturing"].includes(state.state)) {
      if (state.state === "capturing") latestBlobRef.current = null;
      void stopUtteranceRecorder(true);
    }
    stopAllTracks();
    void closeAudioContext();
    stopVoiceFeedbackRef.current?.();
    stopAudio();
    dispatch({ type: "RESPONSE_MODE_CHANGED", mode: "chat" });
  }, [closeAudioContext, stopAllTracks, stopUtteranceRecorder, stopAudio]);

  // Talk mode changes use the same non-destructive boundary as Talk → Chat:
  // stop local capture and playback without cancelling an acknowledged run.
  const suspendVoiceSurface = enterChatResponseMode;

  useEffect(() => {
    const previousMode = previousConversationModeRef.current;
    previousConversationModeRef.current = conversationMode;
    if (conversationMode === "chat" && previousMode !== "chat") enterChatResponseMode();
  }, [conversationMode, enterChatResponseMode]);

  // Tracks the last processed `effects` array reference so React 19 strict
  // mode double-mount doesn't re-execute the same imperative side-effects.
  const processedEffectsRef = useRef(0);
  // Separate renders can enqueue a new batch while an earlier teardown is
  // still awaiting recorder/context shutdown. Serialize batches so a new PTT
  // stream cannot be stopped by the previous conversation's cleanup.
  const effectQueueRef = useRef(Promise.resolve());

  useEffect(() => {
    const effects = wrapper.effects.filter((effect) => effect.effectId > processedEffectsRef.current);
    if (effects.length === 0) return;
    processedEffectsRef.current = effects.at(-1).effectId;
    dispatch({ type: "ACK_EFFECTS", through: processedEffectsRef.current });

    const enqueuedEpoch = operationEpochRef.current;
    const enqueuedVoiceGeneration = voiceInputGenerationRef.current;
    const enqueuedMicrophoneGeneration = microphoneAcquisitionGenerationRef.current;
    const isCancellationBatch = effects.some((effect) => effect.kind === "cancelRequests");
    effectQueueRef.current = effectQueueRef.current.catch(() => {}).then(async () => {
      let epoch = enqueuedEpoch;
      if (!isCancellationBatch && epoch !== operationEpochRef.current) return;
      for (const fx of effects) {
        if (epoch !== operationEpochRef.current) break;
        if (isMicrophoneGenerationEffect(fx) && enqueuedMicrophoneGeneration !== microphoneAcquisitionGenerationRef.current) {
          continue;
        }
        if (["requestPermission", "syncContinuous", "startRecorder", "callSTT", "releaseMicForPlayback", "callTTS", "playAudio"].includes(fx.kind) && enqueuedVoiceGeneration !== voiceInputGenerationRef.current) {
          if (fx.kind === "playAudio") {
            revokeOnce(fx.url);
            dispatch({ type: "TTS_PLAYBACK_ENDED", url: fx.url });
          }
          continue;
        }
        try {
          switch (fx.kind) {
            case "cancelRequests":
              cancelRequests();
              epoch = operationEpochRef.current;
              break;
            case "syncContinuous":
              if (fx.on) {
                if (conversationModeRef.current === "chat") break;
                await ensureMicAndVad();
              }
              break;
            case "startRecorder":
              if (conversationModeRef.current === "chat") break;
              if (fx.ptt && !pttGestureRef.current.isHeld()) break;
              // Lazily ensure the mic stream and audio context exist before recording.
              // PTT mode releases these between turns to let macOS flip the
              // Bluetooth headset back to A2DP for full-quality TTS playback.
              if (recorderStopRef.current) await recorderStopRef.current;
              if (enqueuedMicrophoneGeneration !== microphoneAcquisitionGenerationRef.current || epoch !== operationEpochRef.current) break;
              if (!mediaStreamRef.current || !audioContextRef.current) {
                await ensureMicAndVad();
              }
              if (enqueuedMicrophoneGeneration !== microphoneAcquisitionGenerationRef.current || epoch !== operationEpochRef.current) break;
              if (wrapperRef.current.state.continuousRequested && captureSourceRef.current === "ptt" && speechDetectorRef.current) {
                const detector = speechDetectorRef.current;
                const pause = speechDetectorControlRef.current.catch(() => {}).then(async () => {
                  if (speechDetectorRef.current === detector) await detector.pause?.();
                });
                speechDetectorControlRef.current = pause;
                try {
                  await pause;
                } catch {
                  captureSourceRef.current = null;
                  dispatch({ type: "CAPTURE_FAILED", stage: "microphone", code: "VAD_PAUSE_FAILED", error: "Push to talk could not take control of the microphone. Retry voice capture.", retryable: true });
                  break;
                }
              }
              if (enqueuedMicrophoneGeneration !== microphoneAcquisitionGenerationRef.current || epoch !== operationEpochRef.current || (fx.ptt && !pttGestureRef.current.isHeld()) || !["starting", "capturing"].includes(wrapperRef.current.state.state)) break;
              startUtteranceRecorder();
              break;
            case "stopRecorder":
              await stopUtteranceRecorder(!!fx.discard);
              break;
            case "releaseMicForPlayback":
              // PTT-only: now that the audio is captured, fully release the
              // mic so the OS can switch the Bluetooth headset back to A2DP
              // before TTS plays. Continuous mode keeps the mic open.
              releaseMicForPlayback();
              break;
            case "stopAllTracks":
              stopAllTracks();
              break;
            case "closeAudioContext":
              await closeAudioContext();
              break;
            case "stopVisualizer":
              // The visualizer canvas is owned by VoiceDock; it observes
              // wrapper.state.state and tears its own RAF down.
              break;
            case "callSTT":
              await callSTT();
              break;
            case "callChat":
              await callChat(fx.text, fx.textOnly === true, fx.preserveContinuous === true);
              break;
            case "callTTS":
              await callTTS(fx.text);
              break;
            case "playAudio":
              if (shouldSuppressVoiceOutput(conversationModeRef.current)) {
                revokeOnce(fx.url);
                dispatch({ type: "TTS_PLAYBACK_ENDED", url: fx.url });
              } else {
                playAudio(fx.url);
              }
              break;
            case "stopAudio":
              stopAudio();
              break;
            case "revokeURL":
              revokeOnce(fx.url);
              break;
            case "requestPermission":
              if (conversationModeRef.current === "chat") break;
              await requestPermission();
              break;
            case "emitActivity":
              emitActivity(fx);
              break;
            default:
              break;
          }
        } catch (err) {
          dispatch({
            type: "TEARDOWN_STEP_FAILED",
            step: fx.kind,
            message: err && err.message ? err.message : String(err),
          });
        }
      }
    });

    // Commands outlive unrelated renders. Cancellation is explicit and uses
    // the operation epoch; a config poll must never cancel a recording upload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wrapper.effects]);

  // ---------- self-recovery: apply a pending bundle update (Law 9) ----------
  //
  // Reload our own bundle so the redeployed server code takes effect. Guarded
  // so we never reload mid-turn: callers pass the current voice state and we
  // only reload from a rest state. When forced (user tapped "Update ready") we
  // reload regardless. Ends the "reload the Tauri window" chore.
  const applyUpdate = useCallback((opts = {}) => {
    if (typeof window === "undefined") return;
    const force = !!opts.force;
    if (!force && !canReloadNow(wrapperRef.current.state.state)) return;
    try {
      window.location.reload();
    } catch {
      /* noop */
    }
  }, []);

  // ---------- server status polling + stale-bundle self-recovery ----------

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const res = await runtimeFetch("/api/voice/status");
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        const next =
          data && typeof data.status === "string" ? data.status : "stopped";
        setServerStatus(next);
        if (data && data.config && typeof data.config === "object") {
          dispatch({ type: "UPDATE_CONFIG", partial: data.config });
        }
        // Law 9: the server carries the build id it was built with. If it
        // differs from ours, the server was redeployed and this bundle is
        // stale. Flag the update (sticky) so the dock shows a one-tap refresh,
        // and auto-reload the moment we're at rest so the fix lands without the
        // user lifting a finger — but never mid-utterance / mid-speech.
        const serverBuildId = data && data.buildId;
        if (isStaleBundle(BUILD_ID, serverBuildId)) {
          if (!updateReadyRef.current) {
            setUpdateReady(true);
            publishVoiceActivity({
              kind: "info",
              state: "active",
              title: "Update ready",
              summary:
                "A newer build is live on the server. Refreshing at the next idle moment.",
              source: "voice/recovery",
            });
          }
          if (canReloadNow(wrapperRef.current.state.state)) {
            applyUpdate();
          }
        }
      } catch {
        if (!cancelled) setServerStatus("stopped");
      }
    };
    check();
    const id = setInterval(check, SERVER_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [applyUpdate, publishVoiceActivity]);

  // ---------- completion-speech poller (T-0008 fix B) ----------
  //
  // Detached action/data runs write their completion into the voice-activity
  // store. We poll that store for THIS session's completions and speak each
  // once: the pure selectSpeakableCompletion() picks the next unspoken,
  // post-page-load completion; we speak it only from a rest state (holding
  // while mid-interaction) and mark it spoken once handled. While a run is
  // pending we poll fast (~2s) so the reply doesn't feel dead; otherwise we
  // idle at the slow cadence. Pending runs TTL out so a lost completion can't
  // pin us to the fast cadence forever.
  useEffect(() => {
    let stopped = false;
    let timer = null;
    let polling = false;

    const havePendingRun = () => {
      const now = Date.now();
      let alive = false;
      for (const [id, at] of pendingRunsRef.current) {
        if (now - at > COMPLETION_PENDING_TTL_MS) {
          answerStreamsRef.current.get(id)?.controller.abort();
          answerStreamsRef.current.delete(id);
          streamedRunsRef.current.delete(id);
          setPendingPermission((current) => current?.actionId === id ? null : current);
          pendingRunsRef.current.delete(id);
          pendingOutcomeRefreshRef.current.delete(id);
          dispatch({ type: "SPEAK_COMPLETION", actionId: id, textOnly: true, isError: true, text: "Hermes could not confirm this request’s completion. Check Activity before retrying.", entryId: `completion-${id}:timeout` });
          try { runtimeStorage()?.setItem(pendingRunsStorageKey, JSON.stringify([...pendingRunsRef.current].map(([id, at]) => ({ id, at, textOnly: textRunIdsRef.current.has(id) })))); } catch {}
        } else {
          alive = true;
        }
      }
      return alive;
    };

    const tick = async () => {
      if (stopped || polling) return;
      polling = true;
      const sid = sessionIdRef.current;
      try {
        const pending = [...pendingRunsRef.current.keys()];
        const results = await Promise.allSettled(pending.map(async (actionId) => {
          const streamed = streamedRunsRef.current.get(actionId);
          const terminal = streamed && ["complete", "error", "cancelled", "interrupted"].includes(streamed.state) && !pendingOutcomeRefreshRef.current.has(actionId);
          const res = terminal ? { ok: true, status: 200 } : await runtimeFetch(`/api/voice/runs?sessionId=${encodeURIComponent(sid)}&actionId=${encodeURIComponent(actionId)}`, { cache: "no-store", signal: AbortSignal.timeout(10000) });
          const run = terminal ? streamed : (await res.json()).run;
          if (stopped || !pendingRunsRef.current.has(actionId)) return null;
          if (!run && (res.ok || res.status === 404) && Date.now() - pendingRunsRef.current.get(actionId) > 30000) {
            return { id: `${actionId}:failed`, source: "voice/action", sessionId: sid, state: "error", summary: "Hermes could not find this request. Check Activity before sending it again.", updatedAt: new Date().toISOString(), textOnly: true };
          }
          if (!res.ok || !run) return null;
          observeRun(run);
          if (!["complete", "error", "cancelled", "interrupted"].includes(run.state)) {
            if (run.statusLabel) {
              dispatch({ type: "REQUEST_PROGRESS", label: run.statusLabel });
              const cue = !textRunIdsRef.current.has(actionId) ? selectProgressVoiceFeedback(run.statusLabel) : null;
              if (cue) void playVoiceFeedback(cue, `${actionId}:stage:${run.statusLabel}`, actionId, run.statusLabel);
            }
            return null;
          }
          return { id: `${run.id || actionId}:${run.state === "complete" ? "complete" : "failed"}`, source: "voice/action", sessionId: sid, state: run.state === "complete" ? "complete" : "error", summary: run.response || run.error || "The task ended without a response.", partialResponse: run.partialResponse || "", outcome: run.outcome || null, updatedAt: new Date().toISOString(), textOnly: textRunIdsRef.current.has(actionId) };
        }));
        if (stopped) return;
        const events = results.filter((item) => item.status === "fulfilled" && item.value).map((item) => item.value);
        // Legacy runs still publish activity. New requests recover their full
        // answer from the durable run endpoint, even after a page reload.
        if (!events.length) {
          const res = await runtimeFetch(`/api/voice/activity?sessionId=${encodeURIComponent(sid)}&limit=40`, { cache: "no-store", signal: AbortSignal.timeout(10000) });
          const json = await res.json().catch(() => ({}));
          if (stopped) return;
          events.push(...(Array.isArray(json?.events) ? json.events : []).filter((event) => !pendingRunsRef.current.has(completionRunId(event))));
        }
        for (const event of events) {
          const runId = completionRunId(event);
          if (!pendingOutcomeRefreshRef.current.has(runId) || !event.outcome) continue;
          const signature = JSON.stringify(event.outcome);
          if (signature !== pendingOutcomeRefreshRef.current.get(runId)) {
            pendingOutcomeRefreshRef.current.set(runId, signature);
            dispatch({ type: "UPDATE_RUN_OUTCOME", actionId: runId, outcome: event.outcome });
          }
          if (event.outcome.execution?.active !== true) {
            pendingOutcomeRefreshRef.current.delete(runId);
            pendingRunsRef.current.delete(runId);
            try { runtimeStorage()?.setItem(pendingRunsStorageKey, JSON.stringify([...pendingRunsRef.current].map(([id, at]) => ({ id, at, textOnly: textRunIdsRef.current.has(id) })))); } catch {}
          }
        }
        // Speak at most one completion per tick so we never queue two TTS
        // synths back to back; the next tick handles the following one.
        const next = selectSpeakableCompletion(events.filter((event) => !cancelledRunIdsRef.current.has(completionRunId(event))), {
          spokenIds: spokenCompletionIdsRef.current,
          pageLoadedAt: pageLoadedAtRef.current,
          sessionId: sid,
        });
        if (next) {
          if (next.state === "error") stopVoiceFeedbackRef.current?.();
          else retireVoiceFeedbackRef.current?.();
          const textOnly = shouldSuppressVoiceOutput(conversationModeRef.current, isTextCompletion(next, textRunIdsRef.current));
          if (canHandleCompletionNow(wrapperRef.current.state, {
            actionId: completionRunId(next),
            textOnly,
          }, { inputOwned: completionInputOwnershipRef.current })) {
            // Handled: mark spoken (whether it speaks or is skipped for
            // autoSpeak/mute — both are terminal in the reducer) and clear its
            // pending run so we can fall back to the idle cadence.
            spokenCompletionIdsRef.current.add(String(next.id));
            // Bound the spoken-id set (T-0009 fix B): the activity store the
            // poller reads is itself capped, so an id far in the past can no
            // longer appear and never needs deduping. Drop the oldest once we
            // exceed the store's window so this set can't grow for the life of
            // the session.
            if (spokenCompletionIdsRef.current.size > 200) {
              const oldest = spokenCompletionIdsRef.current.values().next().value;
              if (oldest !== undefined) spokenCompletionIdsRef.current.delete(oldest);
            }
            const runId = completionRunId(next);
            const stream = answerStreamsRef.current.get(runId);
            const streamHandled = Boolean(stream?.buffer.received);
            if (streamHandled && next.state !== "error") {
              dispatch({
                type: "STREAM_SPEECH_CHUNKS",
                actionId: runId,
                textOnly: shouldSuppressVoiceOutput(conversationModeRef.current, textOnly),
                chunks: stream.buffer.finish(next.summary),
              });
            }
            stream?.controller.abort();
            answerStreamsRef.current.delete(runId);
            streamedRunsRef.current.delete(runId);
            setPendingPermission((current) => current?.actionId === runId ? null : current);
            if (next.outcome?.execution?.active === true) {
              pendingOutcomeRefreshRef.current.set(runId, JSON.stringify(next.outcome));
            } else {
              pendingOutcomeRefreshRef.current.delete(runId);
              pendingRunsRef.current.delete(runId);
            }
            try { runtimeStorage()?.setItem(pendingRunsStorageKey, JSON.stringify([...pendingRunsRef.current].map(([id, at]) => ({ id, at, textOnly: textRunIdsRef.current.has(id) })))); } catch {}
            dispatch({
              type: "SPEAK_COMPLETION",
              text: next.summary,
              entryId: `completion-${next.id}`,
              textOnly: shouldSuppressVoiceOutput(conversationModeRef.current, textOnly),
              isError: next.state === "error",
              actionId: runId,
              streamHandled,
              partialResponse: next.partialResponse,
              outcome: next.outcome || null,
            });
          }
          // else: HOLD — leave it unspoken and retry on the next tick.
        }

      } catch {
        /* transient — retry on the next tick */
      } finally {
        polling = false;
        if (!stopped) {
          const delay = havePendingRun() ? COMPLETION_POLL_FAST_MS : COMPLETION_POLL_IDLE_MS;
          timer = setTimeout(tick, delay);
        }
      }
    };
    completionWakeRef.current = () => { if (timer) clearTimeout(timer); timer = setTimeout(tick, 150); };

    tick();
    return () => {
      stopped = true;
      completionWakeRef.current = null;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Edge's voice catalog requires a provider request. Fetch only when voice
  // settings need it, and share a single request across settings surfaces.
  const loadVoices = useCallback(async () => {
    if (wrapperRef.current.state.voices.length) return;
    if (voicesRequestRef.current) return voicesRequestRef.current;
    const request = runtimeFetch("/api/voice/voices")
      .then((response) => {
        if (!response.ok) throw new Error("Voice catalog unavailable");
        return response.json();
      })
      .then((data) => {
        dispatch({ type: "LOAD_VOICES", voices: Array.isArray(data?.voices) ? data.voices : [] });
      })
      .catch(() => {})
      .finally(() => { voicesRequestRef.current = null; });
    voicesRequestRef.current = request;
    return request;
  }, []);

  useEffect(() => {
    if (wrapper.state.settingsOpen) loadVoices();
  }, [wrapper.state.settingsOpen, loadVoices]);

  // ---------- Tauri voice-toggle event ----------

  useEffect(() => {
    const events = typeof window !== "undefined" ? window.__TAURI__?.event : null;
    if (typeof events?.listen !== "function") return undefined;
    return subscribeNativeVoiceEvent(
      (name, handler) => events.listen(name, handler),
      () => toggleContinuousRef.current?.(),
    );
  }, []);

  // ---------- global Option+Shift+H hotkey ----------

  useEffect(() => {
    const detector = speechDetectorRef.current;
    if (!detector) return;
    const action = !wrapper.state.continuousRequested
      ? "pause"
      : wrapper.state.state === "listening"
      ? "start"
      : (["transcribing", "thinking", "speaking"].includes(wrapper.state.state) ? "pause" : null);
    if (!action) return;
    speechDetectorControlRef.current = speechDetectorControlRef.current.catch(() => {}).then(async () => {
      if (speechDetectorRef.current !== detector || (action === "start" && !wrapperRef.current.state.continuousRequested)) return;
      await detector[action]?.();
    }).catch(() => {
      if (action === "start" && speechDetectorRef.current === detector) {
        dispatch({ type: "CAPTURE_FAILED", stage: "microphone", code: "VAD_RESUME_FAILED", error: "Speech detection could not resume. Push to talk is still available.", retryable: true });
      }
    });
  }, [wrapper.state.continuousRequested, wrapper.state.state]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onKeyDown = (event) => {
      if (!event.repeat && !event.isComposing && !event.defaultPrevented && event.altKey && event.shiftKey && (event.code === "KeyH" || event.key?.toLowerCase() === "h")) {
        event.preventDefault();
        toggleContinuousRef.current?.();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // ---------- unmount cleanup ----------

  useEffect(() => {
    return () => {
      pttGestureRef.current.reset();
      pendingStreamPromiseRef.current = null;
      operationEpochRef.current += 1;
      operationAbortRef.current.abort();
      // React StrictMode replays effect setup after cleanup on the same refs.
      operationAbortRef.current = new AbortController();
      stopVoiceFeedbackRef.current?.();
      for (const stream of answerStreamsRef.current.values()) stream.controller.abort();
      answerStreamsRef.current.clear();
      streamedRunsRef.current.clear();
      sttAbortRef.current?.abort();
      chatAbortRef.current?.abort();
      ttsPrefetchRef.current?.controller.abort();
      ttsPrefetchRef.current = null;
      try {
        const rec = mediaRecorderRef.current;
        if (rec && rec.state !== "inactive") {
          rec.onstop = null;
          rec.stop();
        }
      } catch {
        /* noop */
      }
      mediaRecorderRef.current = null;
      if (speechDetectorReadyTimerRef.current) clearTimeout(speechDetectorReadyTimerRef.current);
      speechDetectorReadyTimerRef.current = null;
      if (speechDetectorSignalTimerRef.current) clearTimeout(speechDetectorSignalTimerRef.current);
      speechDetectorSignalTimerRef.current = null;
      speechDetectorGenerationRef.current += 1;
      const detector = speechDetectorRef.current;
      speechDetectorRef.current = null;
      if (detector) void Promise.resolve(detector.destroy?.()).catch(() => {});
      const stream = mediaStreamRef.current;
      if (stream) {
        try {
          stream.getTracks().forEach((t) => t.stop());
        } catch {
          /* noop */
        }
        mediaStreamRef.current = null;
      }
      const ctx = audioContextRef.current;
      if (ctx && ctx.state !== "closed") {
        ctx.close().catch(() => {});
      }
      audioContextRef.current = null;
      // Tear down the active clip's stall interval / stream reader / listeners
      // before dropping the audio element, so nothing outlives the component
      // (T-0009 fix B).
      if (currentPlaybackCleanupRef.current) {
        try { currentPlaybackCleanupRef.current(); } catch { /* noop */ }
        currentPlaybackCleanupRef.current = null;
      }
      const audio = currentTtsRef.current;
      if (audio) {
        try {
          audio.pause();
        } catch {
          /* noop */
        }
        if (audio.src) revokeOnce(audio.src);
      }
      currentTtsRef.current = null;
      const primedAudio = primedPlaybackRef.current;
      if (primedAudio && primedAudio !== audio) {
        try { primedAudio.pause(); } catch { /* noop */ }
      }
      primedPlaybackRef.current = null;
      const ttsStream = ttsStreamRef.current;
      if (ttsStream) {
        ttsStreamRef.current = null;
        try { ttsStream.body?.cancel(); } catch { /* noop */ }
        try {
          if (ttsStream.mediaSource && ttsStream.mediaSource.readyState === "open") {
            ttsStream.mediaSource.endOfStream();
          }
        } catch { /* noop */ }
      }
      if (ttsAbortRef.current) {
        try {
          ttsAbortRef.current.abort();
        } catch {
          /* noop */
        }
        ttsAbortRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- public commands ----------

  const toggleContinuous = useCallback(
    () => {
      if (conversationModeRef.current === "chat") return false;
      const state = wrapperRef.current.state;
      pttGestureRef.current.reset();
      if (!state.continuousRequested && ["idle", "error"].includes(state.state)) {
        completionInputOwnershipRef.current = true;
        primeAudioStack();
        void warmVoiceRuntime();
        voiceStartupAtRef.current = Date.now();
        if (!runtimeRef.current?.createSpeechDetector) void preloadContinuousSpeechDetector().catch(() => {});
      }
      const pendingStartup = state.permission === "pending" || state.state === "starting";
      const requestsCancelled = state.continuousRequested || !["idle", "error"].includes(state.state);
      if (requestsCancelled) cancelRequests();
      if (requestsCancelled) completionInputOwnershipRef.current = false;
      if (pendingStartup) {
        stopAllTracks(); void closeAudioContext();
      }
      dispatch({ type: "TOGGLE_CONTINUOUS", teardownHandled: pendingStartup, requestsCancelled });
    },
    [cancelRequests, closeAudioContext, primeAudioStack, stopAllTracks, warmVoiceRuntime]
  );
  toggleContinuousRef.current = toggleContinuous;
  const startPushToTalk = useCallback(() => {
    if (conversationModeRef.current === "chat") return false;
    const state = wrapperRef.current.state;
    if (!pttGestureRef.current.begin(state)) return false;
    if (state.state === "speaking") {
      cancelRequests();
      stopAudio();
    }
    // Keep WebKit activation inside the accepted press, including callers
    // that do not separately know about audio-stack priming.
    primeAudioStack();
    void warmVoiceRuntime();
    captureSubmissionCommittedRef.current = false;
    completionInputOwnershipRef.current = true;
    captureSourceRef.current = "ptt";
    dispatch({ type: "START_PTT" });
    return true;
  }, [cancelRequests, primeAudioStack, stopAudio, warmVoiceRuntime]);
  const finishPushToTalk = useCallback((discard = false) => {
    if (conversationModeRef.current === "chat") {
      pttGestureRef.current.reset();
      return false;
    }
    const state = wrapperRef.current.state;
    const pendingStartup = !mediaRecorderRef.current || mediaRecorderRef.current.state === "inactive";
    if (!pttGestureRef.current.finish({ startup: pendingStartup })) return false;
    const synchronousTeardown = pendingStartup && !state.continuousRequested;
    if (synchronousTeardown) {
      // A release can beat the first React commit. Invalidate the permission
      // request from the synchronous gesture, not the committed view state.
      operationEpochRef.current += 1;
      operationAbortRef.current.abort();
      operationAbortRef.current = new AbortController();
      stopAllTracks(); void closeAudioContext();
    }
    captureSubmissionCommittedRef.current = !discard;
    completionInputOwnershipRef.current = !discard;
    captureSourceRef.current = null;
    dispatch({ type: discard ? "CANCEL_PTT" : "STOP_PTT", teardownHandled: synchronousTeardown });
    return true;
  }, [closeAudioContext, stopAllTracks]);
  const stopPushToTalk = useCallback(() => finishPushToTalk(false), [finishPushToTalk]);
  const cancelPushToTalk = useCallback(() => finishPushToTalk(true), [finishPushToTalk]);
  const retryPermission = useCallback(
    () => {
      if (conversationModeRef.current === "chat") return false;
      dispatch({ type: "RETRY_PERMISSION" });
      return true;
    },
    []
  );
  const updateConfig = useCallback(async (partial, { persist = true } = {}) => {
    if (!partial || typeof partial !== "object") return;
    const hasMicrophoneSelection = Object.hasOwn(partial, "micDeviceId");
    const nextMicrophone = typeof partial.micDeviceId === "string" ? partial.micDeviceId : "";
    const microphoneChanged = hasMicrophoneSelection && nextMicrophone !== (wrapperRef.current.state.config?.micDeviceId || "");
    if (microphoneChanged) {
      const state = wrapperRef.current.state;
      invalidateMicrophoneInput(state);
      dispatch({ type: "MIC_INPUT_CHANGED", partial: { ...partial, micDeviceId: nextMicrophone } });
    } else {
      dispatch({ type: "UPDATE_CONFIG", partial });
    }
    // Models has already persisted its choice through the validated model route.
    if (!persist) return true;
    const saveId = ++configSaveSequenceRef.current;
    setConfigSaveStatus("saving");
    setConfigSaveError("");
    // Serialize writes so rapid changes reach disk in the user's edit order.
    const save = configSaveQueueRef.current.catch(() => {}).then(async () => {
      const res = await runtimeFetch("/api/voice/chat", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(partial),
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) throw new Error("Your last change could not be saved. Try that setting again.");
    });
    configSaveQueueRef.current = save;
    try {
      await save;
      if (saveId === configSaveSequenceRef.current) setConfigSaveStatus("saved");
      return true;
    } catch {
      if (saveId === configSaveSequenceRef.current) {
        setConfigSaveStatus("error");
        setConfigSaveError("Your last change could not be saved. Try that setting again.");
      }
      return false;
    }
  }, [invalidateMicrophoneInput, runtimeFetch]);
  const sendText = useCallback(async (text) => {
    const trimmed = String(text == null ? "" : text).trim();
    if (!trimmed) return;
    if (trimmed.length > MAX_USER_TEXT) {
      dispatch({ type: "CHAT_FAILED", error: `Messages can contain up to ${MAX_USER_TEXT.toLocaleString()} characters. Shorten this message and send again.`, code: "MESSAGE_TOO_LONG", retryable: false });
      return false;
    }
    if (submissionLockRef.current || !["idle", "listening", "error"].includes(wrapperRef.current.state.state)) return false;
    submissionLockRef.current = true;
    setAcceptedActionId(null);
    sttMsRef.current = 0;
    operationEpochRef.current += 1;
    dispatch({ type: "STT_OK", text: trimmed, textOnly: true, preserveContinuous: wrapperRef.current.state.continuousRequested });
    return true;
  }, []);
  const cancelCurrent = useCallback(() => {
    pttGestureRef.current.reset();
    completionInputOwnershipRef.current = false;
    cancelRequests();
    stopAudio();
    dispatch({ type: "CANCEL_CURRENT", requestsCancelled: true });
  }, [cancelRequests, stopAudio]);
  const releasePrimedAudio = useCallback(() => {
    const state = wrapperRef.current.state;
    if (!state.continuousRequested && ["idle", "error"].includes(state.state)) {
      operationEpochRef.current += 1;
      stopAllTracks();
      void closeAudioContext();
    }
  }, [stopAllTracks, closeAudioContext]);
  const retryLastRequest = useCallback(() => {
    if (!wrapperRef.current.state.lastError?.retryable || !["idle", "listening", "error"].includes(wrapperRef.current.state.state)) return false;
    const request = lastRequestRef.current;
    if (!request) return false;
    setAcceptedActionId(null);
    operationEpochRef.current += 1;
    if (request.kind === "stt") {
      latestBlobRef.current = request.blob;
      dispatch({ type: "RETRY_STT" });
    } else {
      dispatch({ type: "RETRY_CHAT", text: request.text, textOnly: request.textOnly, preserveContinuous: request.preserveContinuous });
    }
    return true;
  }, []);
  const openSettings = useCallback(
    () => dispatch({ type: "OPEN_SETTINGS" }),
    []
  );
  const closeSettings = useCallback(
    () => dispatch({ type: "CLOSE_SETTINGS" }),
    []
  );

  // ---------- context value ----------

  const value = useMemo(
    () => ({
      ...wrapper.state,
      // Provider-owned overrides for fields the reducer does not manage.
      serverStatus,
      acceptedActionId,
      conversationMode,
      configSaveStatus,
      configSaveError,
      reduceMotion: !!reduceMotion,
      sessionId: sessionIdRef.current,
      // Commands.
      toggleContinuous,
      startPushToTalk,
      stopPushToTalk,
      cancelPushToTalk,
      retryPermission,
      updateConfig,
      loadVoices,
      sendText,
      cancelCurrent,
      suspendVoiceSurface,
      retryLastRequest,
      releasePrimedAudio,
      canRetry: !!wrapper.state.lastError?.retryable && !!lastRequestRef.current,
      runtimeStatus,
      runtimeError,
      pendingPermission,
      permissionSaving,
      permissionError,
      respondToPermission,
      openSettings,
      closeSettings,
      // Law 1: run the WebKit-gated audio-stack init synchronously in the
      // press gesture BEFORE dispatching, so one press reaches listening.
      primeAudioStack,
      // Law 9: a newer server build is live; the dock surfaces a one-tap
      // refresh, and applyUpdate reloads this stale bundle.
      buildId: BUILD_ID,
      updateReady,
      applyUpdate,
    }),
    [
      wrapper.state,
      serverStatus,
      acceptedActionId,
      conversationMode,
      configSaveStatus,
      configSaveError,
      runtimeStatus,
      runtimeError,
      pendingPermission,
      permissionSaving,
      permissionError,
      respondToPermission,
      reduceMotion,
      toggleContinuous,
      startPushToTalk,
      stopPushToTalk,
      cancelPushToTalk,
      retryPermission,
      updateConfig,
      loadVoices,
      sendText,
      cancelCurrent,
      suspendVoiceSurface,
      retryLastRequest,
      releasePrimedAudio,
      openSettings,
      closeSettings,
      primeAudioStack,
      updateReady,
      applyUpdate,
    ]
  );

  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>;
}
