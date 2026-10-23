import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { maskKey, snapshotKeyHealth } from "../../lib/elevenlabs.js";

test("short key diagnostics never return the credential", () => {
  for (const secret of ["a", "tiny-key", "twelve-chars"]) {
    const masked = maskKey(secret);
    assert.notEqual(masked, secret);
    const health = snapshotKeyHealth({ elevenlabsApiKeys: [secret] });
    assert.equal(health[0].key, masked);
    assert.notEqual(health[0].key, secret);
    if (secret.length > 4) assert.equal(JSON.stringify(health).includes(secret), false);
  }
});

test("environment key remains a runtime fallback and unrelated saves do not persist it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "panel-voice-config-"));
  const priorData = process.env.PANEL_DATA_DIR;
  const priorKey = process.env.ELEVENLABS_API_KEY;
  try {
    process.env.PANEL_DATA_DIR = root;
    process.env.ELEVENLABS_API_KEY = "environment-secret-fixture";
    const voice = await import(`../../lib/voice.js?config-secrets=${Date.now()}`);
    assert.deepEqual(voice.getVoiceConfig().elevenlabsApiKeys, ["environment-secret-fixture"]);

    voice.saveVoiceConfig({ autoSpeak: false });
    const configPath = path.join(root, "voice-config.json");
    let saved = fs.readFileSync(configPath, "utf8");
    assert.equal(saved.includes("environment-secret-fixture"), false);
    assert.deepEqual(JSON.parse(saved).elevenlabsApiKeys, []);
    assert.deepEqual(voice.getVoiceConfig().elevenlabsApiKeys, ["environment-secret-fixture"]);

    voice.saveVoiceConfig({ elevenlabsApiKeys: ["explicit-secret-fixture"] });
    saved = fs.readFileSync(configPath, "utf8");
    assert.equal(saved.includes("explicit-secret-fixture"), true);
    voice.saveVoiceConfig({ autoSpeak: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")).elevenlabsApiKeys, ["explicit-secret-fixture"]);
  } finally {
    if (priorData === undefined) delete process.env.PANEL_DATA_DIR; else process.env.PANEL_DATA_DIR = priorData;
    if (priorKey === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = priorKey;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
