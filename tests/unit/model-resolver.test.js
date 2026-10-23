import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "panel-model-resolver-"));
const data = path.join(temporary, "data");
const home = path.join(temporary, "hermes");
process.env.PANEL_DATA_DIR = data;
process.env.HERMES_HOME = home;
process.env.OPENAI_API_KEY = "resolver-fixture-key";
fs.mkdirSync(home, { recursive: true });

const voice = await import("../../lib/voice.js");
const direct = await import("../../lib/direct-config.js");
const resolver = await import("../../lib/model-resolver.js");

function reset() {
  fs.rmSync(data, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.yaml"), 'model:\n  provider: "nvidia"\n  default: "nvidia/nemotron-3.5-super-vl-120b-a12b"\n');
}

test.beforeEach(reset);
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

test("new configuration follows Main without writing a config file", () => {
  const configFile = path.join(data, "voice-config.json");
  const preferences = voice.getModelPreferences();
  assert.equal(fs.existsSync(configFile), false);
  assert.equal(preferences.migration, null);
  assert.equal(preferences.chat.mode, "follow-main");
  assert.equal(preferences.talk.mode, "follow-main");
  const resolved = resolver.resolveModelFor({ surface: "chat" });
  assert.deepEqual([resolved.requestedProvider, resolved.requestedModel, resolved.origin], ["nvidia", "nvidia/nemotron-3.5-super-vl-120b-a12b", "main"]);
  assert.equal(resolved.friendlyName, "Nemotron 3.5 Super VL 120B A12B");
  assert.equal(resolved.originLabel, "Main model");
});

test("legacy shared pin migrates explicitly and clearing the compatibility fields still works", () => {
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, "voice-config.json"), JSON.stringify({ voiceModelProvider: "deepseek", voiceModel: "deepseek-v4-flash", voiceReasoningEffort: "low" }));
  const migrated = voice.getModelPreferences();
  assert.equal(migrated.migration, "legacy-shared-pin");
  assert.deepEqual([migrated.chat.mode, migrated.chat.model, migrated.talk.mode, migrated.talk.model], ["pin", "deepseek-v4-flash", "pin", "deepseek-v4-flash"]);
  assert.equal(resolver.resolveModelFor({ surface: "talk" }).friendlyName, "DeepSeek V4 Flash");
  voice.saveVoiceConfig({ autoSpeak: false });
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, "voice-config.json"), "utf8")).modelPreferences.migration, "legacy-shared-pin");
  voice.saveVoiceConfig({ voiceModelProvider: "", voiceModel: "" });
  assert.equal(voice.getModelPreferences().talk.mode, "follow-main");
  assert.equal(voice.getModelPreferences().chat.mode, "pin", "clearing the Talk compatibility projection must not reset Chat");
});

test("surface pins, agent pins, and Direct API mode have explicit precedence", () => {
  voice.saveSurfaceModelPreference("talk", { mode: "pin", provider: "deepseek", model: "deepseek-v4-flash", reasoningEffort: "low" });
  const talk = resolver.resolveModelFor({ surface: "talk" });
  assert.deepEqual([talk.origin, talk.originLabel, talk.requestedModel], ["surface", "Pinned for Talk", "deepseek-v4-flash"]);

  const agent = resolver.resolveModelFor({ surface: "chat", agent: { name: "Builder", provider: "openai", model: "gpt-5-mini" } });
  assert.deepEqual([agent.origin, agent.originLabel, agent.requestedProvider, agent.requestedModel], ["agent", "Builder's model", "openai", "gpt-5-mini"]);

  direct.saveDirectConfig({ provider: "openai", model: "gpt-5-mini", executionMode: "direct" });
  const directResolution = resolver.resolveModelFor({ surface: "talk" });
  assert.deepEqual([directResolution.origin, directResolution.executionMode, directResolution.requestedModel], ["direct", "direct", "gpt-5-mini"]);
  const directAgent = resolver.resolveModelFor({ surface: "talk", agent: { name: "Reviewer", provider: "openai", model: "gpt-5" } });
  assert.deepEqual([directAgent.origin, directAgent.requestedModel], ["agent", "gpt-5"]);
});

test("YAML mappings preserve quotes while scalar configs remain honest when provider is absent", () => {
  assert.deepEqual(resolver.readHermesMainModel(), { provider: "nvidia", model: "nvidia/nemotron-3.5-super-vl-120b-a12b", resolved: true });
  fs.writeFileSync(path.join(home, "config.yaml"), 'provider: "nvidia"\nmodel: "nvidia/nemotron-3.5-super-vl-120b-a12b"\n');
  assert.deepEqual(resolver.readHermesMainModel(), { provider: "nvidia", model: "nvidia/nemotron-3.5-super-vl-120b-a12b", resolved: true });
  fs.writeFileSync(path.join(home, "config.yaml"), 'model: "nvidia/nemotron-3.5-super-vl-120b-a12b"\n');
  const unresolved = resolver.resolveModelFor({ surface: "chat" });
  assert.equal(unresolved.requestedProvider, "");
  assert.equal(unresolved.requestedModel, "nvidia/nemotron-3.5-super-vl-120b-a12b");
  assert.equal(unresolved.resolved, false);
  fs.writeFileSync(path.join(home, "config.yaml"), 'model: ["unterminated"\n');
  assert.deepEqual(resolver.readHermesMainModel(), { provider: "", model: "", resolved: false });
});

test("main-switch conflicts include only differing explicit surface pins", () => {
  const preferences = {
    chat: { mode: "pin", provider: "deepseek", model: "deepseek-v4-flash" },
    talk: { mode: "follow-main", provider: "", model: "" },
  };
  assert.deepEqual(resolver.mainSwitchConflicts({ provider: "nvidia", model: "nvidia/nemotron-3.5-super-vl-120b-a12b" }, preferences), [{
    surface: "chat",
    name: "Chat",
    pinnedProvider: "deepseek",
    pinnedModel: "deepseek-v4-flash",
    pinnedFriendlyName: "DeepSeek V4 Flash",
    mainProvider: "nvidia",
    mainModel: "nvidia/nemotron-3.5-super-vl-120b-a12b",
    mainFriendlyName: "Nemotron 3.5 Super VL 120B A12B",
    message: "Chat is pinned to DeepSeek V4 Flash. Switch Chat to Nemotron 3.5 Super VL 120B A12B too?",
  }]);
});

test("surface inference honors an explicit UI surface before response modality", () => {
  assert.equal(resolver.inferModelSurface({ surface: "talk", textOnly: true }), "talk");
  assert.equal(resolver.inferModelSurface({ surface: "chat", textOnly: false }), "chat");
  assert.equal(resolver.inferModelSurface({ textOnly: false }), "talk");
  assert.equal(resolver.inferModelSurface({ source: "task", textOnly: false }), "chat");
});
