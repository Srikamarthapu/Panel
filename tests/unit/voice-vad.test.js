import test from "node:test";
import assert from "node:assert/strict";
import { FrameProcessor } from "../../node_modules/@ricky0123/vad-web/dist/frame-processor.js";

import { CONTINUOUS_VAD_OPTIONS, createContinuousSpeechDetector, hasAudibleInputFrame, vadFrameStatus } from "../../components/voice/voiceVad.js";

const FRAME_MS = 32;
const PRIOR_VAD_OPTIONS = Object.freeze({
  positiveSpeechThreshold: 0.5,
  negativeSpeechThreshold: 0.35,
  preSpeechPadMs: 640,
  redemptionMs: 800,
  minSpeechMs: 256,
});

function detectorFrame(probability, marker = 0) {
  const frame = new Float32Array(512);
  frame[0] = marker;
  frame[1] = probability;
  return frame;
}

async function processSequence(options, sequence) {
  const events = [];
  const processor = new FrameProcessor(
    async (frame) => ({ isSpeech: frame[1], notSpeech: 1 - frame[1] }),
    () => {},
    options,
    FRAME_MS,
  );
  processor.resume();
  for (const frame of sequence) await processor.process(frame, (event) => events.push(event));
  return events;
}

test("startup zero frames are distinguished from frames with an input signal", () => {
  assert.equal(hasAudibleInputFrame(new Float32Array(512)), false);
  const live = new Float32Array(512);
  live[32] = 0.001;
  assert.equal(hasAudibleInputFrame(live), true);
});

test("a finite zero frame proves inference readiness while later speech proves input signal", () => {
  const quiet = vadFrameStatus({ isSpeech: 0, notSpeech: 1 }, new Float32Array(512));
  assert.deepEqual(quiet, { inferred: true, hasSignal: false });
  const speech = new Float32Array(512);
  speech[32] = 0.02;
  assert.deepEqual(vadFrameStatus({ isSpeech: 0.9, notSpeech: 0.1 }, speech), { inferred: true, hasSignal: true });
});

test("continuous detector keeps quality-oriented context around soft speech and natural pauses", async () => {
  const context = { sampleRate: 48000 };
  const stream = { id: "mic" };
  let options;
  let starts = 0;
  const detector = { start: async () => { starts += 1; } };
  const vadModule = { MicVAD: { new: async (value) => { options = value; return detector; } } };
  const result = await createContinuousSpeechDetector({ audioContext: context, stream, vadModule });

  assert.equal(result, detector);
  assert.equal(starts, 1);
  assert.equal(options.model, "v5");
  assert.equal(options.audioContext, context);
  assert.equal(await options.getStream(), stream);
  assert.equal(await options.resumeStream(), stream);
  assert.deepEqual(CONTINUOUS_VAD_OPTIONS, {
    positiveSpeechThreshold: 0.3,
    negativeSpeechThreshold: 0.25,
    preSpeechPadMs: 800,
    redemptionMs: 1400,
    minSpeechMs: 256,
  });
  assert.equal(options.positiveSpeechThreshold, 0.3);
  assert.equal(options.negativeSpeechThreshold, 0.25);
  assert.equal(options.preSpeechPadMs, 800);
  assert.equal(options.redemptionMs, 1400);
  assert.equal(options.minSpeechMs, 256);
  assert.equal(options.baseAssetPath, "/voice-vad/");
  assert.equal(options.onnxWASMBasePath, "/voice-vad/onnx/");
});

test("a natural 960ms pause remains inside one continuous utterance", async () => {
  const speech = Array.from({ length: 12 }, () => detectorFrame(0.9));
  const naturalPause = Array.from({ length: 30 }, () => detectorFrame(0.05));
  const trailingSilence = Array.from({ length: 44 }, () => detectorFrame(0.05));
  const events = await processSequence(CONTINUOUS_VAD_OPTIONS, [
    ...speech,
    ...naturalPause,
    ...speech,
    ...trailingSilence,
  ]);
  const priorEvents = await processSequence(PRIOR_VAD_OPTIONS, [...speech, ...naturalPause, ...speech, ...trailingSilence]);

  assert.equal(events.filter((event) => event.audio).length, 1);
  assert.equal(priorEvents.filter((event) => event.audio).length, 2);
});

test("the longer pre-roll retains a softly spoken leading frame", async () => {
  const leading = Array.from({ length: 23 }, (_, index) => detectorFrame(0.1, index + 1));
  const speech = Array.from({ length: 8 }, () => detectorFrame(0.9, 100));
  const trailingSilence = Array.from({ length: 44 }, () => detectorFrame(0.05));
  const events = await processSequence(CONTINUOUS_VAD_OPTIONS, [...leading, ...speech, ...trailingSilence]);
  const audio = events.find((event) => event.audio)?.audio;
  const priorEvents = await processSequence(PRIOR_VAD_OPTIONS, [...leading, ...speech, ...trailingSilence]);
  const priorAudio = priorEvents.find((event) => event.audio)?.audio;

  assert.ok(audio instanceof Float32Array);
  assert.equal(audio[0], 1);
  assert.ok(priorAudio instanceof Float32Array);
  assert.equal(priorAudio[0], 4);
});

test("a 256ms confirmation is submitted instead of treated as a VAD misfire", async () => {
  const shortConfirmation = Array.from({ length: 8 }, () => detectorFrame(0.9));
  const trailingSilence = Array.from({ length: 44 }, () => detectorFrame(0.05));
  const events = await processSequence(CONTINUOUS_VAD_OPTIONS, [...shortConfirmation, ...trailingSilence]);

  assert.equal(events.filter((event) => event.audio).length, 1);
});

test("sustained soft speech submits without turning sub-threshold background into speech", async () => {
  const softSpeech = Array.from({ length: 8 }, () => detectorFrame(0.4));
  const background = Array.from({ length: 60 }, () => detectorFrame(0.2));
  const trailingSilence = Array.from({ length: 44 }, () => detectorFrame(0.05));
  const softEvents = await processSequence(CONTINUOUS_VAD_OPTIONS, [...softSpeech, ...trailingSilence]);
  const priorSoftEvents = await processSequence(PRIOR_VAD_OPTIONS, [...softSpeech, ...trailingSilence]);
  const backgroundEvents = await processSequence(CONTINUOUS_VAD_OPTIONS, background);

  assert.equal(softEvents.filter((event) => event.audio).length, 1);
  assert.equal(priorSoftEvents.filter((event) => event.audio).length, 0);
  assert.equal(backgroundEvents.filter((event) => event.audio).length, 0);
});
