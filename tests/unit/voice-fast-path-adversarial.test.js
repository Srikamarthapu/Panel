import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path, { resolve } from "node:path";
import { collectVoiceModelText, createVoiceAudioStream, getVoiceSystemPromptWithMemory } from "../../lib/voice.js";

const encoder = new TextEncoder();

function mockConfig() {
  return {
    voiceModelProvider: "nvidia",
    voiceModel: "deepseek-ai/deepseek-v4-flash",
    elevenlabsApiKeys: ["mock-elevenlabs-key"],
    elevenlabsVoiceId: "pFZP5JQG7iQjIQuC4Bku",
    elevenlabsModel: "eleven_flash_v2_5",
    elevenlabsVoiceSettings: { stability: 0.51 },
  };
}

test("T-0006 harness exercises the voice chat request path, not only the lower-level stream helper", () => {
  const harness = readFileSync(resolve("scripts/voice/fast-path-harness.mjs"), "utf8");
  const routeTestSources = [
    readFileSync(resolve("tests/unit/voice-fast-path.test.js"), "utf8"),
    readFileSync(resolve("tests/unit/voice-contract-regression.test.js"), "utf8"),
  ].join("\n");

  const evidence = `${harness}\n${routeTestSources}`;
  assert.match(
    evidence,
    /app\/api\/voice\/chat\/route\.js|from\s+["']@\/app\/api\/voice\/chat\/route/,
    "the mocked timing harness/test must call the /api/voice/chat POST request path so a route-level Hermes spawn regression fails",
  );
  assert.match(evidence, /\bPOST\s*\(\s*new Request|\bPOST\s*\(/);
});

test("T-0006 fast path forwards the configured ElevenLabs voice id, model, and settings to streaming TTS", async () => {
  const previousKey = process.env.NVIDIA_API_KEY;
  process.env.NVIDIA_API_KEY = "mock-key";
  const ttsCalls = [];

  try {
    const stream = createVoiceAudioStream({
      text: "hello",
      config: mockConfig(),
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hello there." } }] })}\n\n`),
              );
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
      synthesizeStreamImpl: async (input) => {
        ttsCalls.push(input);
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode("mp3"));
              controller.close();
            },
          }),
        };
      },
    });

    await stream.getReader().read();
  } finally {
    if (previousKey == null) delete process.env.NVIDIA_API_KEY;
    else process.env.NVIDIA_API_KEY = previousKey;
  }

  assert.equal(ttsCalls.length, 1);
  assert.equal(ttsCalls[0].voiceId, "pFZP5JQG7iQjIQuC4Bku");
  assert.equal(ttsCalls[0].modelId, "eleven_flash_v2_5");
  assert.deepEqual(ttsCalls[0].voiceSettings, { stability: 0.51 });
});

test("T-0006 direct model stream accepts a final SSE data frame without a trailing blank line", async () => {
  const previousKey = process.env.NVIDIA_API_KEY;
  process.env.NVIDIA_API_KEY = "mock-key";

  try {
    const response = await collectVoiceModelText({
      text: "hello",
      config: mockConfig(),
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hello." } }] })}`),
              );
              controller.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
    });

    assert.equal(response, "Hello.");
  } finally {
    if (previousKey == null) delete process.env.NVIDIA_API_KEY;
    else process.env.NVIDIA_API_KEY = previousKey;
  }
});

test("T-0006 memory snapshot is prepended and capped before the voice system prompt", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voice-memory-"));
  try {
    writeFileSync(path.join(dir, "USER.md"), `${"user ".repeat(200)}\n`, "utf8");
    writeFileSync(path.join(dir, "MEMORY.md"), `${"memory ".repeat(200)}\n`, "utf8");

    const prompt = getVoiceSystemPromptWithMemory({
      dir,
      totalLimit: 500,
      perFileLimit: 180,
    });

    assert.ok(prompt.startsWith("Hermes memory snapshot:\nUSER.md:"), "memory digest must be prepended");
    assert.match(prompt, /MEMORY\.md:/);
    assert.match(prompt, /You are speaking with the user out loud/);
    assert.ok(
      prompt.indexOf("Hermes memory snapshot:") < prompt.indexOf("You are speaking with the user out loud"),
      "system prompt should follow the compact memory digest",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
