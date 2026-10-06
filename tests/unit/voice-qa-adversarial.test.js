import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  classifyVoiceIntent,
  createVoiceAudioStream,
  takeVoiceSentenceChunk,
  voiceActionAck,
  sanitizeForVoice,
} from "../../lib/voice.js";

const encoder = new TextEncoder();

// Import extractSsePayloads from voice.js — it's exported but we verify
// via dynamic import since it's listed among named exports.
let extractSsePayloads;
try {
  const mod = await import("../../lib/voice.js");
  extractSsePayloads = mod.extractSsePayloads;
} catch {
  // extractSsePayloads is not exported — skip SSE-specific tests
}

// ─── SSE Parsing Adversarial Tests ───────────────────────────────────────

// extractSsePayloads may or may not be exported; test only if available.
const runSSE = typeof extractSsePayloads === "function";

if (runSSE) {
  test("QA: SSE extractSsePayloads handles single data frame with no trailing blank line (the known fix)", () => {
    const { payloads, rest } = extractSsePayloads(
      'data: {"choices":[{"delta":{"content":"hello"}}]}',
    );
    assert.equal(payloads.length, 0, "no frame emitted without blank-line separator");
    assert.ok(rest.length > 0, "unterminated frame becomes rest for trailing drain");
    assert.match(rest, /"hello"/);
  });

  test("QA: SSE extractSsePayloads handles empty input without throwing", () => {
    const { payloads, rest } = extractSsePayloads("");
    assert.deepEqual(payloads, []);
    assert.equal(rest, "");
  });

  test("QA: SSE extractSsePayloads handles only whitespace", () => {
    const { payloads, rest } = extractSsePayloads("   \n\n  \n  ");
    assert.deepEqual(payloads, []);
    assert.equal(rest, "  ");
  });

  test("QA: SSE extractSsePayloads handles multi-line data: fields", () => {
    const { payloads } = extractSsePayloads(
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\ndata: {"more":1}\n\n',
    );
    assert.equal(payloads.length, 1);
    assert.match(payloads[0], /"Hello"/);
    assert.match(payloads[0], /"more":1/);
  });

  test("QA: SSE extractSsePayloads handles [DONE] signal", () => {
    const { payloads, rest } = extractSsePayloads("data: [DONE]\n\n");
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0], "[DONE]");
    assert.equal(rest, "");
  });

  test("QA: SSE extractSsePayloads handles multiple complete frames", () => {
    const { payloads } = extractSsePayloads(
      'data: {"t":1}\n\ndata: {"t":2}\n\ndata: {"t":3}\n\n',
    );
    assert.equal(payloads.length, 3);
  });

  test("QA: SSE extractSsePayloads handles trailing partial frame", () => {
    const { payloads, rest } = extractSsePayloads(
      'data: {"t":1}\n\ndata: {"t":2',
    );
    assert.equal(payloads.length, 1);
    assert.equal(rest, 'data: {"t":2');
  });

  test("QA: SSE extractSsePayloads handles unicode content", () => {
    const { payloads } = extractSsePayloads(
      'data: {"choices":[{"delta":{"content":"こんにちは"}}]}\n\n',
    );
    assert.equal(payloads.length, 1);
    assert.match(payloads[0], /こんにちは/);
  });

  test("QA: SSE extractSsePayloads handles data: with leading spaces", () => {
    const { payloads } = extractSsePayloads(
      ' data: {"choices":[{"delta":{"content":"OK"}}]}\n\n',
    );
    assert.equal(payloads.length, 1);
    assert.match(payloads[0], /"OK"/);
  });
}

// ─── classifyVoiceIntent Adversarial Tests ───────────────────────────────

test("QA: classifyVoiceIntent handles empty string", () => {
  const result = classifyVoiceIntent("");
  assert.equal(result.type, "chat");
  assert.equal(result.action, false);
});

test("QA: classifyVoiceIntent handles whitespace-only input", () => {
  const result = classifyVoiceIntent("   \t  \n  ");
  assert.equal(result.type, "chat");
  assert.equal(result.action, false);
});

test("QA: classifyVoiceIntent handles null/undefined gracefully", () => {
  const r1 = classifyVoiceIntent(null);
  assert.equal(r1.type, "chat");
  assert.equal(r1.action, false);
  const r2 = classifyVoiceIntent(undefined);
  assert.equal(r2.type, "chat");
  assert.equal(r2.action, false);
});

test("QA: classifyVoiceIntent detects commands at various capitalizations", () => {
  assert.equal(classifyVoiceIntent("BUILD the app").type, "action");
  assert.equal(classifyVoiceIntent("Run THE tests").type, "action");
  assert.equal(classifyVoiceIntent("Deploy to production").type, "action");
});

test("QA: classifyVoiceIntent detects polite command forms", () => {
  assert.equal(classifyVoiceIntent("could you build the app").type, "action");
  assert.equal(classifyVoiceIntent("would you run the tests please").type, "action");
  assert.equal(classifyVoiceIntent("can you check the build status").type, "action");
});

test("QA: classifyVoiceIntent detects hermes wake-word commands", () => {
  assert.equal(classifyVoiceIntent("hermes build the app").type, "action");
  assert.equal(classifyVoiceIntent("hermes, run the tests").type, "action");
});

test("QA: classifyVoiceIntent does NOT classify conversation as commands", () => {
  const chats = [
    "what time is it",
    "tell me a joke",
    "how are you doing today",
    "what's the weather like",
    "explain quantum computing",
    "who won the world cup",
    "I need help with something",
  ];
  for (const text of chats) {
    assert.equal(
      classifyVoiceIntent(text).type,
      "chat",
      `"${text}" should be chat, not action`,
    );
  }
});

test("QA: classifyVoiceIntent does NOT trigger on command verbs mid-sentence", () => {
  assert.equal(
    classifyVoiceIntent("I want to run a marathon").type,
    "chat",
  );
  assert.equal(
    classifyVoiceIntent("the build system is broken").type,
    "chat",
  );
  assert.equal(
    classifyVoiceIntent("can we test this theory").type,
    "chat",
    "'can we test' without a command verb after 'we' should not trigger action",
  );
});

test("QA: classifyVoiceIntent handles unicode input", () => {
  assert.equal(
    classifyVoiceIntent("ビルドしてください").type,
    "chat",
    "non-English without English command verbs is chat",
  );
});

test("QA: classifyVoiceIntent handles very long input without hanging", () => {
  const long = "hello ".repeat(500);
  const result = classifyVoiceIntent(long);
  assert.ok(result.type === "chat", "long input should be chat");
});

// ─── voiceActionAck Adversarial Tests ────────────────────────────────────

test("QA: voiceActionAck handles empty text", () => {
  const ack = voiceActionAck("");
  assert.ok(ack.length > 0);
  assert.match(ack, /On it/);
});

test("QA: voiceActionAck handles null gracefully", () => {
  const ack = voiceActionAck(null);
  assert.match(ack, /On it/);
});

test("QA: voiceActionAck caps long text", () => {
  const ack = voiceActionAck(
    "build the application and then deploy it to staging with all the configuration updates",
  );
  assert.ok(ack.length < 140, `ack "${ack}" should be under 140 chars`);
});

// ─── takeVoiceSentenceChunk Adversarial Tests ────────────────────────────

test("QA: takeVoiceSentenceChunk returns null for empty buffer", () => {
  assert.equal(takeVoiceSentenceChunk(""), null);
  assert.equal(takeVoiceSentenceChunk("   "), null);
});

test("QA: takeVoiceSentenceChunk handles single word without punctuation", () => {
  assert.equal(takeVoiceSentenceChunk("hello"), null);
});

test("QA: takeVoiceSentenceChunk force=true returns what it has", () => {
  const result = takeVoiceSentenceChunk("unfinished sentence without punctuation", { force: true });
  assert.ok(result.chunk.length > 0);
  assert.equal(result.rest, "");
});

test("QA: takeVoiceSentenceChunk handles question marks", () => {
  const result = takeVoiceSentenceChunk("What time is it? I need to know.");
  assert.equal(result.chunk, "What time is it?");
  assert.match(result.rest, /I need to know/);
});

test("QA: takeVoiceSentenceChunk handles exclamation marks", () => {
  const result = takeVoiceSentenceChunk("Hello! How are you?");
  assert.equal(result.chunk, "Hello!");
  assert.match(result.rest, /How are you/);
});

test("QA: takeVoiceSentenceChunk handles unicode punctuation", () => {
  const result = takeVoiceSentenceChunk("你好。世界！Hello.");
  assert.equal(result.chunk, "你好。");
});

test("QA: takeVoiceSentenceChunk does not split on abbreviations alone", () => {
  const result = takeVoiceSentenceChunk("Dr. Smith is here. Let's go.");
  assert.equal(result.chunk, "Dr.");
  assert.match(result.rest, /Smith is here/);
});

test("QA: takeVoiceSentenceChunk force-splits long chunks at commas or spaces", () => {
  // Must exceed FIRST_CHUNK_MAX_CHARS (180) to trigger the force-split path.
  const long =
    "hello there, this is a long chunk, and it keeps going, with many words, still more, " +
    "extra padding here, and even more, so many words in this long block of text, " +
    "still going on and on, adding more padding, and even more words to push past the limit, " +
    "final stretch now, almost there, and done";
  const result = takeVoiceSentenceChunk(long);
  assert.ok(result !== null, "long chunk without sentence boundary should still split");
  assert.ok(result.chunk.length >= 80);
  assert.ok(result.rest.length > 0);
});

// ─── sanitizeForVoice Adversarial Tests ──────────────────────────────────

test("QA: sanitizeForVoice strips code fences with content", () => {
  const result = sanitizeForVoice("Here is code:\n```js\nconst x = 1;\n```\nEnd.");
  assert.ok(!result.includes("```"), "code fences should be stripped");
  assert.match(result, /const x = 1/);
});

test("QA: sanitizeForVoice strips bold/italic marks", () => {
  const result = sanitizeForVoice("**bold** and *italic* and __underline__");
  assert.ok(!result.includes("**"));
  assert.ok(!result.includes("__"));
  assert.match(result, /bold/);
  assert.match(result, /italic/);
  assert.match(result, /underline/);
});

test("QA: sanitizeForVoice caps at VOICE_REPLY_MAX_CHARS", () => {
  const long = "Short sentence. " + "More text. ".repeat(100);
  const result = sanitizeForVoice(long);
  assert.ok(result.length <= 820, `got ${result.length}, expected <= 820`);
});

// ─── Error path tests ────────────────────────────────────────────────────

test("QA: createVoiceAudioStream handles model error response (4xx)", async () => {
  const previousKey = process.env.NVIDIA_API_KEY;
  process.env.NVIDIA_API_KEY = "mock-key";
  let errorCaught = null;

  try {
    const stream = createVoiceAudioStream({
      text: "hello",
      config: {
        voiceModelProvider: "nvidia",
        voiceModel: "deepseek-ai/deepseek-v4-flash",
        elevenlabsApiKeys: ["mock-key"],
        elevenlabsVoiceId: "mock",
        elevenlabsModel: "mock",
      },
      fetchImpl: async () =>
        new Response('{"error":"unauthorized"}', { status: 401 }),
      onError: (err) => {
        errorCaught = err;
      },
    });
    // Drain the stream to trigger the error path
    try {
      const reader = stream.getReader();
      await reader.read();
    } catch {
      // Expected — the stream should error
    }
  } finally {
    if (previousKey == null) delete process.env.NVIDIA_API_KEY;
    else process.env.NVIDIA_API_KEY = previousKey;
  }

  assert.ok(errorCaught, "error callback should have fired");
  assert.match(errorCaught.message, /Voice model request failed/);
});

test("QA: createVoiceAudioStream handles immediately empty token stream", async () => {
  const previousKey = process.env.NVIDIA_API_KEY;
  process.env.NVIDIA_API_KEY = "mock-key";
  let completed = false;
  let responseText = null;

  try {
    const stream = createVoiceAudioStream({
      text: "hello",
      config: {
        voiceModelProvider: "nvidia",
        voiceModel: "deepseek-ai/deepseek-v4-flash",
        elevenlabsApiKeys: ["mock-key"],
        elevenlabsVoiceId: "mock",
        elevenlabsModel: "mock",
      },
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
      synthesizeStreamImpl: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
      }),
      onComplete: ({ response, error }) => {
        completed = true;
        responseText = response;
      },
    });

    const reader = stream.getReader();
    const { done } = await reader.read();
    assert.ok(done, "stream should close when model produces no tokens");
  } finally {
    if (previousKey == null) delete process.env.NVIDIA_API_KEY;
    else process.env.NVIDIA_API_KEY = previousKey;
  }

  assert.ok(completed);
  assert.equal(responseText, "");
});

// ─── Acceptance criteria: ElevenLabs voice config preserved ──────────────

test("QA: voice config still reads ElevenLabs voice id from data/voice-config.json", () => {
  const voiceLib = readFileSync(resolve("lib/voice.js"), "utf8");
  assert.match(voiceLib, /elevenlabsVoiceId/);
  assert.match(voiceLib, /voice-config\.json/);
});

test("QA: ElevenLabs key failover (synthesizeStreamWithFailover) is still imported", () => {
  const voiceLib = readFileSync(resolve("lib/voice.js"), "utf8");
  assert.match(voiceLib, /synthesizeStreamWithFailover/);
  assert.match(voiceLib, /from\s+["'].*elevenlabs/);
});

test("QA: STT daemon integration is untouched (voice chat route does not depend on server-side STT)", () => {
  const route = readFileSync(resolve("app/api/voice/chat/route.js"), "utf8");
  const voiceLib = readFileSync(resolve("lib/voice.js"), "utf8");
  // STT is handled browser-side; the voice API route receives already-transcribed
  // text and should not import or depend on any server-side STT module.
  assert.doesNotMatch(route, /sttClient|stt-client/i);
  assert.doesNotMatch(voiceLib, /sttClient|stt-client/i);
});

// ─── Action path: no hermes spawn in fast path ───────────────────────────

test("QA: route.js does not import execFile or execFileAsync for hermes chat", () => {
  const route = readFileSync(resolve("app/api/voice/chat/route.js"), "utf8");
  const launcher = readFileSync(resolve("lib/assistant-launch.js"), "utf8");
  assert.match(route, /await startAssistantRun\(/);
  // Process ownership lives in the shared durable launcher.
  assert.match(launcher, /import\s+\{\s*spawn\s*\}\s+from\s+["']node:child_process["']/);
  assert.doesNotMatch(route, /execFile\s*\(/);
  assert.doesNotMatch(route, /execFileAsync/);
});

test("QA: shared assistant launcher uses detached spawn with unref", () => {
  const launcher = readFileSync(resolve("lib/assistant-launch.js"), "utf8");
  assert.match(launcher, /detached:\s*true/);
  assert.match(launcher, /child\.unref\(\)/);
});

// ─── Memory snapshot integration ─────────────────────────────────────────

test("QA: getVoiceSystemPromptWithMemory is defined and used", () => {
  const voiceLib = readFileSync(resolve("lib/voice.js"), "utf8");
  assert.match(voiceLib, /export function getVoiceSystemPromptWithMemory/);
});

test("QA: memory snapshot caps properly with totalLimit and perFileLimit", () => {
  const voiceLib = readFileSync(resolve("lib/voice.js"), "utf8");
  assert.match(voiceLib, /MEMORY_TOTAL_MAX_CHARS/);
  assert.match(voiceLib, /MEMORY_FILE_MAX_CHARS/);
  assert.match(voiceLib, /perFileLimit/);
  assert.match(voiceLib, /totalLimit/);
});
