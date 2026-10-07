import test from "node:test";
import assert from "node:assert/strict";
import { createAnswerAudioTiming, createAnswerSpeechBuffer, readAnswerEvents } from "../../components/voice/voiceAnswerStream.js";
import { initialWrapper, reducer } from "../../components/voice/voiceMachine.js";
import { queuedVoiceReducer } from "../../components/voice/voiceEffects.js";

function pending(textOnly = false) {
  return reducer(initialWrapper, { type: "CHAT_PENDING", actionId: "run-a", textOnly });
}
function step(view, event) { return reducer(view, event); }

test("later audio sentences cannot overwrite a run's first-answer latency", () => {
  const observe = createAnswerAudioTiming();
  const events = [
    observe({ runId: "first", at: 13460, ttsStartedAt: 12900, speechEndedAt: 10000 }),
    observe({ runId: "first", at: 16386, ttsStartedAt: 16000, speechEndedAt: 10000 }),
    observe({ runId: "second", at: 22600, ttsStartedAt: 22000, speechEndedAt: 20000 }),
  ];
  const firstRunLatency = events.filter((event) => event.target === "first" && event.title === "Answer audio started");
  assert.equal(firstRunLatency.length, 1);
  assert.match(firstRunLatency[0].summary, /detected speech end to answer audio: 3460ms/);
  assert.equal(events[1].title, "Answer audio continued");
  assert.doesNotMatch(events[1].summary, /speech end to answer audio/);
  assert.equal(events[2].title, "Answer audio started");
  assert.match(events[2].summary, /detected speech end to answer audio: 2600ms/);
});

test("first complete sentence is speakable before the final answer exists", () => {
  const buffer = createAnswerSpeechBuffer();
  assert.deepEqual(buffer.accept({ seq: 1, text: "The result is", messageId: "one" }).chunks, []);
  assert.deepEqual(buffer.accept({ seq: 2, text: " ready. Here is", messageId: "one" }).chunks, ["The result is ready."]);
  assert.deepEqual(buffer.finish("The result is ready. Here is the detail."), ["Here is the detail."]);
  assert.deepEqual(buffer.finish("The result is ready. Here is the detail."), []);
});

test("replayed sequence numbers do not duplicate spoken content", () => {
  const buffer = createAnswerSpeechBuffer();
  assert.deepEqual(buffer.accept({ seq: 3, text: "Ready.", messageId: "one" }).chunks, ["Ready."]);
  assert.equal(buffer.accept({ seq: 3, text: "Ready.", messageId: "one" }), null);
  assert.equal(buffer.accept({ seq: 2, text: "Earlier.", messageId: "one" }), null);
  assert.equal(buffer.sequence, 3);
  assert.deepEqual(buffer.finish("Ready."), []);
});

test("action commentary and final message keep separate speech offsets", () => {
  const buffer = createAnswerSpeechBuffer();
  assert.deepEqual(buffer.accept({ seq: 1, text: "Checking the folder.", messageId: "before-tool" }).chunks, ["Checking the folder."]);
  assert.deepEqual(buffer.accept({ seq: 2, text: "Found three files", messageId: "after-tool" }).chunks, []);
  assert.deepEqual(buffer.finish("Found three files."), ["Found three files."]);
});

test("canonical whitespace and Markdown differences do not replay an already spoken prefix", () => {
  const buffer = createAnswerSpeechBuffer();
  assert.deepEqual(buffer.accept({ seq: 1, text: "The **result** is ready. More", messageId: "one" }).chunks, ["The **result** is ready."]);
  assert.deepEqual(buffer.finish("The result\nis ready. More details follow."), ["More details follow."]);
});

test("canonical response containing pre-tool and final blocks does not replay either", () => {
  const buffer = createAnswerSpeechBuffer();
  buffer.accept({ seq: 1, text: "Checking the folder.", messageId: "one" });
  buffer.accept({ seq: 2, text: "Found three files.", messageId: "two" });
  assert.deepEqual(buffer.finish("Checking the folder.\n\nFound three files."), []);
});

test("missing ACP message IDs cannot replay an already spoken final tool result", () => {
  const buffer = createAnswerSpeechBuffer();
  buffer.accept({ seq: 1, text: "I will print it.", messageId: "assistant" });
  buffer.accept({ seq: 2, text: "ORCHID.", messageId: "assistant" });
  assert.deepEqual(buffer.finish("ORCHID."), []);
});

test("split reasoning, DSML and serialized tool output never reach speech", () => {
  for (const input of [
    "<think>Secret reasoning.</think>The answer is four.",
    '<｜DSML｜function_calls><｜DSML｜invoke name="terminal">Secret tool.</｜DSML｜invoke></｜DSML｜function_calls>The answer is four.',
    '<tool_result>Secret tool.</tool_result>The answer is four.',
    '<|im_start|>assistant<|channel|>analysis<|message|>Secret reasoning.<|im_end|><|im_start|>assistant<|channel|>final<|message|>The answer is four.<|im_end|>',
  ]) {
    const buffer = createAnswerSpeechBuffer();
    const heard = [];
    [...input].forEach((text, index) => heard.push(...(buffer.accept({ seq: index + 1, messageId: "one", text })?.chunks || [])));
    heard.push(...buffer.finish("The answer is four."));
    assert.deepEqual(heard, ["The answer is four."]);
  }
});

test("incomplete fenced code is withheld until the authored block is complete", () => {
  const buffer = createAnswerSpeechBuffer();
  assert.deepEqual(buffer.accept({ seq: 1, text: '```json\n{"role":"tool", "content":"secret"}', messageId: "one" }).chunks, []);
  assert.equal(buffer.text, "");
});

test("partial final transcript is replaced and already queued speech is not restarted", () => {
  let view = pending();
  view = step(view, { type: "STREAM_TEXT", actionId: "run-a", text: "First sentence. " });
  view = step(view, { type: "STREAM_SPEECH_CHUNKS", actionId: "run-a", chunks: ["First sentence.", "Second sentence."] });
  assert.equal(view.effects[0].text, "First sentence.");
  assert.equal(view.state.requestPending, true);
  view = step(view, { type: "TTS_DONE", url: "blob:first" });
  view = step(view, { type: "SPEAK_COMPLETION", actionId: "run-a", entryId: "completion-a", text: "First sentence. Second sentence.", streamHandled: true });
  assert.equal(view.state.state, "speaking");
  assert.equal(view.state.requestPending, false);
  assert.equal(view.state.transcript.length, 1);
  assert.equal(view.state.transcript[0].pending, undefined);
  assert.equal(view.effects.length, 0);
  view = step(view, { type: "TTS_PLAYBACK_ENDED", url: "blob:first" });
  assert.equal(view.effects.find((effect) => effect.kind === "callTTS")?.text, "Second sentence.");
  view = step(view, { type: "TTS_PLAYBACK_ENDED", url: "blob:second" });
  assert.equal(view.state.state, "idle");
});

test("speech finishing while an action runs keeps listening paused until completion", () => {
  let view = pending();
  view = step(view, { type: "STREAM_SPEECH_CHUNKS", actionId: "run-a", chunks: ["Checking the file."] });
  view = step(view, { type: "TTS_DONE", url: "blob:first" });
  view = step(view, { type: "TTS_PLAYBACK_ENDED", url: "blob:first" });
  assert.equal(view.state.state, "thinking");
  assert.equal(view.state.requestPending, true);
});

test("Stop discards queued speech and rejects late stream events", () => {
  let view = pending();
  view = step(view, { type: "STREAM_SPEECH_CHUNKS", actionId: "run-a", chunks: ["One.", "Two."] });
  view = step(view, { type: "CANCEL_CURRENT" });
  assert.deepEqual(view.state.streamSpeechQueue, []);
  assert.ok(view.effects.some((effect) => effect.kind === "cancelRequests"));
  assert.ok(view.effects.some((effect) => effect.kind === "stopAudio"));
  view = step(view, { type: "STREAM_SPEECH_CHUNKS", actionId: "run-a", chunks: ["Late."] });
  assert.deepEqual(view.effects, []);
  assert.equal(view.state.state, "idle");
  view = step(view, { type: "CHAT_PENDING", actionId: "run-b" });
  view = step(view, { type: "STREAM_TEXT", actionId: "run-a", text: "Stale answer" });
  assert.equal(view.state.transcript.length, 0);
});

test("imperative cancellation removes a not-yet-acknowledged TTS effect", () => {
  let view = queuedVoiceReducer(initialWrapper, { type: "CHAT_PENDING", actionId: "run-a" });
  view = queuedVoiceReducer(view, { type: "STREAM_SPEECH_CHUNKS", actionId: "run-a", chunks: ["Old audio."] });
  assert.equal(view.effects[0].kind, "callTTS");
  view = queuedVoiceReducer(view, { type: "STREAM_RESET" });
  assert.deepEqual(view.effects, []);
});

test("continuous teardown followed immediately by PTT cannot cancel the new recorder twice", () => {
  let view = { ...initialWrapper, state: { ...initialWrapper.state, state: "listening", permission: "granted", continuousRequested: true } };
  // The public toggle invalidates requests synchronously, before a new
  // capture gesture can occur. Its queued resource teardown must not repeat
  // that invalidation after the next START_PTT was already enqueued.
  view = queuedVoiceReducer(view, { type: "STREAM_RESET" });
  view = queuedVoiceReducer(view, { type: "TOGGLE_CONTINUOUS", requestsCancelled: true });
  view = queuedVoiceReducer(view, { type: "START_PTT" });
  assert.equal(view.state.state, "starting");
  assert.equal(view.effects.filter((effect) => effect.kind === "cancelRequests").length, 0);
  assert.equal(view.effects.at(-1).kind, "startRecorder");
  assert.ok(view.effects.findIndex((effect) => effect.kind === "stopAllTracks") < view.effects.findIndex((effect) => effect.kind === "startRecorder"));
});

test("muted, text-only and silently restored runs never enqueue speech", () => {
  for (const settings of [{ textOnly: true }, { config: { muteOutput: true } }, { config: { autoSpeak: false } }]) {
    let view = pending(settings.textOnly);
    if (settings.config) view = step(view, { type: "UPDATE_CONFIG", partial: settings.config });
    view = step(view, { type: "STREAM_TEXT", actionId: "run-a", text: "Visible answer." });
    view = step(view, { type: "STREAM_SPEECH_CHUNKS", actionId: "run-a", textOnly: settings.textOnly, chunks: ["Visible answer."] });
    assert.deepEqual(view.effects, []);
    assert.equal(view.state.transcript[0].text, "Visible answer.");
  }
});

test("a failed TTS segment stops further queued speech without stopping the action", () => {
  let view = pending();
  view = step(view, { type: "STREAM_SPEECH_CHUNKS", actionId: "run-a", chunks: ["One.", "Two."] });
  view = step(view, { type: "TTS_FAILED", reason: "network_error" });
  assert.equal(view.state.requestPending, true);
  assert.deepEqual(view.state.streamSpeechQueue, []);
  view = step(view, { type: "STREAM_SPEECH_CHUNKS", actionId: "run-a", chunks: ["Three."] });
  assert.deepEqual(view.effects, []);
});

test("SSE parser preserves split UTF-8 and CRLF, ignores unknown event types", async () => {
  const data = new TextEncoder().encode('event: text\r\ndata: {"seq":1,"text":"Café."}\r\n\r\nevent: reasoning\ndata: {"text":"hidden"}\n\nevent: run\ndata: {"state":"complete"}\n\n');
  const response = new Response(new ReadableStream({ start(controller) { for (const byte of data) controller.enqueue(new Uint8Array([byte])); controller.close(); } }), { headers: { "Content-Type": "text/event-stream" } });
  const events = [];
  await readAnswerEvents(response, (type, value) => events.push([type, value]));
  assert.deepEqual(events, [["text", { seq: 1, text: "Café." }], ["run", { state: "complete" }]]);
});

test("aborting an event stream cancels its reader and drops later buffered events", async () => {
  let cancelled = false;
  const controller = new AbortController();
  const response = new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('event: text\ndata: {"seq":1,"text":"First."}\n\nevent: text\ndata: {"seq":2,"text":"Late."}\n\n')); }, cancel() { cancelled = true; } }), { headers: { "Content-Type": "text/event-stream" } });
  const seen = [];
  await readAnswerEvents(response, (_type, event) => { seen.push(event.seq); controller.abort(); }, controller.signal);
  assert.deepEqual(seen, [1]);
  assert.equal(cancelled, true);
});
