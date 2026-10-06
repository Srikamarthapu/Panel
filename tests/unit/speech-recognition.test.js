import test from "node:test";
import assert from "node:assert/strict";
import { requestSpeechRecognition, speechFailure } from "../../lib/speech-recognition.js";

test("speech retries one transient transport failure using the same recording", async () => {
  let calls = 0;
  const body = Buffer.from("recording");
  const response = await requestSpeechRecognition("https://speech.invalid", { body }, { wait: async () => {}, fetchImpl: async (_url, request) => {
    assert.equal(request.body, body);
    if (++calls === 1) throw new TypeError("fetch failed");
    return new Response("{}", { status: 200 });
  } });
  assert.equal(calls, 2);
  assert.equal(response.status, 200);
});

test("speech retries overload but does not retry authentication failures", async () => {
  for (const status of [429, 503, 401, 403]) {
    let calls = 0;
    await requestSpeechRecognition("https://speech.invalid", {}, { wait: async () => {}, fetchImpl: async () => { calls++; return new Response("{}", { status }); } });
    assert.equal(calls, [429, 503].includes(status) ? 2 : 1);
  }
});

test("a cancelled recording never retries or starts a provider request", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(requestSpeechRecognition("https://speech.invalid", { signal: controller.signal }, { fetchImpl: async () => { calls++; } }), { name: "AbortError" });
  assert.equal(calls, 0);
});

test("TLS failures stay secure, are not retried, and expose a useful safe error", async () => {
  const error = new TypeError("fetch failed", { cause: { code: "CERT_HAS_EXPIRED" } });
  let calls = 0;
  await assert.rejects(requestSpeechRecognition("https://speech.invalid", {}, { wait: async () => {}, fetchImpl: async () => { calls++; throw error; } }));
  assert.equal(calls, 1);
  assert.equal(speechFailure(error).code, "STT_TLS_ERROR");
  assert.equal(speechFailure(error).retryable, false);
});
