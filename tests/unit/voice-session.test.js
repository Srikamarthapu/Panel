import test from "node:test";
import assert from "node:assert/strict";
import { resolveVoiceSessionId, voicePendingRunsKey } from "../../components/voice/voiceSession.js";

test("pending requests cannot be restored into a different managed session", () => {
  const storage = new Map([[voicePendingRunsKey("work-a"), [{ id: "run-a" }]]]);
  assert.equal(storage.get(voicePendingRunsKey("work-b")), undefined);
  assert.equal(storage.get(voicePendingRunsKey()), undefined);
  assert.equal(voicePendingRunsKey(), "hermes.voice.pendingRuns");
});

test("new browser profiles get and persist distinct conversation session IDs", () => {
  const firstValues = new Map();
  const secondValues = new Map();
  const first = resolveVoiceSessionId({
    getItem: (key) => firstValues.get(key) || null,
    setItem: (key, value) => firstValues.set(key, value),
  }, () => "profile-one");
  const second = resolveVoiceSessionId({
    getItem: (key) => secondValues.get(key) || null,
    setItem: (key, value) => secondValues.set(key, value),
  }, () => "profile-two");

  assert.equal(first, "profile-one");
  assert.equal(second, "profile-two");
  assert.notEqual(first, second);
  assert.equal(resolveVoiceSessionId({
    getItem: (key) => firstValues.get(key) || null,
    setItem: (key, value) => firstValues.set(key, value),
  }, () => assert.fail("existing profile should keep its ID")), "profile-one");
});

test("existing legacy session IDs remain intact and unavailable storage still gets a mount ID", () => {
  assert.equal(resolveVoiceSessionId({ getItem: () => "voice-primary" }, () => "new-id"), "voice-primary");
  assert.equal(resolveVoiceSessionId({
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
  }, () => "ephemeral-id"), "ephemeral-id");
});
