// T-0009 fix A — TTS crispness regression.
//
// The T-0006 fast path split the streaming reply at every sentence boundary
// and synthesized each fragment through a SEPARATE ElevenLabs /stream request.
// ElevenLabs prosody quality drops sharply on short isolated fragments (each
// request resets prosodic context) and the chunk joins can click/gap, so the
// voice stopped sounding as "crisp" as whole-reply single-shot synthesis.
//
// These tests pin the fixed behavior:
//   1. A short reply (≤ ~280 chars) is synthesized in ONE TTS request.
//   2. A long reply is coalesced into a FEW large chunks (2–3 sentences each),
//      never one-request-per-sentence.
//   3. Chunk boundaries are always sentence-final — never mid-clause.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createVoiceAudioStream, takeVoiceTtsChunk } from "../../lib/voice.js";

const encoder = new TextEncoder();

// Stream a full reply as word-sized SSE tokens, mimicking real model output.
function mockModelFetch(fullReply) {
  const tokens = fullReply.match(/\S+\s*/g) || [fullReply];
  return async function fetchImpl() {
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const token of tokens) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: token } }] })}\n\n`),
            );
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
  };
}

function mockTts(record) {
  return async function synthesizeStreamImpl({ text }) {
    record.push(text);
    return {
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`mp3:${text.slice(0, 8)}`));
          controller.close();
        },
      }),
      keyUsed: "mock", model: "mock", voiceId: "mock",
    };
  };
}

async function drain(stream) {
  const reader = stream.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}

const config = {
  voiceModelProvider: "nvidia",
  voiceModel: "deepseek-ai/deepseek-v4-flash",
  elevenlabsApiKeys: ["mock"],
  elevenlabsVoiceId: "pFZP5JQG7iQjIQuC4Bku",
  elevenlabsModel: "eleven_multilingual_v2",
};

async function synthesizeReply(reply) {
  const record = [];
  const stream = createVoiceAudioStream({
    text: "prompt",
    config,
    fetchImpl: mockModelFetch(reply),
    synthesizeStreamImpl: mockTts(record),
  });
  await drain(stream);
  return record;
}

test("short multi-sentence reply is synthesized as ONE TTS request (crispness)", async () => {
  const prev = process.env.NVIDIA_API_KEY;
  process.env.NVIDIA_API_KEY = "mock-key";
  try {
    // The exact case the T-0006 harness flagged as tts_requests:2.
    const chunks = await synthesizeReply("Got it. I'll take care of that now.");
    assert.equal(chunks.length, 1, `expected 1 TTS request, got ${chunks.length}: ${JSON.stringify(chunks)}`);
    assert.equal(chunks[0], "Got it. I'll take care of that now.");
  } finally {
    if (prev == null) delete process.env.NVIDIA_API_KEY;
    else process.env.NVIDIA_API_KEY = prev;
  }
});

test("three short sentences under the single-shot cap still coalesce to ONE request", async () => {
  const prev = process.env.NVIDIA_API_KEY;
  process.env.NVIDIA_API_KEY = "mock-key";
  try {
    const chunks = await synthesizeReply("The build passed. All tests are green. You're good to ship.");
    assert.equal(chunks.length, 1, `expected 1 TTS request, got ${chunks.length}: ${JSON.stringify(chunks)}`);
  } finally {
    if (prev == null) delete process.env.NVIDIA_API_KEY;
    else process.env.NVIDIA_API_KEY = prev;
  }
});

test("a long reply coalesces into a few large chunks, never one-per-sentence", async () => {
  const prev = process.env.NVIDIA_API_KEY;
  process.env.NVIDIA_API_KEY = "mock-key";
  try {
    const long =
      "The deployment finished about ten minutes ago and everything looks healthy so far. " +
      "All fifteen services came up cleanly and the health checks are passing. " +
      "I did notice the cache warm-up took a little longer than usual, roughly forty seconds. " +
      "Traffic is already flowing through the new version without any errors in the logs. " +
      "If you want, I can keep an eye on the error rate for the next hour. " +
      "Otherwise you should be good to move on to the next task.";
    // 6 sentences. Old behavior: 6 TTS requests. New behavior: a small handful.
    const chunks = await synthesizeReply(long);
    assert.ok(chunks.length >= 2, "a long reply should still stream in multiple chunks");
    assert.ok(chunks.length <= 3, `expected few large chunks, got ${chunks.length}: ${chunks.map((c) => c.length)}`);
    // Every chunk except the final drained one must end on a sentence boundary.
    for (const c of chunks.slice(0, -1)) {
      assert.match(c.trim(), /[.!?]$/, `chunk split mid-clause: "${c}"`);
    }
  } finally {
    if (prev == null) delete process.env.NVIDIA_API_KEY;
    else process.env.NVIDIA_API_KEY = prev;
  }
});

test("takeVoiceTtsChunk: first chunk flushes at ~one sentence, later chunks coalesce larger", () => {
  // A short whole reply below the first-chunk floor holds (null) so it drains
  // as ONE single-shot synthesis rather than being split into fragments.
  assert.equal(takeVoiceTtsChunk("Short reply here.", { isFirst: true }), null);

  // The FIRST chunk flushes as soon as it reaches ~one natural sentence, so
  // audio starts fast on a longer reply — but only on a sentence boundary,
  // never a clicky fragment. Sentence one below is ~90+ chars.
  const longReply =
    "This first sentence is deliberately long enough to cross the first-chunk minimum on its own here. " +
    "Here is a second sentence that would otherwise wait for a later chunk. " +
    "And a third sentence rounds things out for the drain.";
  const first = takeVoiceTtsChunk(longReply, { isFirst: true });
  assert.ok(first, "expected the first chunk to flush once it reached ~one sentence");
  assert.match(first.chunk.trim(), /[.!?]$/, "flushed first chunk must end on a sentence boundary");
  assert.ok(first.chunk.length >= 90, "first chunk should be at least a full natural sentence");
  // The first chunk should NOT swallow the whole reply — the rest is buffered
  // for a subsequent (larger) chunk, so first-audio isn't gated on the whole
  // long reply streaming.
  assert.ok(first.rest.length > 0, "remaining sentences stay buffered for the next chunk");

  // A subsequent (isFirst:false) chunk coalesces up to the larger target: two
  // ~110-char sentences below cross 240 together and flush as one chunk.
  const later =
    "This is a fairly long subsequent sentence that on its own does not reach the larger coalescing target quite yet. " +
    "But this second long sentence pushes the running total across the coalescing target so it flushes right now. " +
    "This trailing sentence stays buffered.";
  const laterChunk = takeVoiceTtsChunk(later, { isFirst: false });
  assert.ok(laterChunk, "expected a later chunk to flush once it crossed the coalescing target");
  assert.match(laterChunk.chunk.trim(), /[.!?]$/, "later chunk must end on a sentence boundary");
  assert.ok(laterChunk.chunk.length >= 200, "later chunks should coalesce multiple sentences");

  // force drains whatever whole sentences plus the trailing fragment remain.
  const drained = takeVoiceTtsChunk("Trailing fragment with no terminal punctuation", { force: true, isFirst: false });
  assert.ok(drained && drained.chunk.includes("Trailing fragment"));
  assert.equal(drained.rest, "");

  // Empty / whitespace buffers never produce a chunk.
  assert.equal(takeVoiceTtsChunk("", { force: true }), null);
  assert.equal(takeVoiceTtsChunk("   ", { force: true }), null);
});
