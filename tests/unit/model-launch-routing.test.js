import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const appRoot = process.cwd();
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "panel-model-launch-"));
process.env.PANEL_DATA_DIR = path.join(temporary, "data");
process.env.PANEL_APP_ROOT = appRoot;
process.env.HERMES_HOME = path.join(temporary, "hermes");
process.env.HERMES_VOICE_TRANSPORT = "legacy";
process.env.OPENAI_API_KEY = "route-fixture-key";
fs.mkdirSync(process.env.HERMES_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.HERMES_HOME, "config.yaml"), "model:\n  provider: nvidia\n  default: nvidia/nemotron-3.5-super-vl-120b-a12b\n");

const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith("@/")) return nextResolve(specifier, context);
  const target = path.resolve(appRoot, specifier.slice(2));
  return nextResolve(pathToFileURL(fs.existsSync(target) ? target : `${target}.js`).href, context);
} });
const chatRoute = await import("../../app/api/voice/chat/route.js");
const resolutionRoute = await import("../../app/api/models/resolution/route.js");
const chatHandler = await import("../../lib/voice-chat-handler.js");
const switchResponse = await import("../../lib/model-switch-response.js");
const launcher = await import("../../lib/assistant-launch.js");
const direct = await import("../../lib/direct-config.js");
const runs = await import("../../lib/assistant-runs.js");
const agents = await import("../../lib/work-agents.js");
const voice = await import("../../lib/voice.js");
hooks.deregister();

function fakeSpawner() {
  const calls = [];
  const spawnProcess = (command, args, options) => {
    const child = new EventEmitter();
    child.pid = process.pid;
    child.unref = () => {};
    calls.push({ command, args, options });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
  return { calls, spawnProcess };
}

test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

test("the real conversation handler launches typed Talk and microphone Chat with their resolved surface models", async () => {
  voice.saveSurfaceModelPreference("chat", { mode: "follow-main" });
  voice.saveSurfaceModelPreference("talk", { mode: "pin", provider: "deepseek", model: "deepseek-v4-flash", reasoningEffort: "low" });
  const spawner = fakeSpawner();
  const start = input => launcher.startAssistantRun(input, { spawnProcess: spawner.spawnProcess });

  const typedTalk = await chatHandler.handleVoiceChatRequest(new Request("http://127.0.0.1/api/voice/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "typed from Talk", sessionId: "typed-talk", actionId: "typed-talk-run", audio: false, surface: "talk" }),
  }), { start });
  assert.equal(typedTalk.status, 200);
  const talkRun = runs.getAssistantRun("typed-talk-run", "typed-talk");
  const talkPayload = JSON.parse(fs.readFileSync(runs.requestFileForRun(talkRun.id), "utf8"));
  assert.deepEqual([talkRun.surface, talkRun.textOnly, talkRun.requestedProvider, talkRun.requestedModel, talkRun.modelOrigin], ["talk", true, "deepseek", "deepseek-v4-flash", "surface"]);
  assert.deepEqual([talkPayload.surface, talkPayload.provider, talkPayload.model, talkPayload.reasoningEffort], ["talk", "deepseek", "deepseek-v4-flash", "low"]);

  const microphoneChat = await chatHandler.handleVoiceChatRequest(new Request("http://127.0.0.1/api/voice/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "spoken from Chat", sessionId: "microphone-chat", actionId: "microphone-chat-run", audio: true, surface: "chat" }),
  }), { start });
  assert.equal(microphoneChat.status, 200);
  const chatRun = runs.getAssistantRun("microphone-chat-run", "microphone-chat");
  const chatPayload = JSON.parse(fs.readFileSync(runs.requestFileForRun(chatRun.id), "utf8"));
  assert.deepEqual([chatRun.surface, chatRun.textOnly, chatRun.requestedProvider, chatRun.requestedModel, chatRun.modelOrigin], ["chat", false, "nvidia", "nvidia/nemotron-3.5-super-vl-120b-a12b", "main"]);
  assert.deepEqual([chatPayload.surface, chatPayload.provider, chatPayload.model], ["chat", "nvidia", "nvidia/nemotron-3.5-super-vl-120b-a12b"]);
  assert.equal(spawner.calls.length, 2);
  assert.ok(spawner.calls.every(call => call.args[0].endsWith("run-hermes-action.mjs")));
});

test("the conversation handler rejects an unverified surface before launch", async () => {
  let called = false;
  const response = await chatHandler.handleVoiceChatRequest(new Request("http://127.0.0.1/api/voice/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "hello", sessionId: "invalid-surface", surface: "sidebar" }),
  }), { start: async () => { called = true; } });
  assert.equal(response.status, 400);
  assert.equal(called, false);
});

test("an agent pin reaches the actual launch payload ahead of global surface settings", async () => {
  direct.saveDirectConfig({ executionMode: "hermes" });
  const agent = agents.createWorkAgent({ id: "model-agent", name: "Builder", provider: "nvidia", model: "agent/model-fast" });
  const spawner = fakeSpawner();
  process.env.HERMES_VOICE_TRANSPORT = "acp";
  const run = await launcher.startAssistantRun({ id: "model-agent-run", sessionId: agent.sessionId, text: "use my assigned model", surface: "talk", textOnly: true }, { spawnProcess: spawner.spawnProcess });
  process.env.HERMES_VOICE_TRANSPORT = "legacy";
  const payload = JSON.parse(fs.readFileSync(runs.requestFileForRun(run.id), "utf8"));
  assert.deepEqual([run.modelOrigin, run.requestedProvider, run.requestedModel], ["agent", "nvidia", "agent/model-fast"]);
  assert.deepEqual([payload.provider, payload.model, payload.surface], ["nvidia", "agent/model-fast", "talk"]);
});

test("an explicitly cleared surface effort survives storage and reaches the launch payload", async () => {
  direct.saveDirectConfig({ executionMode: "hermes" });
  voice.saveSurfaceModelPreference("talk", { mode: "pin", provider: "deepseek", model: "deepseek-v4-flash", reasoningEffort: "low" });
  voice.saveSurfaceModelPreference("talk", { mode: "pin", provider: "deepseek", model: "deepseek-v4-flash", reasoningEffort: "" });
  assert.equal(voice.getModelPreferences().talk.reasoningEffort, "");
  assert.equal(voice.getVoiceConfig().voiceReasoningEffort, "");

  const spawner = fakeSpawner();
  const start = input => launcher.startAssistantRun(input, { spawnProcess: spawner.spawnProcess });
  const response = await chatHandler.handleVoiceChatRequest(new Request("http://127.0.0.1/api/voice/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "use the model default", sessionId: "default-effort", actionId: "default-effort-run", surface: "talk", audio: false }),
  }), { start });
  assert.equal(response.status, 200);
  const run = runs.getAssistantRun("default-effort-run", "default-effort");
  const payload = JSON.parse(fs.readFileSync(runs.requestFileForRun(run.id), "utf8"));
  assert.equal(payload.reasoningEffort, "");
});

test("the resolution endpoint reads and updates a surface while Direct mode rejects ignored Hermes pin changes", async () => {
  direct.saveDirectConfig({ executionMode: "hermes" });
  voice.saveSurfaceModelPreference("talk", { mode: "pin", provider: "deepseek", model: "deepseek-v4-flash" });
  const read = await resolutionRoute.GET(new Request("http://127.0.0.1/api/models/resolution?surface=talk"));
  assert.equal(read.status, 200);
  const initial = await read.json();
  assert.deepEqual([initial.resolution.origin, initial.resolution.requestedModel, initial.preferences.talk.mode], ["surface", "deepseek-v4-flash", "pin"]);

  const followed = await resolutionRoute.PATCH(new Request("http://127.0.0.1/api/models/resolution", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ surface: "talk", mode: "follow-main" }),
  }));
  assert.equal(followed.status, 200);
  const updated = await followed.json();
  assert.deepEqual([updated.resolution.origin, updated.resolution.requestedModel, updated.preferences.talk.mode], ["main", "nvidia/nemotron-3.5-super-vl-120b-a12b", "follow-main"]);

  voice.saveSurfaceModelPreference("talk", { mode: "pin", provider: "deepseek", model: "deepseek-v4-flash" });
  direct.saveDirectConfig({ provider: "openai", model: "gpt-5-mini", executionMode: "direct" });
  const rejected = await resolutionRoute.PATCH(new Request("http://127.0.0.1/api/models/resolution", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ surface: "talk", mode: "follow-main" }),
  }));
  assert.equal(rejected.status, 409);
  assert.match((await rejected.json()).error, /Direct API connection/);
  assert.equal(voice.getModelPreferences().talk.mode, "pin");
});

test("a Main switch response exposes actionable conflicts and post-switch resolutions", () => {
  direct.saveDirectConfig({ executionMode: "hermes" });
  voice.saveSurfaceModelPreference("chat", { mode: "pin", provider: "deepseek", model: "deepseek-v4-flash" });
  voice.saveSurfaceModelPreference("talk", { mode: "follow-main" });
  fs.writeFileSync(path.join(process.env.HERMES_HOME, "config.yaml"), "model:\n  provider: nvidia\n  default: nvidia/nemotron-3.5-super-vl-120b-a12b\n");
  const response = switchResponse.modelSwitchResponse({ ok: true, option: { provider: "nvidia", model: "nvidia/nemotron-3.5-super-vl-120b-a12b" } }, "primary");
  assert.equal(response.conflicts.length, 1);
  assert.deepEqual([response.conflicts[0].surface, response.conflicts[0].pinnedFriendlyName, response.conflicts[0].mainFriendlyName], ["chat", "DeepSeek V4 Flash", "Nemotron 3.5 Super VL 120B A12B"]);
  assert.deepEqual([response.resolutions.chat.origin, response.resolutions.talk.origin], ["surface", "main"]);
});
