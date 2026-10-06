import { test } from "node:test";
import assert from "node:assert/strict";
import { getVoiceHealth } from "../../lib/voice-health.js";

const config = { ttsBackend: "elevenlabs", elevenlabsApiKeys: ["test-key"] };
test("ordinary status checks never call a speech provider and distinguish configuration from verification", async () => {
  const result = await getVoiceHealth({ config, apiKey: "test-key", fetchImpl: () => { throw new Error("Network must not be called"); } });
  assert.equal(result.status, "running");
  assert.equal(result.readiness, "configured");
  assert.equal(result.stt.configured, true);
  assert.equal(result.stt.verified, false);
  assert.equal(result.tts.verified, false);
});
test("missing keys report unavailable without making network requests", async () => {
  const result = await getVoiceHealth({ config: { ttsBackend: "elevenlabs" }, probe: true, fetchImpl: () => { throw new Error("Network must not be called"); } });
  assert.equal(result.status, "error");
  assert.equal(result.stt.configured, false);
  assert.equal(result.tts.configured, false);
});
test("an explicit diagnostic probes the actual recognition model and reports success honestly", async () => {
  let calls = 0;
  const result = await getVoiceHealth({ config, apiKey: "test-key", probe: true, fetchImpl: async (url) => {
    calls += 1;
    assert.match(url, /model=nova-3/);
    return { ok: true, status: 200 };
  } });
  assert.equal(calls, 1);
  assert.equal(result.stt.verified, true);
  assert.equal(result.tts.verified, false);
});
test("a failed diagnostic remains configured but cannot be reported as operational", async () => {
  const result = await getVoiceHealth({ config, apiKey: "test-key", probe: true, fetchImpl: async () => ({ ok: false, status: 401 }) });
  assert.equal(result.status, "error");
  assert.equal(result.stt.configured, true);
  assert.equal(result.readiness, "configured");
  assert.equal(result.stt.verified, false);
});
