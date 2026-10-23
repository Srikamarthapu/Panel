import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getDirectConfig, publicDirectConfig, saveDirectConfig } from "../../lib/direct-config.js";
import { directProviderPublicMessage, listDirectModels, streamDirectCompletion } from "../../lib/direct-provider.js";
import { directMessages } from "../../lib/direct-runtime.js";

const makeTemp = () => fs.mkdtempSync(path.join(os.tmpdir(), "panel-direct-test-"));
const withData = async callback => {
  const previous = process.env.PANEL_DATA_DIR;
  const directory = makeTemp();
  process.env.PANEL_DATA_DIR = directory;
  try { return await callback(directory); }
  finally { if (previous === undefined) delete process.env.PANEL_DATA_DIR; else process.env.PANEL_DATA_DIR = previous; fs.rmSync(directory, { recursive: true, force: true }); }
};

function sse(lines, onCancel = () => {}, keepOpen = false) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) { for (const line of lines) controller.enqueue(encoder.encode(line)); if (!keepOpen) controller.close(); },
    cancel: onCancel,
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("direct configuration keeps credentials server-only and rejects inherited providers", { concurrency: false }, () => withData(directory => {
  const saved = saveDirectConfig({ credentialProvider: "openai", apiKey: "private-test-key" });
  assert.equal(publicDirectConfig(saved).providers.find(item => item.id === "openai").configured, true);
  assert.equal(JSON.stringify(publicDirectConfig(saved)).includes("private-test-key"), false);
  assert.equal(JSON.stringify(getDirectConfig()).includes("private-test-key"), true);
  assert.equal(fs.statSync(path.join(directory, "direct-provider.json")).mode & 0o077, 0);
  assert.throws(() => saveDirectConfig({ credentialProvider: "constructor", apiKey: "bad" }), /supported direct provider/);
  assert.throws(() => saveDirectConfig({ credentialProvider: "openai", apiKey: "bad key" }), /without spaces/);
}));

test("catalog lookup uses the fixed provider destination without running inference", { concurrency: false }, () => withData(async () => {
  saveDirectConfig({ credentialProvider: "openai", apiKey: "catalog-key" });
  let observed;
  const models = await listDirectModels("openai", { fetchImpl: async (url, options) => {
    observed = { url: String(url), redirect: options.redirect, authorization: options.headers.Authorization, method: options.method };
    return Response.json({ data: [{ id: "provider-model-a", owned_by: "provider" }, { id: "provider-model-a" }, { id: "provider-model-b" }] });
  } });
  assert.deepEqual(observed, { url: "https://api.openai.com/v1/models", redirect: "error", authorization: "Bearer catalog-key", method: "GET" });
  assert.deepEqual(models.map(item => item.id), ["provider-model-a", "provider-model-b"]);
}));

test("streaming emits confirmed text and usage, and never sends tools", async () => {
  const chunks = [], bodies = [];
  const result = await streamDirectCompletion({ provider: "deepseek", model: "provider-model", apiKey: "stream-key", messages: [{ role: "user", content: "hello" }], onDelta: value => chunks.push(value) }, {
    fetchImpl: async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return sse([
        'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{"content":" there"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
        "data: [DONE]\n\n",
      ]);
    },
  });
  assert.equal(result.response, "Hello there");
  assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 2, totalTokens: 5, costUsd: null });
  assert.deepEqual(chunks, ["Hello", " there"]);
  assert.equal(Object.hasOwn(bodies[0], "tools"), false);
  assert.equal(bodies[0].stream, true);
});

test("truncated and capped streams fail and cancel their readers", async () => {
  await assert.rejects(
    streamDirectCompletion({ provider: "openai", model: "m", apiKey: "k", messages: [] }, { fetchImpl: async () => sse(['data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n']) }),
    error => /connection ended before the answer was complete/.test(error.message) && /text received is incomplete/.test(error.message),
  );
  let cappedCancelled = false;
  await assert.rejects(streamDirectCompletion({ provider: "openai", model: "m", apiKey: "k", messages: [] }, { fetchImpl: async () => sse([`data: ${JSON.stringify({ choices: [{ delta: { content: "x".repeat(64_001) }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`], () => { cappedCancelled = true; }, true) }), /conversation limit/);
  assert.equal(cappedCancelled, true);
});

test("provider-controlled completion status is never copied into a public error", async () => {
  const reflected = "secret-finish-sentinel";
  await assert.rejects(
    streamDirectCompletion({ provider: "openai", model: "m", apiKey: "k", messages: [] }, { fetchImpl: async () => sse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "partial" }, finish_reason: reflected }] })}\n\n`,
      "data: [DONE]\n\n",
    ]) }),
    error => /unsupported completion status/.test(error.message) && !error.message.includes(reflected),
  );
});

test("an oversized declared response is cancelled before returning", { concurrency: false }, () => withData(async () => {
  saveDirectConfig({ credentialProvider: "openai", apiKey: "catalog-key" });
  let cancelled = false;
  await assert.rejects(listDirectModels("openai", { fetchImpl: async () => new Response(new ReadableStream({
    start(stream) { stream.enqueue(new TextEncoder().encode("{}")); },
    cancel() { cancelled = true; },
  }), { status: 200, headers: { "content-length": String(5 * 1024 * 1024) } }) }), /more data than Panel can safely read/);
  assert.equal(cancelled, true);
}));

test("body timeout and caller cancellation stop a stalled provider stream", async () => {
  for (const external of [false, true]) {
    let aborted = false;
    const controller = new AbortController();
    const promise = streamDirectCompletion({ provider: "openrouter", model: "m", apiKey: "k", messages: [], ...(external ? { signal: controller.signal } : {}) }, {
      timeoutMs: 25,
      fetchImpl: async (_url, options) => new Response(new ReadableStream({
        start(stream) { options.signal.addEventListener("abort", () => { aborted = true; stream.error(options.signal.reason); }, { once: true }); },
      }), { status: 200 }),
    });
    if (external) setTimeout(() => controller.abort(), 5);
    let caught;
    try { await promise; } catch (error) { caught = error; }
    assert.ok(caught);
    if (!external) assert.equal(directProviderPublicMessage(caught, "fallback"), "The provider request timed out.");
    assert.equal(aborted, true);
  }
});

test("late cancellation after a streamed delta cannot return success", async () => {
  const controller = new AbortController();
  const deltas = [];
  let upstreamAborted = false;
  const pending = streamDirectCompletion({ provider: "deepseek", model: "m", apiKey: "k", messages: [], signal: controller.signal, onDelta: delta => deltas.push(delta) }, {
    fetchImpl: async (_url, options) => new Response(new ReadableStream({
      start(stream) {
        stream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n'));
        options.signal.addEventListener("abort", () => { upstreamAborted = true; stream.error(options.signal.reason); }, { once: true });
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } }),
  });
  await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort(new Error("stopped by caller"));
  await assert.rejects(pending);
  assert.deepEqual(deltas, ["partial"]);
  assert.equal(upstreamAborted, true);
});

test("provider errors never reflect remote secrets or request content", async () => {
  const reflected = "private-key-from-provider-error";
  await assert.rejects(
    streamDirectCompletion({ provider: "openai", model: "m", apiKey: reflected, messages: [] }, { fetchImpl: async () => Response.json({ error: { message: `Rejected ${reflected}` } }, { status: 500 }) }),
    error => !error.message.includes(reflected) && /temporarily unavailable/.test(error.message),
  );
});

test("transport exceptions are generic at the public provider boundary", { concurrency: false }, () => withData(async () => {
  const reflected = "secret-in-fetch-exception";
  saveDirectConfig({ credentialProvider: "openai", apiKey: "catalog-key" });
  let caught;
  try {
    await listDirectModels("openai", { fetchImpl: async () => { const error = new Error(`socket failed with ${reflected}`); error.status = 418; throw error; } });
  } catch (error) { caught = error; }
  assert.equal(directProviderPublicMessage(caught, "The provider model list could not be loaded."), "The provider model list could not be loaded.");
  assert.equal(directProviderPublicMessage(caught, "fallback").includes(reflected), false);
}));

test("direct role prompt is honest about unavailable tools", () => {
  const messages = directMessages({ text: "Help", agentName: "Reviewer", agentSoul: "You review plans.", history: [{ role: "assistant", content: "Earlier" }] });
  assert.match(messages[0].content, /no tools, file access, command execution, web access, delegation/);
  assert.equal(messages.at(-1).content, "Help");
});

test("doctor accepts a configured direct-only cold environment", { concurrency: false }, async () => {
  const directory = makeTemp();
  const missing = path.join(directory, "missing-hermes");
  try {
    fs.writeFileSync(path.join(directory, "direct-provider.json"), JSON.stringify({ version: 1, executionMode: "direct", provider: "openai", model: "provider-model", credentials: { openai: { apiKey: "doctor-key" } } }), { mode: 0o600 });
    const { stdout } = await promisify(execFile)(process.execPath, ["scripts/doctor.mjs"], { cwd: process.cwd(), env: { ...process.env, PANEL_DATA_DIR: directory, HERMES_HOME: missing, HERMES_REPO: missing, HERMES_CLI_PATH: path.join(missing, "hermes") }, timeout: 15_000 });
    assert.match(stdout, /OK  Direct API connection/);
    assert.match(stdout, /Ready to build and start Panel in Direct API mode/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
