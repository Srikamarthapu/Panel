import test from "node:test";
import assert from "node:assert/strict";
import { reducer, initialWrapper } from "../../components/voice/voiceMachine.js";
import { queuedVoiceReducer } from "../../components/voice/voiceEffects.js";
import { voiceChatRequest } from "../../components/voice/voiceTransport.js";
import { MAX_USER_TEXT, MAX_ASSISTANT_TEXT, MAX_SPOKEN_TEXT, spokenExcerpt } from "../../lib/conversation-limits.js";

test("recorder → STT effects survive batched configuration/hydration updates exactly once", () => {
  let state = { state: { ...initialWrapper.state, state: "capturing" }, effects: [] };
  state = queuedVoiceReducer(state, { type: "STOP_PTT" });
  const effects = state.effects;
  state = queuedVoiceReducer(state, { type: "UPDATE_CONFIG", partial: { autoSpeak: false } });
  state = queuedVoiceReducer(state, { type: "HYDRATE_TRANSCRIPT", entries: [] });
  assert.deepEqual(state.effects, effects);
  assert.deepEqual(effects.map((item) => item.kind), ["stopRecorder", "releaseMicForPlayback", "callSTT"]);
  state = queuedVoiceReducer(state, { type: "ACK_EFFECTS", through: effects.at(-1).effectId });
  assert.deepEqual(state.effects, []);
});

test("cancellation removes queued work and aborts requests before recorder teardown", () => {
  let state = queuedVoiceReducer(initialWrapper, { type: "STT_OK", text: "Do this", textOnly: true });
  state = queuedVoiceReducer(state, { type: "CANCEL_CURRENT" });
  assert.equal(state.state.state, "idle");
  assert.equal(state.effects[0].kind, "cancelRequests");
  assert.ok(!state.effects.some((item) => item.kind === "callChat"));
});

test("long user text survives in transcript and outbound request; long replies retain their full text", () => {
  const text = "a".repeat(MAX_USER_TEXT);
  let state = reducer(initialWrapper, { type: "STT_OK", text, textOnly: true });
  assert.equal(state.state.transcript[0].text.length, MAX_USER_TEXT);
  assert.equal(state.effects[0].text.length, MAX_USER_TEXT);
  state = reducer(state, { type: "CHAT_OK", textOnly: true, response: "b".repeat(MAX_ASSISTANT_TEXT + 20) });
  assert.equal(state.state.transcript.at(-1).text.length, MAX_ASSISTANT_TEXT);
});

test("speech excerpt tells user where to read the full response and fits its own limit", () => {
  const text = "This is a complete thought. ".repeat(500);
  assert.ok(spokenExcerpt(text).length <= MAX_SPOKEN_TEXT);
  assert.match(spokenExcerpt(text), /full answer is available in Chat\.$/);
  const state = reducer(initialWrapper, { type: "SPEAK_COMPLETION", text, entryId: "answer" });
  assert.equal(state.state.transcript[0].text, text);
});

test("a late transcript correction cannot replace a different answer", () => {
  const state = reducer(initialWrapper, { type: "CHAT_OK", textOnly: true, id: "new", response: "New answer" });
  const result = reducer(state, { type: "CORRECT_TRANSCRIPT", entryId: "old", text: "Old answer" });
  assert.equal(result.state.transcript[0].text, "New answer");
});

test("hydration happens once and does not overwrite newly captured conversation", () => {
  let state = reducer(initialWrapper, { type: "HYDRATE_TRANSCRIPT", entries: [{ id: "old", role: "user", text: "Earlier" }] });
  state = reducer(state, { type: "STT_OK", text: "Current", textOnly: true });
  state = reducer(state, { type: "HYDRATE_TRANSCRIPT", entries: [{ id: "stale", role: "user", text: "Wrong" }] });
  assert.deepEqual(state.state.transcript.map((entry) => entry.text), ["Earlier", "Current"]);
});

test("pending tool run exits thinking and keeps a full silent result", () => {
  let state = reducer(initialWrapper, { type: "CHAT_PENDING", textOnly: true, actionId: "run" });
  state = reducer(state, { type: "SPEAK_COMPLETION", textOnly: true, text: "Done", entryId: "completion-run:complete" });
  assert.equal(state.state.state, "idle");
  assert.equal(state.state.requestPending, false);
  assert.deepEqual(state.effects, []);
});

test("push-to-talk permission resolves into recording; releasing before permission prevents capture", () => {
  let state = reducer(initialWrapper, { type: "START_PTT" });
  const granted = reducer(state, { type: "SET_PERMISSION", value: "granted" });
  assert.equal(granted.state.state, "starting");
  assert.equal(granted.effects[0].kind, "startRecorder");
  state = reducer(state, { type: "STOP_PTT" });
  const released = reducer(state, { type: "SET_PERMISSION", value: "granted" });
  assert.equal(released.state.state, "idle");
  assert.deepEqual(released.effects, []);
});

test("chat transport keeps cancellation signal and client idempotency key", () => {
  const signal = new AbortController().signal;
  const request = voiceChatRequest({ text: "Hi", sessionId: "s", actionId: "run", signal });
  assert.equal(request.signal, signal);
  assert.equal(JSON.parse(request.body).actionId, "run");
});

test("failed durable runs expose an error and leave thinking without speaking an invented reply", () => {
  let state = reducer(initialWrapper, { type: "CHAT_PENDING", actionId: "run" });
  state = reducer(state, { type: "SPEAK_COMPLETION", actionId: "run", text: "The provider could not connect.", isError: true });
  assert.equal(state.state.state, "idle");
  assert.equal(state.state.requestPending, false);
  assert.equal(state.state.lastError.code, "RUN_FAILED");
  assert.deepEqual(state.state.transcript, []);
  assert.deepEqual(state.effects, []);
});

test("an earlier text completion cannot terminate the current request", () => {
  let state = reducer(initialWrapper, { type: "CHAT_PENDING", actionId: "new" });
  state = reducer(state, { type: "SPEAK_COMPLETION", actionId: "old", textOnly: true, text: "Earlier result" });
  assert.equal(state.state.state, "thinking");
  assert.equal(state.state.requestPending, true);
  assert.equal(state.state.actionId, "new");
});

test("a second continuous press while permission is pending stops startup", () => {
  let state = reducer(initialWrapper, { type: "TOGGLE_CONTINUOUS" });
  assert.equal(state.state.permission, "pending");
  assert.equal(state.state.continuousRequested, true);
  state = reducer(state, { type: "TOGGLE_CONTINUOUS" });
  assert.equal(state.state.state, "idle");
  assert.equal(state.state.continuousRequested, false);
  assert.equal(state.effects[0].kind, "cancelRequests");
});

test("pending continuous cancellation drops the stale permission effect", () => {
  let state = queuedVoiceReducer(initialWrapper, { type: "TOGGLE_CONTINUOUS" });
  assert.deepEqual(state.effects.map((effect) => effect.kind), ["requestPermission"]);
  state = queuedVoiceReducer(state, { type: "TOGGLE_CONTINUOUS" });
  assert.equal(state.effects[0].kind, "cancelRequests");
  assert.ok(!state.effects.some((effect) => effect.kind === "requestPermission"));
});
