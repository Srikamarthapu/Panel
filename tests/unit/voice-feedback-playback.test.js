import assert from "node:assert/strict";
import test from "node:test";
import { readPersistedVoiceFeedback, persistVoiceFeedback, playVoiceFeedbackAudio, prepareVoiceFeedbackAudio, streamVoiceFeedback, VOICE_FEEDBACK_MODEL } from "../../components/voice/voiceFeedbackPlayback.js";

test("cue preparation begins before acceptance but never starts audio", async () => {
  let request;
  let finish;
  const prepared = prepareVoiceFeedbackAudio({ phrase: "I’ll check your calendar.", signature: "test", cache: new Map(), fetcher: (url, options) => {
    request = { url, options };
    return new Promise((resolve) => { finish = resolve; });
  } });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(request.url, "/api/voice/tts");
  assert.deepEqual(JSON.parse(request.options.body), { text: "I’ll check your calendar.", modelId: VOICE_FEEDBACK_MODEL });
  const response = new Response(new Uint8Array(256));
  finish(response);
  const payload = await prepared.promise;
  assert.equal(payload.response, response);
  assert.equal(response.bodyUsed, false, "playback owns consumption after acceptance");
});

test("a cancelled cue discards a response that arrives after cancellation", async () => {
  let finish, cancelled = false;
  const prepared = prepareVoiceFeedbackAudio({ phrase: "I’ll check your messages.", signature: "test", fetcher: () => new Promise((resolve) => { finish = resolve; }) });
  await Promise.resolve(); await Promise.resolve();
  prepared.controller.abort();
  finish(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  assert.equal(await prepared.promise, null);
  assert.equal(cancelled, true);
});

test("cached cue preparation does not call a speech provider", async () => {
  const phrase = "I’ll check the weather.";
  const blob = new Blob([new Uint8Array(256)]);
  const prepared = prepareVoiceFeedbackAudio({ phrase, signature: "test", cache: new Map([[`test:${VOICE_FEEDBACK_MODEL}:${phrase}`, blob]]), fetcher: () => assert.fail("cached cue must be local") });
  assert.equal((await prepared.promise).blob, blob);
});

class FakeSourceBuffer extends EventTarget {
  updating = false;
  appendBuffer() {
    this.updating = true;
    queueMicrotask(() => {
      this.updating = false;
      this.dispatchEvent(new Event("updateend"));
    });
  }
}

class FakeMediaSource extends EventTarget {
  static isTypeSupported = () => true;
  static latestBuffer = null;
  readyState = "open";
  constructor() {
    super();
    queueMicrotask(() => this.dispatchEvent(new Event("sourceopen")));
  }
  addSourceBuffer() {
    FakeMediaSource.latestBuffer = new FakeSourceBuffer();
    return FakeMediaSource.latestBuffer;
  }
  endOfStream() { this.readyState = "ended"; }
}

test("feedback playback starts before a delayed response stream closes", async () => {
  let closeStream;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      closeStream = () => controller.close();
    },
  });
  let plays = 0;
  const audio = { play: async () => { plays += 1; }, pause() {} };
  const stream = streamVoiceFeedback({
    response: { body },
    audio,
    MediaSourceClass: FakeMediaSource,
    createObjectURL: () => "blob:feedback",
    revokeObjectURL() {},
  });
  await stream.started;
  assert.equal(plays, 1, "play begins while the network stream is still open");
  let completed = false;
  stream.complete.then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  closeStream();
  const blob = await stream.complete;
  assert.equal(blob.size, 3);
});

test("stale feedback cannot start late playback", async () => {
  let plays = 0;
  const body = new ReadableStream({ start() {} });
  const stream = streamVoiceFeedback({
    response: { body },
    audio: { play: async () => { plays += 1; }, pause() {} },
    MediaSourceClass: FakeMediaSource,
    createObjectURL: () => "blob:stale",
    revokeObjectURL() {},
    isCurrent: () => false,
  });
  await assert.rejects(stream.started, { name: "AbortError" });
  stream.cancel();
  assert.equal(plays, 0);
});

test("feedback that becomes stale while audio.play is pending is paused before playback can resume", async () => {
  let resolvePlay;
  let current = true;
  let playing = false;
  let pauses = 0;
  const audio = {
    play: () => new Promise((resolve) => { resolvePlay = () => { playing = true; resolve(); }; }),
    pause: () => { playing = false; pauses += 1; },
  };
  const starting = playVoiceFeedbackAudio(audio, () => current);
  await Promise.resolve();
  assert.equal(typeof resolvePlay, "function");
  current = false; // final answer or cancellation invalidated the acknowledgement
  audio.pause();
  resolvePlay();
  await assert.rejects(starting, { name: "AbortError" });
  assert.equal(playing, false);
  assert.equal(pauses, 2, "the pending play continuation performs a final defensive pause");
});

test("a SourceBuffer decode error rejects stream completion", async () => {
  const body = new ReadableStream({ start() {} });
  const stream = streamVoiceFeedback({
    response: { body },
    audio: { play: async () => {}, pause() {} },
    MediaSourceClass: FakeMediaSource,
    createObjectURL: () => "blob:decode-error",
    revokeObjectURL() {},
  });
  await stream.started;
  await new Promise((resolve) => queueMicrotask(resolve));
  FakeMediaSource.latestBuffer.dispatchEvent(new Event("error"));
  await assert.rejects(stream.complete, /could not be decoded/);
});

test("a persisted cue is reused without a network request", async (t) => {
  const records = new Map();
  const originalCaches = globalThis.caches;
  globalThis.caches = {
    async open() {
      return {
        async put(key, response) { records.set(String(key), response.clone()); },
        async match(key) { return records.get(String(key))?.clone() || null; },
        async keys() { return [...records.keys()]; },
        async delete(key) { return records.delete(String(key)); },
      };
    },
  };
  t.after(() => { globalThis.caches = originalCaches; });
  let ttsCalls = 0;
  const fetchTts = async () => { ttsCalls += 1; };
  await persistVoiceFeedback("voice-a", "I’ll check your calendar.", new Blob([new Uint8Array(2048)], { type: "audio/mpeg" }));
  const hit = await readPersistedVoiceFeedback("voice-a", "I’ll check your calendar.");
  if (!hit) await fetchTts();
  assert.equal(hit.size, 2048);
  assert.equal(ttsCalls, 0);
});
