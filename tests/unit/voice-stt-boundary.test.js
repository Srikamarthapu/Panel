import test from "node:test";
import assert from "node:assert/strict";
import { POST } from "../../app/api/voice/stt/route.js";

function streamingRequest(body, headers = {}) {
  return new Request("http://panel.test/api/voice/stt", {
    method: "POST",
    headers,
    body,
    duplex: "half",
  });
}

test("STT handler rejects declared and streamed oversized multipart bodies before provider use", async () => {
  const declared = streamingRequest(new ReadableStream({ start(controller) { controller.close(); } }), {
    "content-type": "multipart/form-data; boundary=fixture",
    "content-length": String(13 * 1024 * 1024),
  });
  let response = await POST(declared);
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), {
    error: "Speech recognition unavailable",
    code: "STT_AUDIO_TOO_LARGE",
    message: "This recording is too large. Try a shorter recording.",
    retryable: false,
  });

  const chunk = new Uint8Array(512 * 1024);
  let sent = 0;
  const lying = streamingRequest(new ReadableStream({
    pull(controller) {
      if (sent++ < 25) controller.enqueue(chunk);
      else controller.close();
    },
  }), {
    "content-type": "multipart/form-data; boundary=fixture",
    "content-length": "1",
  });
  response = await POST(lying);
  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, "STT_AUDIO_TOO_LARGE");
});

test("STT handler reports malformed multipart as a nonretryable client error", async () => {
  const request = streamingRequest(new Blob(["not multipart"]).stream(), {
    "content-type": "multipart/form-data; boundary=fixture",
  });
  const response = await POST(request);
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.code, "STT_INVALID_FORM");
  assert.equal(body.retryable, false);
});

test("STT handler accepts a bounded multipart upload and retains the missing-provider contract", async () => {
  const prior = process.env.DEEPGRAM_API_KEY;
  delete process.env.DEEPGRAM_API_KEY;
  try {
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(200)], { type: "audio/webm" }), "recording.webm");
    const response = await POST(new Request("http://panel.test/api/voice/stt", { method: "POST", body: form }));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "STT_NOT_CONFIGURED");
  } finally {
    if (prior === undefined) delete process.env.DEEPGRAM_API_KEY; else process.env.DEEPGRAM_API_KEY = prior;
  }
});

test("Next proxy limit stays above the documented application upload envelopes", async () => {
  const config = (await import(`../../next.config.mjs?upload-boundary=${Date.now()}`)).default;
  assert.equal(config.experimental.proxyClientMaxBodySize, "20mb");
});
