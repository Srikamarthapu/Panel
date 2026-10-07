export const VOICE_FEEDBACK_MODEL = "eleven_flash_v2_5";
const CACHE_NAME = "hermes-voice-feedback-v1";
const CACHE_PATH = "/__hermes_voice_feedback__/";
const MAX_PERSISTED_CUES = 8;

// Lets a ready answer take over from a short acknowledgement without cutting
// one that is already audible. A cue that has not started is retired at once;
// a started cue gets a bounded chance to finish while answer audio is prepared.
export function createVoiceFeedbackHandoff({ cancelPlayback = () => {}, maxWaitMs = 4000 } = {}) {
  let started = false;
  let settled = false;
  let resolveDone;
  let waitTimer = null;
  let waitPromise = null;
  const done = new Promise((resolve) => { resolveDone = resolve; });

  const settle = (reason) => {
    if (settled) return false;
    settled = true;
    if (waitTimer !== null) clearTimeout(waitTimer);
    waitTimer = null;
    resolveDone(reason);
    return true;
  };

  const cancel = () => {
    if (!settle("cancelled")) return false;
    try { cancelPlayback(); } catch { /* cancellation must always settle */ }
    return true;
  };

  return {
    get started() { return started; },
    done,
    markStarted() {
      if (settled) return false;
      started = true;
      return true;
    },
    finish() { return settle("finished"); },
    cancel,
    retire() {
      if (started) return false;
      if (!settle("retired")) return false;
      try { cancelPlayback(); } catch { /* stale preparation is best effort */ }
      return true;
    },
    wait() {
      if (!started) return Promise.resolve("not-started");
      if (settled) return done;
      if (!waitPromise) {
        waitPromise = done;
        waitTimer = setTimeout(cancel, Math.max(0, Number(maxWaitMs) || 0));
      }
      return waitPromise;
    },
  };
}

// Preparation never plays audio. The caller gates playback on accepted work,
// and owns cancellation if the request fails, finishes quickly, or is stopped.
export function prepareVoiceFeedbackAudio({ phrase, signature, cache, fetcher = globalThis.fetch, minBytes = 256 }) {
  const cacheKey = `${signature}:${VOICE_FEEDBACK_MODEL}:${phrase}`;
  const controller = new AbortController();
  const prepared = { controller, signature, cacheKey, requestedAt: Date.now(), promise: null };
  const timeout = setTimeout(() => controller.abort(new DOMException("Voice feedback timed out", "TimeoutError")), 10000);
  controller.signal.addEventListener("abort", () => clearTimeout(timeout), { once: true });
  prepared.promise = (async () => {
    const blob = cache?.get(cacheKey) || await readPersistedVoiceFeedback(signature, phrase);
    if (controller.signal.aborted) return null;
    if (blob?.size >= minBytes) { cache?.set(cacheKey, blob); return { blob }; }
    const response = await fetcher("/api/voice/tts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: phrase, modelId: VOICE_FEEDBACK_MODEL }), signal: controller.signal,
    });
    if (controller.signal.aborted || !response.ok) {
      try { await response.body?.cancel(); } catch { /* noop */ }
      return null;
    }
    return { response };
  })().catch(() => null).finally(() => clearTimeout(timeout));
  return prepared;
}

async function cacheRequestKey(signature, phrase, modelId = VOICE_FEEDBACK_MODEL) {
  const value = JSON.stringify([signature, modelId, phrase]);
  if (globalThis.crypto?.subtle) {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return `${CACHE_PATH}${Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  return `${CACHE_PATH}${encodeURIComponent(value)}`;
}

export async function readPersistedVoiceFeedback(signature, phrase, modelId = VOICE_FEEDBACK_MODEL) {
  if (!globalThis.caches) return null;
  try {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(await cacheRequestKey(signature, phrase, modelId));
    return hit?.ok ? await hit.blob() : null;
  } catch {
    return null;
  }
}

export async function persistVoiceFeedback(signature, phrase, blob, modelId = VOICE_FEEDBACK_MODEL) {
  if (!globalThis.caches || !blob?.size) return;
  try {
    const cache = await caches.open(CACHE_NAME);
    const key = await cacheRequestKey(signature, phrase, modelId);
    await cache.put(key, new Response(blob, { headers: { "Content-Type": blob.type || "audio/mpeg", "X-Hermes-Cached-At": String(Date.now()) } }));
    const keys = await cache.keys();
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_PERSISTED_CUES))) await cache.delete(old);
  } catch {
    // CacheStorage is an optimization. Playback must still succeed when it is unavailable.
  }
}

export function canStreamVoiceFeedback(response, MediaSourceClass = globalThis.MediaSource) {
  return Boolean(
    response?.body &&
    response.headers?.get?.("X-TTS-Backend")?.includes("stream") &&
    MediaSourceClass?.isTypeSupported?.("audio/mpeg")
  );
}

export async function playVoiceFeedbackAudio(audio, isCurrent = () => true) {
  if (!isCurrent()) throw new DOMException("Stale voice feedback", "AbortError");
  await audio.play();
  if (!isCurrent()) {
    try { audio.pause(); } catch { /* playback may already be gone */ }
    throw new DOMException("Stale voice feedback", "AbortError");
  }
}

export function streamVoiceFeedback({ response, audio, MediaSourceClass = globalThis.MediaSource, createObjectURL = URL.createObjectURL, revokeObjectURL = URL.revokeObjectURL, isCurrent = () => true }) {
  const mediaSource = new MediaSourceClass();
  const url = createObjectURL(mediaSource);
  const reader = response.body.getReader();
  const chunks = [];
  let cancelled = false;
  let sourceBuffer = null;
  let pending = [];
  let readDone = false;
  let resolveComplete;
  let rejectComplete;
  let settled = false;
  const complete = new Promise((resolve, reject) => { resolveComplete = resolve; rejectComplete = reject; });

  const detach = () => {
    try { mediaSource.removeEventListener?.("sourceopen", onSourceOpen); } catch { /* noop */ }
    try { sourceBuffer?.removeEventListener?.("updateend", pump); } catch { /* noop */ }
    try { sourceBuffer?.removeEventListener?.("error", onSourceError); } catch { /* noop */ }
  };

  const fail = (error) => {
    if (cancelled) return;
    cancelled = true;
    detach();
    try { reader.cancel(); } catch { /* noop */ }
    try { revokeObjectURL(url); } catch { /* noop */ }
    if (!settled) {
      settled = true;
      rejectComplete(error instanceof Error ? error : new Error(String(error)));
    }
  };
  const pump = () => {
    if (cancelled || !sourceBuffer || sourceBuffer.updating) return;
    const chunk = pending.shift();
    if (chunk) {
      try { sourceBuffer.appendBuffer(chunk); } catch (error) { fail(error); }
      return;
    }
    if (readDone) {
      try { if (mediaSource.readyState === "open") mediaSource.endOfStream(); } catch { /* noop */ }
      detach();
      if (!settled) {
        settled = true;
        resolveComplete(new Blob(chunks, { type: "audio/mpeg" }));
      }
    }
  };
  const read = async () => {
    try {
      while (!cancelled) {
        const { value, done } = await reader.read();
        if (done) { readDone = true; pump(); return; }
        if (!value?.byteLength) continue;
        const copy = value.slice ? value.slice() : new Uint8Array(value);
        chunks.push(copy);
        pending.push(copy);
        pump();
      }
    } catch (error) { fail(error); }
  };
  const onSourceError = () => fail(new Error("Voice feedback stream could not be decoded"));
  const onSourceOpen = () => {
    if (cancelled) return;
    try {
      sourceBuffer = mediaSource.addSourceBuffer("audio/mpeg");
      sourceBuffer.addEventListener("updateend", pump);
      sourceBuffer.addEventListener("error", onSourceError, { once: true });
      pump();
    } catch (error) { fail(error); }
  };
  mediaSource.addEventListener("sourceopen", onSourceOpen, { once: true });
  audio.src = url;
  audio.currentTime = 0;
  audio.muted = false;
  const started = Promise.resolve().then(() => {
    if (cancelled) throw new DOMException("Stale voice feedback", "AbortError");
    return playVoiceFeedbackAudio(audio, () => !cancelled && isCurrent());
  });
  void read();
  return {
    url,
    started,
    complete,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      try { reader.cancel(); } catch { /* noop */ }
      detach();
      try { audio.pause(); } catch { /* noop */ }
      try { revokeObjectURL(url); } catch { /* noop */ }
      if (!settled) {
        settled = true;
        resolveComplete(null);
      }
    },
  };
}
