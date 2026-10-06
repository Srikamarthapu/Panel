import test from "node:test";
import assert from "node:assert/strict";

import { createContinuousSpeechDetector, hasAudibleInputFrame, vadFrameStatus } from "../../components/voice/voiceVad.js";

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

test("continuous detector uses local speech endpointing and provider-owned audio resources", async () => {
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
  assert.equal(options.preSpeechPadMs, 640);
  assert.equal(options.redemptionMs, 800);
  assert.equal(options.minSpeechMs, 256);
  assert.equal(options.baseAssetPath, "/voice-vad/");
  assert.equal(options.onnxWASMBasePath, "/voice-vad/onnx/");
});
