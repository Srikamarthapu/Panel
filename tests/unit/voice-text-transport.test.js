import test from "node:test";
import assert from "node:assert/strict";
import { reducer, initialWrapper } from "../../components/voice/voiceMachine.js";
import { voiceChatRequest, isTextCompletion, completionRunId } from "../../components/voice/voiceTransport.js";

const thinking = { state: { ...initialWrapper.state, state: "thinking" }, effects: [] };

test("text transport opts out of audio in body and Accept header", () => {
  const textRequest = voiceChatRequest({ text: "Hello", sessionId: "s1", textOnly: true });
  assert.equal(textRequest.headers.Accept, "application/json");
  assert.deepEqual(JSON.parse(textRequest.body), { text: "Hello", sessionId: "s1", audio: false, stt_ms: 0 });
  const voiceRequest = voiceChatRequest({ text: "Hello", sessionId: "s1", sttMs: 125 });
  assert.match(voiceRequest.headers.Accept, /audio\/mpeg/);
  assert.equal(JSON.parse(voiceRequest.body).audio, true);
  assert.equal(JSON.parse(voiceRequest.body).stt_ms, 125);
});

test("typed input carries textOnly through the real callChat effect", () => {
  const result = reducer(initialWrapper, { type: "STT_OK", text: "Hello", textOnly: true });
  assert.equal(result.state.state, "thinking");
  assert.deepEqual(result.effects, [{ kind: "callChat", text: "Hello", textOnly: true, preserveContinuous: false }]);
  const voice = reducer(initialWrapper, { type: "STT_OK", text: "Hello" });
  assert.deepEqual(voice.effects, [{ kind: "callChat", text: "Hello" }]);
});

test("text reply retains formatting beyond 8000 characters and never produces audio", () => {
  const response = "A formatted answer\n\n" + "a".repeat(8500);
  const result = reducer(thinking, { type: "CHAT_OK", response, audioUrl: "blob:unexpected", textOnly: true });
  assert.equal(result.state.state, "idle");
  assert.equal(result.state.transcript[0].text, response);
  assert.equal(result.state.transcript[0].audioUrl, undefined);
  assert.deepEqual(result.effects, []);
});

test("switching from continuous listening to text releases the microphone before chat", () => {
  const listening = { state: { ...initialWrapper.state, state: "listening", continuousRequested: true }, effects: [] };
  const result = reducer(listening, { type: "STT_OK", text: "Hello", textOnly: true });
  assert.equal(result.state.continuousRequested, false);
  const kinds = result.effects.map((effect) => effect.kind);
  assert.ok(kinds.indexOf("stopAllTracks") < kinds.indexOf("callChat"));
  assert.ok(kinds.includes("clearVadInterval"));
  assert.ok(kinds.includes("closeAudioContext"));
});

test("typed input can explicitly preserve the active continuous session", () => {
  const listening = { state: { ...initialWrapper.state, state: "listening", continuousRequested: true }, effects: [] };
  const result = reducer(listening, { type: "STT_OK", text: "Hello", textOnly: true, preserveContinuous: true });
  assert.equal(result.state.continuousRequested, true);
  assert.deepEqual(result.effects, [{ kind: "callChat", text: "Hello", textOnly: true, preserveContinuous: true }]);
});

test("text completions append full results silently even during a later voice interaction", () => {
  for (const state of ["idle", "listening", "capturing", "transcribing", "thinking", "speaking"]) {
    const before = { state: { ...initialWrapper.state, state, config: { autoSpeak: false, muteOutput: true } }, effects: [] };
    const text = "Full result\n\n" + "b".repeat(7000);
    const result = reducer(before, { type: "SPEAK_COMPLETION", text, entryId: "text-result", textOnly: true });
    assert.equal(result.state.state, state);
    assert.equal(result.state.transcript[0].text, text);
    assert.deepEqual(result.effects, []);
  }
});

test("text actions never emit a spoken still-working nudge", () => {
  const result = reducer(initialWrapper, { type: "SPEAK_STILL_WORKING", textOnly: true });
  assert.equal(result.state, initialWrapper.state);
  assert.deepEqual(result.effects, []);
});

test("persisted text completion provenance remains silent after a page reload", () => {
  assert.equal(isTextCompletion({ id: "a:complete", textOnly: true }, new Set()), true);
  assert.equal(isTextCompletion({ id: "b:failed" }, new Set(["b"])), true);
  assert.equal(isTextCompletion({ id: "voice:complete" }, new Set(["b"])), false);
  assert.equal(completionRunId({ id: "a:complete" }), "a");
});

test("voice replies keep the full transcript and spoken response beyond 500 characters", () => {
  const result = reducer(thinking, { type: "CHAT_OK", response: "v".repeat(900) });
  assert.equal(result.state.state, "thinking");
  assert.equal(result.state.transcript[0].text.length, 900);
  assert.deepEqual(result.effects, [{ kind: "callTTS", text: "v".repeat(900) }]);
});
