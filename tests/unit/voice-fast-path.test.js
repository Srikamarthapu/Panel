import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  classifyVoiceIntent,
  createVoiceAudioStream,
  takeVoiceSentenceChunk,
} from "../../lib/voice.js";

const encoder = new TextEncoder();

async function readAll(stream) {
  const reader = stream.getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

function mockModelFetch(tokens, delayMs = 2) {
  return async function fetchImpl() {
    return new Response(
      new ReadableStream({
        async start(controller) {
          for (const token of tokens) {
            await new Promise((resolveTimer) => setTimeout(resolveTimer, delayMs));
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

function mockTts(synthesized, delayMs = 2) {
  return async function synthesizeStreamImpl({ text }) {
    synthesized.push(text);
    return {
      stream: new ReadableStream({
        async start(controller) {
          await new Promise((resolveTimer) => setTimeout(resolveTimer, delayMs));
          controller.enqueue(encoder.encode(`mp3:${text}`));
          controller.close();
        },
      }),
      keyUsed: "mock",
      model: "mock-tts",
      voiceId: "mock-voice",
    };
  };
}

test("fast voice path streams model tokens into sentence-chunked TTS", async () => {
  const previousKey = process.env.NVIDIA_API_KEY;
  process.env.NVIDIA_API_KEY = "mock-key";
  const synthesized = [];
  const timings = {};
  const startedAt = Date.now();

  const stream = createVoiceAudioStream({
    text: "say hello",
    config: {
      voiceModelProvider: "nvidia",
      voiceModel: "deepseek-ai/deepseek-v4-flash",
      elevenlabsApiKeys: ["mock-elevenlabs-key"],
      elevenlabsVoiceId: "pFZP5JQG7iQjIQuC4Bku",
      elevenlabsModel: "eleven_flash_v2_5",
    },
    fetchImpl: mockModelFetch(["Hello there. ", "Second sentence."]),
    synthesizeStreamImpl: mockTts(synthesized),
    onFirstToken: () => {
      timings.llm_first_token_ms = Date.now() - startedAt;
    },
    onFirstAudioByte: () => {
      timings.tts_first_byte_ms = Date.now() - startedAt;
    },
    onComplete: () => {
      timings.total_ms = Date.now() - startedAt;
    },
  });

  const audio = await readAll(stream);
  if (previousKey == null) delete process.env.NVIDIA_API_KEY;
  else process.env.NVIDIA_API_KEY = previousKey;

  assert.ok(audio.length > 0);
  // T-0009 fix A (crispness): a short reply is coalesced into a SINGLE TTS
  // request with whole-utterance prosody, not one request per sentence.
  assert.deepEqual(synthesized, ["Hello there. Second sentence."]);
  assert.ok(timings.llm_first_token_ms >= 0);
  assert.ok(timings.tts_first_byte_ms >= timings.llm_first_token_ms);
  assert.ok(timings.total_ms >= timings.tts_first_byte_ms);
});

test("sentence chunker prefers complete spoken sentences", () => {
  const first = takeVoiceSentenceChunk("One complete sentence. Partial");
  assert.deepEqual(first, {
    chunk: "One complete sentence.",
    rest: "Partial",
  });
  assert.equal(takeVoiceSentenceChunk("no sentence yet"), null);
});

test("voice intent classifier separates commands from conversation", () => {
  assert.equal(classifyVoiceIntent("run the unit tests").type, "action");
  assert.equal(classifyVoiceIntent("can you check the build").type, "action");
  assert.equal(classifyVoiceIntent("what changed in the design").type, "chat");
});

test("voice chat route does not spawn hermes in the fast request path", () => {
  const route = readFileSync(resolve("app/api/voice/chat/route.js"), "utf8");
  assert.doesNotMatch(route, /execFileAsync\s*\(\s*["']hermes/);
  assert.doesNotMatch(route, /execFile\s*\(\s*["']hermes/);
  assert.doesNotMatch(route, /spawn\s*\(\s*["']hermes/);
});
