import test from "node:test";
import assert from "node:assert/strict";

import {
  isLiveAudioStream,
  microphoneConstraints,
  createVoiceRecorder,
  preferredRecorderMimeType,
  recorderFileName,
  VoiceCaptureTimeoutError,
  withCaptureTimeout,
} from "../../components/voice/voiceCapture.js";
import { pcm16kToWavBlob } from "../../components/voice/voiceVad.js";
import { initialWrapper, reducer } from "../../components/voice/voiceMachine.js";
import { isMicrophoneGenerationEffect, queuedVoiceReducer } from "../../components/voice/voiceEffects.js";

test("a microphone request has a bounded wait", async () => {
  await assert.rejects(
    withCaptureTimeout(new Promise(() => {}), 5),
    VoiceCaptureTimeoutError,
  );
});

test("microphone constraints preserve processing and pin an explicit input", () => {
  assert.deepEqual(microphoneConstraints(), {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  assert.deepEqual(microphoneConstraints("mac-built-in"), {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      deviceId: { exact: "mac-built-in" },
    },
  });
});

test("capture only accepts a stream with a live enabled audio track", () => {
  assert.equal(isLiveAudioStream(null), false);
  assert.equal(isLiveAudioStream({ getAudioTracks: () => [{ readyState: "ended", enabled: true }] }), false);
  assert.equal(isLiveAudioStream({ getAudioTracks: () => [{ readyState: "live", enabled: false }] }), false);
  assert.equal(isLiveAudioStream({ getAudioTracks: () => [{ readyState: "live", enabled: true }] }), true);
});

test("recorder MIME selection follows browser support and safely falls back", () => {
  const Recorder = { isTypeSupported: (type) => type === "audio/mp4" };
  assert.equal(preferredRecorderMimeType(Recorder), "audio/mp4");
  assert.equal(preferredRecorderMimeType({ isTypeSupported: () => false }), "");
  assert.equal(recorderFileName("audio/mp4"), "recording.m4a");
  assert.equal(recorderFileName("audio/ogg;codecs=opus"), "recording.ogg");
  assert.equal(recorderFileName("audio/wav"), "recording.wav");
  assert.equal(recorderFileName("audio/webm;codecs=opus"), "recording.webm");
});

test("production recorder helper wires chunks from a live stream", () => {
  class Recorder {
    static isTypeSupported(type) { return type === "audio/mp4"; }
    constructor(stream, options) { this.stream = stream; this.mimeType = options.mimeType; }
  }
  const chunks = [];
  const stream = { getAudioTracks: () => [{ readyState: "live", enabled: true }] };
  const recorder = createVoiceRecorder(stream, Recorder, (chunk) => chunks.push(chunk));
  recorder.ondataavailable({ data: { size: 24 } });
  recorder.ondataavailable({ data: { size: 0 } });
  assert.equal(recorder.mimeType, "audio/mp4");
  assert.deepEqual(chunks, [{ size: 24 }]);
});

test("speech detector PCM is encoded as a valid 16 kHz mono WAV for STT", async () => {
  const blob = pcm16kToWavBlob(new Float32Array([0, 0.5, -0.5, 1, -1]));
  const view = new DataView(await blob.arrayBuffer());
  const text = (start, count) => String.fromCharCode(...new Uint8Array(view.buffer, start, count));
  assert.equal(blob.type, "audio/wav");
  assert.equal(text(0, 4), "RIFF");
  assert.equal(text(8, 4), "WAVE");
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 10);
});

test("continuous classifier owns capture start and misfire recovery without a recorder effect", () => {
  let wrapper = reducer(initialWrapper, { type: "SET_PERMISSION", value: "granted" });
  wrapper = reducer(wrapper, { type: "TOGGLE_CONTINUOUS" });
  wrapper = reducer(wrapper, { type: "MIC_READY" });
  wrapper = reducer(wrapper, { type: "VAD_SPEECH_START" });
  assert.equal(wrapper.state.state, "capturing");
  assert.deepEqual(wrapper.effects, []);
  wrapper = reducer(wrapper, { type: "VAD_MISFIRE" });
  assert.equal(wrapper.state.state, "listening");
  wrapper = reducer(wrapper, { type: "VAD_SPEECH_START" });
  wrapper = reducer(wrapper, { type: "VAD_SPEECH_END" });
  assert.equal(wrapper.state.state, "transcribing");
  assert.deepEqual(wrapper.effects.map((effect) => effect.kind), ["callSTT"]);
});

test("typed chat during continuous mode keeps the unlocked listening session", () => {
  let wrapper = reducer(initialWrapper, { type: "SET_PERMISSION", value: "granted" });
  wrapper = reducer(wrapper, { type: "TOGGLE_CONTINUOUS" });
  wrapper = reducer(wrapper, { type: "MIC_READY" });
  wrapper = reducer(wrapper, { type: "STT_OK", text: "typed turn", textOnly: true, preserveContinuous: true });
  assert.equal(wrapper.state.continuousRequested, true);
  assert.deepEqual(wrapper.effects.map((effect) => effect.kind), ["callChat"]);
  assert.equal(wrapper.effects[0].preserveContinuous, true);
  wrapper = reducer(wrapper, { type: "CHAT_OK", response: "typed reply", textOnly: true, preserveContinuous: true });
  assert.equal(wrapper.state.state, "listening");
  assert.equal(wrapper.state.continuousRequested, true);
});

test("changing microphone stops capture mode without cancelling submitted work", () => {
  for (const state of ["idle", "starting", "listening", "capturing", "error"]) {
    const current = {
      ...initialWrapper,
      state: {
        ...initialWrapper.state,
        state,
        continuousRequested: true,
        pttRequested: state === "starting",
        permission: "granted",
        config: { ...initialWrapper.state.config, micDeviceId: "old" },
      },
    };
    const next = reducer(current, { type: "MIC_INPUT_CHANGED", partial: { micDeviceId: "built-in" } });
    assert.equal(next.state.state, "idle");
    assert.equal(next.state.continuousRequested, false);
    assert.equal(next.state.pttRequested, false);
    assert.equal(next.state.permission, "unknown");
    assert.equal(next.state.config.micDeviceId, "built-in");
    assert.deepEqual(next.effects, []);
  }

  for (const state of ["transcribing", "thinking", "speaking"]) {
    const current = {
      ...initialWrapper,
      state: {
        ...initialWrapper.state,
        state,
        continuousRequested: true,
        requestPending: state !== "transcribing",
        actionId: state !== "transcribing" ? "accepted-run" : null,
        streamSpeechQueue: state === "speaking" ? ["remaining reply"] : [],
        config: { ...initialWrapper.state.config, micDeviceId: "old" },
      },
    };
    const next = reducer(current, { type: "MIC_INPUT_CHANGED", partial: { micDeviceId: "built-in" } });
    assert.equal(next.state.state, state);
    assert.equal(next.state.requestPending, current.state.requestPending);
    assert.equal(next.state.actionId, current.state.actionId);
    assert.deepEqual(next.state.streamSpeechQueue, current.state.streamSpeechQueue);
    assert.equal(next.state.continuousRequested, false);
    assert.equal(next.state.config.micDeviceId, "built-in");
    assert.deepEqual(next.effects, []);
  }
});

test("changing microphone drops stale capture effects but retains submitted STT and chat work", () => {
  let pendingPermission = queuedVoiceReducer(initialWrapper, { type: "START_PTT" });
  pendingPermission = queuedVoiceReducer(pendingPermission, { type: "MIC_INPUT_CHANGED", partial: { micDeviceId: "built-in" } });
  assert.deepEqual(pendingPermission.effects, []);

  let submitted = reducer(initialWrapper, { type: "SET_PERMISSION", value: "granted" });
  submitted = queuedVoiceReducer(submitted, { type: "START_PTT" });
  submitted = queuedVoiceReducer(submitted, { type: "RECORDER_STARTED" });
  submitted = queuedVoiceReducer(submitted, { type: "STOP_PTT" });
  submitted = queuedVoiceReducer(submitted, { type: "MIC_INPUT_CHANGED", partial: { micDeviceId: "built-in" } });
  assert.deepEqual(submitted.effects.map((effect) => effect.kind), ["stopRecorder", "callSTT"]);

  let accepted = queuedVoiceReducer(initialWrapper, { type: "STT_OK", text: "already submitted" });
  accepted = queuedVoiceReducer(accepted, { type: "MIC_INPUT_CHANGED", partial: { micDeviceId: "built-in" } });
  assert.deepEqual(accepted.effects.map((effect) => effect.kind), ["callChat"]);
  assert.equal(accepted.state.state, "thinking");
});

test("microphone recovery failure reports the device error without stealing submitted work", () => {
  const submitted = {
    ...initialWrapper,
    state: {
      ...initialWrapper.state,
      state: "transcribing",
      requestPending: true,
      actionId: "run-preserved",
      continuousRequested: true,
    },
  };
  const next = queuedVoiceReducer(submitted, {
    type: "MIC_RECOVERY_FAILED",
    stage: "microphone",
    code: "MIC_STREAM_ENDED",
    error: "The selected microphone disconnected.",
    retryable: true,
  });
  assert.equal(next.state.state, "transcribing");
  assert.equal(next.state.requestPending, true);
  assert.equal(next.state.actionId, "run-preserved");
  assert.equal(next.state.continuousRequested, true);
  assert.equal(next.state.lastError.code, "MIC_STREAM_ENDED");
  assert.deepEqual(next.effects.map((effect) => effect.kind), ["emitActivity"]);
});

test("microphone generations include destructive capture teardown but retain committed recording work", () => {
  for (const effect of [
    { kind: "requestPermission" },
    { kind: "startRecorder" },
    { kind: "syncContinuous", on: false },
    { kind: "releaseMicForPlayback" },
    { kind: "stopAllTracks" },
    { kind: "closeAudioContext" },
    { kind: "stopRecorder", discard: true },
  ]) assert.equal(isMicrophoneGenerationEffect(effect), true, effect.kind);

  for (const effect of [
    { kind: "stopRecorder", discard: false },
    { kind: "callSTT" },
    { kind: "callChat" },
    { kind: "callTTS" },
    { kind: "playAudio" },
  ]) assert.equal(isMicrophoneGenerationEffect(effect), false, effect.kind);

  const staleTeardown = {
    ...initialWrapper,
    effects: [
      { effectId: 1, kind: "stopRecorder", discard: true },
      { effectId: 2, kind: "stopAllTracks" },
      { effectId: 3, kind: "closeAudioContext" },
      { effectId: 4, kind: "stopRecorder", discard: false },
      { effectId: 5, kind: "callSTT" },
    ],
    effectSequence: 5,
  };
  const next = queuedVoiceReducer(staleTeardown, { type: "MIC_INPUT_CHANGED", partial: { micDeviceId: "built-in" } });
  assert.deepEqual(next.effects.map(({ kind, discard }) => [kind, discard]), [
    ["stopRecorder", false],
    ["callSTT", undefined],
  ]);
});

test("recorder setup failure exits capturing and queues complete cleanup", () => {
  let wrapper = reducer(initialWrapper, { type: "SET_PERMISSION", value: "granted" });
  wrapper = reducer(wrapper, { type: "START_PTT" });
  assert.equal(wrapper.state.state, "starting");
  wrapper = reducer(wrapper, { type: "RECORDER_STARTED" });
  assert.equal(wrapper.state.state, "capturing");

  wrapper = reducer(wrapper, {
    type: "CAPTURE_FAILED",
    stage: "recorder",
    code: "RECORDER_START_FAILED",
    error: "Recording could not start. Retry voice capture.",
    retryable: true,
  });

  assert.equal(wrapper.state.state, "error");
  assert.equal(wrapper.state.continuousRequested, false);
  assert.equal(wrapper.state.lastError.code, "RECORDER_START_FAILED");
  assert.deepEqual(
    wrapper.effects.slice(0, 4).map((effect) => effect.kind),
    ["stopRecorder", "stopAllTracks", "closeAudioContext", "emitActivity"],
  );
});
