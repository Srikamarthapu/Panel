#!/usr/bin/env node

import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const encoder = new TextEncoder();

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HARNESS_DIR, "..", "..");

// Model + TTS mock bodies reused by both the low-level stream test and the
// route-level fetch stub so the whole fast path runs against mocks.
function makeModelStreamResponse() {
  return new Response(
    new ReadableStream({
      async start(controller) {
        await sleep(18);
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hello. " } }] })}\n\n`),
        );
        await sleep(12);
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "Fast path is live." } }] })}\n\n`),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream", "X-Mock-Endpoint": "voice-model" },
    },
  );
}

function makeTtsStreamResponse(bytesLabel = "mp3") {
  return new Response(
    new ReadableStream({
      async start(controller) {
        await sleep(9);
        controller.enqueue(encoder.encode(bytesLabel));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "audio/mpeg", "X-Mock-Endpoint": "elevenlabs" } },
  );
}

// Seed a throwaway voice-config.json fixture + a minimal ~/.hermes so the route
// resolves a real (mock-backed) model config instead of the error branch or a
// live network call. NEVER touches the repo's data/voice-config.json.
function seedFixtureEnv() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "voice-fast-path-"));
  const dataDir = path.join(tmpRoot, "data");
  const hermesHome = path.join(tmpRoot, ".hermes");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(hermesHome, { recursive: true });

  const voiceConfig = {
    voiceModelProvider: "nvidia",
    voiceModel: "deepseek-ai/deepseek-v4-flash",
    elevenlabsApiKeys: ["mock-elevenlabs-key"],
    elevenlabsActiveKey: "mock-elevenlabs-key",
    elevenlabsVoiceId: "pFZP5JQG7iQjIQuC4Bku",
    elevenlabsModel: "eleven_flash_v2_5",
  };
  fs.writeFileSync(
    path.join(dataDir, "voice-config.json"),
    JSON.stringify(voiceConfig, null, 2),
    "utf8",
  );
  // Minimal config.yaml so readHermesModelDefaults() has something benign to
  // read (the explicit provider/model above already win).
  fs.writeFileSync(
    path.join(hermesHome, "config.yaml"),
    "model:\n  provider: nvidia\n  default: deepseek-ai/deepseek-v4-flash\n",
    "utf8",
  );

  return { tmpRoot, hermesHome };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mockFetchEndpoint(url) {
  if (!String(url).endsWith("/chat/completions")) {
    return new Response("not found", { status: 404 });
  }
  return new Response(
    new ReadableStream({
      async start(controller) {
        await sleep(18);
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hello. " } }] })}\n\n`),
        );
        await sleep(12);
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "Fast path is live." } }] })}\n\n`),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "X-Mock-Endpoint": "voice-model",
      },
    },
  );
}

async function mockTtsEndpoint({ text }) {
  return {
    stream: new ReadableStream({
      async start(controller) {
        await sleep(9);
        controller.enqueue(encoder.encode(`mp3:${text}`));
        controller.close();
      },
    }),
    keyUsed: "mock",
    model: "eleven_flash_v2_5",
    voiceId: "pFZP5JQG7iQjIQuC4Bku",
  };
}

async function readAll(stream) {
  const reader = stream.getReader();
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value?.byteLength || 0;
  }
  return bytes;
}

function commandTokens(command, args) {
  const tokens = [command];
  if (Array.isArray(args)) tokens.push(...args);
  return tokens.map((token) => String(token || ""));
}

function isHermesSubprocess(command, args) {
  const tokens = commandTokens(command, args);
  return tokens.some((token) => {
    const lower = token.toLowerCase();
    return path.basename(lower) === "hermes" || lower.includes("hermes chat") || lower.endsWith("run-hermes-action.mjs");
  });
}

function installChildProcessGuard() {
  let hermesSpawnCalls = 0;
  const originals = new Map();

  for (const method of ["spawn", "exec", "execFile"]) {
    const original = childProcess[method];
    originals.set(method, original);
    childProcess[method] = function guardedChildProcess(command, ...rest) {
      const args = Array.isArray(rest[0]) ? rest[0] : [];
      if (isHermesSubprocess(command, args)) {
        hermesSpawnCalls += 1;
        throw new Error(
          `Hermes subprocess attempted in fast path via child_process.${method}: ${commandTokens(command, args).join(" ")}`,
        );
      }
      return Reflect.apply(original, this, [command, ...rest]);
    };
  }

  return {
    getHermesSpawnCalls: () => hermesSpawnCalls,
    restore: () => {
      for (const [method, original] of originals) {
        childProcess[method] = original;
      }
    },
  };
}

async function exerciseRoutePostPath() {
  // Exercise the route POST() handler on the REAL streaming fast path so the
  // harness proves the happy path, not just the error branch. We seed a temp
  // voice-config.json fixture (never the repo's real one), pin ~/.hermes to a
  // temp dir, and stub global fetch so the model + ElevenLabs calls are mocked
  // rather than hitting the live network.
  //
  // The route imports Next.js @/ aliases; we chdir into the fixture (so
  // process.cwd()-relative stores like data/voice-config.json read the
  // fixture) while pinning the alias root to the real repo via
  // HARNESS_ALIAS_ROOT so those imports still resolve.
  const originalCwd = process.cwd();
  const originalFetch = globalThis.fetch;
  const originalHermesHome = process.env.HERMES_HOME;
  const originalAliasRoot = process.env.HARNESS_ALIAS_ROOT;
  const originalNvidiaKey = process.env.NVIDIA_API_KEY;

  const { tmpRoot, hermesHome } = seedFixtureEnv();
  let routeTtsRequests = 0;
  let routeModelRequests = 0;

  try {
    process.env.HARNESS_ALIAS_ROOT = REPO_ROOT;
    process.env.HERMES_HOME = hermesHome;
    process.env.NVIDIA_API_KEY = "mock-key";
    process.chdir(tmpRoot);

    // Mock every outbound call the route makes: the model completions endpoint
    // and the ElevenLabs streaming TTS endpoint. Anything else 404s so a stray
    // real request is loud, not silent.
    globalThis.fetch = async (input) => {
      const url = String(typeof input === "string" ? input : input?.url || "");
      if (url.endsWith("/chat/completions")) {
        routeModelRequests += 1;
        return makeModelStreamResponse();
      }
      if (url.includes("api.elevenlabs.io") && url.includes("/stream")) {
        routeTtsRequests += 1;
        return makeTtsStreamResponse("mp3-route");
      }
      return new Response("unexpected fetch in harness", { status: 404 });
    };

    try {
      const { register } = await import("node:module");
      const loaderUrl = new URL("./alias-loader.mjs", import.meta.url).href;
      register(loaderUrl, import.meta.url);
    } catch {
      // node:module register not available — fall through
    }

    const mod = await import("../../app/api/voice/chat/route.js");
    const { POST } = mod;

    // audio:true drives the STREAMING fast path (createVoiceAudioStream), the
    // real deployed shape — not the plain-JSON collectVoiceModelText branch.
    const response = await POST(
      new Request("http://localhost/api/voice/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          accept: "audio/mpeg, application/json",
        },
        body: JSON.stringify({ text: "hello route test", audio: true, stt_ms: 1100 }),
      }),
    );

    const contentType = response.headers.get("Content-Type") || "";
    const voiceMode = response.headers.get("X-Voice-Mode") || "";
    const turnId = response.headers.get("X-Voice-Turn-Id") || "";
    let audioBytes = 0;
    if (response.body && typeof response.body.getReader === "function") {
      audioBytes = await readAll(response.body);
    }

    return {
      route_exercised: true,
      route_status: response.status,
      route_content_type: contentType,
      route_voice_mode: voiceMode,
      route_turn_id_present: Boolean(turnId),
      route_audio_bytes: audioBytes,
      route_model_requests: routeModelRequests,
      route_tts_requests: routeTtsRequests,
    };
  } catch (err) {
    return { route_exercised: false, reason: String(err.message).slice(0, 200) };
  } finally {
    globalThis.fetch = originalFetch;
    process.chdir(originalCwd);
    if (originalHermesHome == null) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = originalHermesHome;
    if (originalAliasRoot == null) delete process.env.HARNESS_ALIAS_ROOT;
    else process.env.HARNESS_ALIAS_ROOT = originalAliasRoot;
    if (originalNvidiaKey == null) delete process.env.NVIDIA_API_KEY;
    else process.env.NVIDIA_API_KEY = originalNvidiaKey;
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

async function main() {
  const previousKey = process.env.NVIDIA_API_KEY;
  const childProcessGuard = installChildProcessGuard();
  process.env.NVIDIA_API_KEY = "mock-key";
  const startedAt = Date.now();
  const timings = {
    stt_ms: 1100,
    llm_first_token_ms: null,
    tts_first_byte_ms: null,
    total_ms: null,
  };
  let ttsRequests = 0;

  try {
    const routeResult = await exerciseRoutePostPath();

    const { createVoiceAudioStream } = await import("../../lib/voice.js");
    const stream = createVoiceAudioStream({
      text: "hello",
      config: {
        voiceModelProvider: "nvidia",
        voiceModel: "deepseek-ai/deepseek-v4-flash",
        elevenlabsApiKeys: ["mock-elevenlabs-key"],
        elevenlabsVoiceId: "pFZP5JQG7iQjIQuC4Bku",
        elevenlabsModel: "eleven_flash_v2_5",
      },
      fetchImpl: mockFetchEndpoint,
      synthesizeStreamImpl: async (input) => {
        ttsRequests += 1;
        return mockTtsEndpoint(input);
      },
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

    const audioBytes = await readAll(stream);
    if (timings.total_ms == null) timings.total_ms = Date.now() - startedAt;
    const hermesSpawnCalls = childProcessGuard.getHermesSpawnCalls();
    if (hermesSpawnCalls > 0) {
      throw new Error(`Fast path attempted ${hermesSpawnCalls} Hermes subprocess call(s).`);
    }

    // The route must have run the REAL streaming happy path against mocks:
    // audio content-type, mocked model + TTS calls, real audio bytes, and a
    // turn id for transcript correction. If the route only hit the error
    // branch (the old harness gap) this assertion fails loudly.
    if (!routeResult.route_exercised) {
      throw new Error(`Route POST() did not run: ${routeResult.reason || "unknown"}`);
    }
    if (!String(routeResult.route_content_type || "").includes("audio/")) {
      throw new Error(
        `Route did not stream audio (content-type=${routeResult.route_content_type}); happy path not exercised.`,
      );
    }
    if (!(routeResult.route_audio_bytes > 0)) {
      throw new Error("Route streamed zero audio bytes; happy path not exercised.");
    }
    if (!(routeResult.route_model_requests > 0) || !(routeResult.route_tts_requests > 0)) {
      throw new Error(
        `Route did not hit both mocked endpoints (model=${routeResult.route_model_requests}, tts=${routeResult.route_tts_requests}).`,
      );
    }

    const result = {
      mocked: true,
      mock_endpoints: ["voice-model:/chat/completions", "tts:/stream"],
      route_exercised: routeResult.route_exercised,
      route_happy_path: {
        status: routeResult.route_status,
        content_type: routeResult.route_content_type,
        voice_mode: routeResult.route_voice_mode,
        turn_id_present: routeResult.route_turn_id_present,
        audio_bytes: routeResult.route_audio_bytes,
        model_requests: routeResult.route_model_requests,
        tts_requests: routeResult.route_tts_requests,
      },
      audio_bytes: audioBytes,
      tts_requests: ttsRequests,
      hermes_spawn_calls_in_fast_path: hermesSpawnCalls,
      stt_ms: timings.stt_ms,
      llm_first_token_ms: timings.llm_first_token_ms,
      tts_first_byte_ms: timings.tts_first_byte_ms,
      total_ms: timings.total_ms,
    };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    childProcessGuard.restore();
    if (previousKey == null) delete process.env.NVIDIA_API_KEY;
    else process.env.NVIDIA_API_KEY = previousKey;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
