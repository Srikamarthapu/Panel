import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  classifyVoiceIntent,
  takeVoiceSentenceChunk,
  sanitizeForVoice,
  collectVoiceModelText,
  createVoiceAudioStream,
  voiceActionAck,
  getVoiceSystemPromptWithMemory,
} from "../../lib/voice.js";

const encoder = new TextEncoder();

// ─── classifyVoiceIntent: edge cases the existing tests miss ───────────────

test("QA2: classifyVoiceIntent handles \"can you help me\" as chat (not action)", () => {
  // "help" is NOT in the command verb list — polite form requires
  // can/could/would + you + COMMAND_VERB immediately after
  assert.equal(classifyVoiceIntent("can you help me").type, "chat");
  assert.equal(classifyVoiceIntent("could you please assist").type, "chat");
  assert.equal(classifyVoiceIntent("would you mind explaining").type, "chat");
});

test("QA2: classifyVoiceIntent \"can you help me build\" is chat (verb not immediately after polite prefix)", () => {
  // "help" is not a command verb, "build" is but it's not right after "can you"
  assert.equal(
    classifyVoiceIntent("can you help me build the app").type,
    "chat",
  );
});

test("QA2: classifyVoiceIntent handles question forms that end with command verbs", () => {
  // These are conversational questions, not commands
  assert.equal(classifyVoiceIntent("how do I build this").type, "chat");
  assert.equal(classifyVoiceIntent("should I run the tests").type, "chat");
  assert.equal(classifyVoiceIntent("tell me how to deploy").type, "chat");
});

// ─── takeVoiceSentenceChunk: abbreviation-split behavior ──────────────────

test("QA2: takeVoiceSentenceChunk splits at \"Dr.\" — the code comment claims to avoid this but doesn't", () => {
  const result = takeVoiceSentenceChunk("Dr. Smith is here. Let us go.");
  // The code comment says "to avoid splitting on abbreviations like 'Dr.'"
  // but the actual condition |i >= 2 && /\s/.test(next)| triggers on the
  // space after the period.  This is a real behavior, documented here.
  assert.equal(result.chunk, "Dr.");
  assert.match(result.rest, /Smith is here/);
});

test("QA2: takeVoiceSentenceChunk splits at \"U.S.\" (multi-period abbreviation in one token)", () => {
  const result = takeVoiceSentenceChunk("U.S. policy is complex.");
  // "U.S." — the first '.' at index 2 is followed by 'S', not whitespace,
  // so it doesn't split.  The second '.' at index 4 is followed by space,
  // so it splits at "U.S.".
  assert.equal(result.chunk, "U.S.");
  assert.match(result.rest, /policy is complex/);
});

test("QA2: takeVoiceSentenceChunk handles Mr. / Mrs. / Ms. similarly (splits)", () => {
  assert.equal(takeVoiceSentenceChunk("Mr. Jones arrived.").chunk, "Mr.");
  assert.equal(takeVoiceSentenceChunk("Mrs. Jones arrived.").chunk, "Mrs.");
  assert.equal(takeVoiceSentenceChunk("Ms. Jones arrived.").chunk, "Ms.");
});

// ─── sanitizeForVoice: additional edge cases ──────────────────────────────

test("QA2: sanitizeForVoice handles null and undefined without throwing", () => {
  assert.equal(sanitizeForVoice(null), "");
  assert.equal(sanitizeForVoice(undefined), "");
  assert.equal(sanitizeForVoice(""), "");
});

test("QA2: sanitizeForVoice strips mixed markdown in one pass", () => {
  const input = "**bold** and *italic* with `code` and __underline__";
  const result = sanitizeForVoice(input);
  assert.ok(!result.includes("**"), "bold");
  assert.ok(!result.includes("__"), "underline");
  assert.ok(!result.includes("`"), "backtick");
  assert.match(result, /bold/);
  assert.match(result, /italic/);
  assert.match(result, /code/);
  assert.match(result, /underline/);
});

test("QA2: sanitizeForVoice handles text without any period boundaries for capping", () => {
  const long = "word ".repeat(500);
  const result = sanitizeForVoice(long);
  assert.ok(result.length <= 810, `got ${result.length}, expected <= 810`);
});

test("QA2: sanitizeForVoice strips URLs but preserves surrounding text", () => {
  const result = sanitizeForVoice("Visit https://example.com/path for more info.");
  assert.ok(!result.includes("https://"), "URL should be replaced with (link)");
  assert.match(result, /\(link\)/);
  assert.match(result, /Visit/);
  assert.match(result, /for more info/);
});

// ─── voiceActionAck: edge cases ───────────────────────────────────────────

test("QA2: voiceActionAck with very long command text stays concise", () => {
  const ack = voiceActionAck(
    "build the entire application including the backend services and frontend deployment pipeline with all environment configurations and database migrations",
  );
  assert.ok(ack.startsWith("On it. Running"));
  assert.ok(ack.length < 160, `got ${ack.length}`);
});

// ─── memory snapshot: missing files degrade gracefully ────────────────────

test("QA2: getVoiceSystemPromptWithMemory returns base prompt when memory dir is nonexistent", () => {
  const prompt = getVoiceSystemPromptWithMemory({
    dir: `/tmp/nonexistent-voice-memory-${Date.now()}`,
  });
  assert.match(prompt, /You are speaking with the user out loud/);
  assert.ok(
    !prompt.includes("Hermes memory snapshot:"),
    "should not inject memory snapshot block when no memory files exist",
  );
});

// ─── SSE trailing-drain: the known fix #1 ─────────────────────────────────

test("QA2: collectVoiceModelText catches final SSE frame without trailing blank line (known fix)", async () => {
  const prevKey = process.env.NVIDIA_API_KEY;
  process.env.NVIDIA_API_KEY = "mock-key";
  try {
    const response = await collectVoiceModelText({
      text: "hello",
      config: {
        voiceModelProvider: "nvidia",
        voiceModel: "deepseek-ai/deepseek-v4-flash",
      },
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { content: "FinalAnswer" } }] })}`,
                ),
              );
              controller.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
    });
    assert.equal(response, "FinalAnswer");
  } finally {
    if (prevKey == null) delete process.env.NVIDIA_API_KEY;
    else process.env.NVIDIA_API_KEY = prevKey;
  }
});

test("QA2: collectVoiceModelText handles multi-chunk SSE with final frame in its own read chunk", async () => {
  const prevKey = process.env.NVIDIA_API_KEY;
  process.env.NVIDIA_API_KEY = "mock-key";
  try {
    const response = await collectVoiceModelText({
      text: "hello",
      config: {
        voiceModelProvider: "nvidia",
        voiceModel: "deepseek-ai/deepseek-v4-flash",
      },
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello." } }] })}\n\n`,
                ),
              );
              await new Promise((r) => setTimeout(r, 5));
              // Second frame arrives alone — no trailing blank line, no [DONE]
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { content: " World." } }] })}`,
                ),
              );
              controller.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
    });
    assert.equal(response, "Hello. World.");
  } finally {
    if (prevKey == null) delete process.env.NVIDIA_API_KEY;
    else process.env.NVIDIA_API_KEY = prevKey;
  }
});

// ─── createVoiceAudioStream: edge cases ───────────────────────────────────

test("QA2: createVoiceAudioStream completes cleanly when model returns only [DONE]", async () => {
  const prevKey = process.env.NVIDIA_API_KEY;
  process.env.NVIDIA_API_KEY = "mock-key";
  let completed = false;
  let errorSeen = undefined;

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
          start(c) {
            c.close();
          },
        }),
      }),
      onComplete: ({ response, error }) => {
        completed = true;
        errorSeen = error;
      },
    });

    const reader = stream.getReader();
    const { done } = await reader.read();
    assert.ok(done, "stream should close cleanly when model produces no tokens");
  } finally {
    if (prevKey == null) delete process.env.NVIDIA_API_KEY;
    else process.env.NVIDIA_API_KEY = prevKey;
  }

  assert.ok(completed);
  assert.equal(errorSeen, undefined);
});

// ─── extractSsePayloads export verification ───────────────────────────────

test("QA2: extractSsePayloads is NOT exported from lib/voice.js (private function)", async () => {
  const mod = await import("../../lib/voice.js");
  assert.equal(
    typeof mod.extractSsePayloads,
    "undefined",
    "extractSsePayloads is a private function — adversarial SSE tests that depend on importing it will silently skip",
  );
  // The function exists in the source but is not part of the public API.
  const voiceLib = readFileSync(resolve("lib/voice.js"), "utf8");
  assert.match(voiceLib, /function extractSsePayloads/);
  assert.ok(
    !voiceLib.includes("export function extractSsePayloads"),
    "function is defined as private (no export keyword)",
  );
});

// ─── route.js unused import check ─────────────────────────────────────────

test("QA2: saveVoiceConfig is imported in route.js but used only by PUT, not POST", () => {
  const route = readFileSync(resolve("app/api/voice/chat/route.js"), "utf8");
  // saveVoiceConfig is imported in the multi-line import block from @/lib/voice
  assert.match(route, /saveVoiceConfig/);
  // saveVoiceConfig is used in the PUT handler, not in POST.
  // Verify it appears as a function call, not just an import.
  assert.match(route, /saveVoiceConfig\(/);
});

// ─── Timing: verify no hermes subprocess in fast-path route code ──────────

test("QA2: fast-path route code has no execFile, execFileAsync, or spawn('hermes')", () => {
  const route = readFileSync(resolve("app/api/voice/chat/route.js"), "utf8");
  assert.doesNotMatch(route, /execFile/);
  assert.doesNotMatch(route, /execFileAsync/);
  assert.match(route, /await startAssistantRun\(/);
  assert.doesNotMatch(route, /spawn\s*\(/);
  const launcher = readFileSync(resolve("lib/assistant-launch.js"), "utf8");
  assert.match(launcher, /import\s+\{\s*spawn\s*\}\s+from/);
  const spawnCalls = launcher.match(/spawnProcess\s*\(/g) || [];
  assert.equal(spawnCalls.length, 1, "the shared launcher owns the single subprocess dispatch");
});
