import test from "node:test";
import assert from "node:assert/strict";
import { synthesizeStreamWithFailover } from "../../lib/elevenlabs.js";

const config = {
  elevenlabsApiKeys: ["synthetic-test-key"],
  elevenlabsVoiceId: "synthetic-voice",
  elevenlabsModel: "eleven_multilingual_v2",
  elevenlabsVoiceSettings: { stability: 0.5 },
};

async function captureRequest(options = {}) {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), body: JSON.parse(init.body) };
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  };
  try {
    const result = await synthesizeStreamWithFailover({ text: "A synthetic quality check.", config, ...options });
    await result.stream.cancel();
    return request;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("full-answer streaming uses ElevenLabs' quality-first default", async () => {
  const request = await captureRequest();
  assert.match(request.url, /output_format=mp3_44100_128/);
  assert.doesNotMatch(request.url, /optimize_streaming_latency/);
  assert.equal(request.body.model_id, "eleven_multilingual_v2");
});

test("short feedback cues can explicitly retain latency optimization", async () => {
  const request = await captureRequest({ modelId: "eleven_flash_v2_5", optimizeStreamingLatency: true });
  assert.match(request.url, /optimize_streaming_latency=2/);
  assert.equal(request.body.model_id, "eleven_flash_v2_5");
});
