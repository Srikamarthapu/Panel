import test from "node:test";
import assert from "node:assert/strict";

import {
  isLiveAudioStream,
  createVoiceRecorder,
  deriveVadThresholds,
  preferredRecorderMimeType,
  recorderFileName,
  VoiceCaptureTimeoutError,
  withCaptureTimeout,
} from "../../components/voice/voiceCapture.js";
import { pcm16kToWavBlob } from "../../components/voice/voiceVad.js";
import { initialWrapper, reducer } from "../../components/voice/voiceMachine.js";

test("a microphone request has a bounded wait", async () => {
  await assert.rejects(
    withCaptureTimeout(new Promise(() => {}), 5),
    VoiceCaptureTimeoutError,
  );
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

test("VAD thresholds stay above a noisy measured floor", () => {
  const thresholds = deriveVadThresholds(0.05);
  assert.ok(thresholds.silence > 0.05);
  assert.ok(thresholds.speech > thresholds.silence);
  assert.equal(thresholds.noisy, true);
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
    ["clearVadInterval", "stopRecorder", "stopAllTracks", "closeAudioContext"],
  );
});
