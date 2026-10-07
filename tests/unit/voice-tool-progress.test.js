import test from "node:test";
import assert from "node:assert/strict";
import { createNativeToolVoiceFeedbackSelector, isActiveToolProgress, selectNativeToolVoiceFeedback } from "../../components/voice/voiceFeedback.js";
import { playVoiceFeedbackAudio } from "../../components/voice/voiceFeedbackPlayback.js";

const active = () => ({ id: "run-a", state: "active", toolProgress: { callId: "call-a", kind: "execute", status: "in_progress", startedAt: new Date().toISOString() } });

test("only native in-progress execution earns a concrete tool cue", () => {
  assert.equal(selectNativeToolVoiceFeedback(active()), "The command is running.");
  for (const run of [
    { id: "run-a", state: "active", statusLabel: "Running a command…" },
    { ...active(), state: "queued" },
    { ...active(), state: "complete" },
    { ...active(), permission: { requestId: "permission-a" } },
    { ...active(), toolProgress: { ...active().toolProgress, status: "pending" } },
    { ...active(), toolProgress: { ...active().toolProgress, status: "completed" } },
    { ...active(), toolProgress: { ...active().toolProgress, kind: "tool" } },
  ]) assert.equal(selectNativeToolVoiceFeedback(run), null);
  assert.equal(selectNativeToolVoiceFeedback(active(), { textOnly: true }), null);
  assert.equal(selectNativeToolVoiceFeedback(active(), { hasAnswer: true }), null);
});

test("one run gets at most one tool cue despite polls, retries and multiple tools", () => {
  const select = createNativeToolVoiceFeedbackSelector();
  assert.equal(select({ ...active(), permission: { requestId: "permission-a" } }), null);
  assert.equal(select(active()), "The command is running.");
  assert.equal(select(active()), null);
  assert.equal(select({ ...active(), toolProgress: { ...active().toolProgress, callId: "second-tool", kind: "read" } }), null);
  assert.equal(select({ ...active(), id: "run-b" }), "The command is running.");
});

test("completion, cancellation and permission changes suppress delayed progress audio", async () => {
  for (const next of [{ ...active(), toolProgress: null }, { ...active(), state: "cancelled" }, { ...active(), permission: { requestId: "p" } }]) {
    let current = active();
    let playing = false;
    let resolvePlay;
    const audio = { play() { playing = true; return new Promise((resolve) => { resolvePlay = resolve; }); }, pause() { playing = false; } };
    const started = playVoiceFeedbackAudio(audio, () => isActiveToolProgress(current, "call-a"));
    current = next;
    resolvePlay();
    await assert.rejects(started, { name: "AbortError" });
    assert.equal(playing, false);
  }
});
