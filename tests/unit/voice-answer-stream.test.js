import test from "node:test";
import assert from "node:assert/strict";
import { createAnswerAudioTiming, createAnswerReconnectBackoff, createAnswerSpeechBuffer, readAnswerEvents } from "../../components/voice/voiceAnswerStream.js";
import { initialWrapper, reducer } from "../../components/voice/voiceMachine.js";
import { queuedVoiceReducer } from "../../components/voice/voiceEffects.js";
import { MAX_SPOKEN_TEXT } from "../../lib/conversation-limits.js";

function pending(textOnly = false) {
  return reducer(initialWrapper, { type: "CHAT_PENDING", actionId: "run-a", textOnly });
}
function step(view, event) { return reducer(view, event); }

test("empty answer-stream EOFs back off until meaningful progress arrives", () => {
  const backoff = createAnswerReconnectBackoff();
  assert.equal(backoff.next(), 500);
  assert.equal(backoff.next(), 1000);
  assert.equal(backoff.next(), 2000);
  assert.equal(backoff.next({ meaningful: true }), 500);
  assert.equal(backoff.next(), 1000);
});

test("streamed speech held by a live utterance remains available after input ownership ends", () => {
  const buffer = createAnswerSpeechBuffer();
  const sentence = "The earlier task has completed, and its full result is ready for review.";
  const held = buffer.accept({ seq: 1, messageId: "answer", text: sentence }, { holdSpeech: true });
  assert.equal(held.text, sentence);
  assert.deepEqual(held.chunks, []);
  assert.deepEqual(buffer.finish(sentence), [sentence]);
});

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

test("short adjacent sentences are coalesced before speech begins", () => {
  const buffer = createAnswerSpeechBuffer();
  assert.deepEqual(buffer.accept({ seq: 1, text: "Yes. The system has completed", messageId: "one" }).chunks, []);
  assert.deepEqual(buffer.accept({ seq: 2, text: " the requested check, and every result is ready for review in the conversation now.", messageId: "one" }).chunks, ["Yes. The system has completed the requested check, and every result is ready for review in the conversation now."]);
  assert.deepEqual(buffer.finish("Yes. The system has completed the requested check, and every result is ready for review in the conversation now."), []);
});

test("a natural first progress sentence speaks while its run remains active", () => {
  const buffer = createAnswerSpeechBuffer();
  const progress = "This is a sentence spoken while the run is active.";
  assert.deepEqual(buffer.accept({ seq: 1, text: progress, messageId: "one" }).chunks, [progress]);
  assert.deepEqual(buffer.finish(progress), []);
});

test("replayed sequence numbers do not duplicate spoken content", () => {
  const buffer = createAnswerSpeechBuffer();
  assert.deepEqual(buffer.accept({ seq: 3, text: "Ready.", messageId: "one" }).chunks, []);
  assert.equal(buffer.accept({ seq: 3, text: "Ready.", messageId: "one" }), null);
  assert.equal(buffer.accept({ seq: 2, text: "Earlier.", messageId: "one" }), null);
  assert.equal(buffer.sequence, 3);
  assert.deepEqual(buffer.finish("Ready."), ["Ready."]);
});

test("action commentary and final message keep separate speech offsets", () => {
  const buffer = createAnswerSpeechBuffer();
  assert.deepEqual(buffer.accept({ seq: 1, text: "Checking the folder.", messageId: "before-tool" }).chunks, []);
  assert.deepEqual(buffer.accept({ seq: 2, text: "Found three files", messageId: "after-tool" }).chunks, ["Checking the folder."]);
  assert.deepEqual(buffer.finish("Found three files."), ["Found three files."]);
});

test("canonical whitespace and Markdown differences do not replay an already spoken prefix", () => {
  const buffer = createAnswerSpeechBuffer();
  const streamed = "The **result** is ready, with every requested check completed and the supporting evidence available for review now. More";
  assert.deepEqual(buffer.accept({ seq: 1, text: streamed, messageId: "one" }).chunks, [streamed.slice(0, -5).trim()]);
  assert.deepEqual(buffer.finish("The result is ready, with every requested check completed and the supporting evidence available for review now. More details follow."), ["More details follow."]);
});

test("a prepended canonical summary continues after the complete phrase already spoken", () => {
  const buffer = createAnswerSpeechBuffer();
  const streamed = "I checked all application logs and verified the build passed without errors.";
  assert.deepEqual(buffer.accept({ seq: 1, text: streamed, messageId: "one" }).chunks, [streamed]);
  assert.deepEqual(
    buffer.finish(`Summary: ${streamed} Three non-blocking warnings remain for review.`),
    ["Three non-blocking warnings remain for review."],
  );
});

test("a non-overlapping canonical rewrite is spoken in full rather than fuzzy-skipped", () => {
  const buffer = createAnswerSpeechBuffer();
  const streamed = "The cat status report is complete and the original build passed every required check.";
  assert.deepEqual(buffer.accept({ seq: 1, text: streamed, messageId: "one" }).chunks, [streamed]);
  const replacement = "The concatenate operation produced a different result that has not been spoken before.";
  assert.deepEqual(buffer.finish(replacement), [replacement]);
});

test("canonical response containing pre-tool and final blocks does not replay either", () => {
  const buffer = createAnswerSpeechBuffer();
  const heard = [];
  heard.push(...buffer.accept({ seq: 1, text: "Checking the folder.", messageId: "one" }).chunks);
  heard.push(...buffer.accept({ seq: 2, text: "Found three files.", messageId: "two" }).chunks);
  heard.push(...buffer.finish("Checking the folder.\n\nFound three files."));
  assert.deepEqual(heard, ["Checking the folder.", "Found three files."]);
});

test("missing ACP message IDs cannot replay an already spoken final tool result", () => {
  const buffer = createAnswerSpeechBuffer();
  buffer.accept({ seq: 1, text: "I will print it.", messageId: "assistant" });
  buffer.accept({ seq: 2, text: "ORCHID.", messageId: "assistant" });
  assert.deepEqual(buffer.finish("ORCHID."), ["ORCHID."]);
});

test("abbreviations and decimals do not create tiny speech clips", () => {
  const buffer = createAnswerSpeechBuffer();
  const response = "Dr. Rivera measured version 2.5. It remained stable.";
  assert.deepEqual(buffer.accept({ seq: 1, text: response, messageId: "one" }).chunks, [response]);
  assert.deepEqual(buffer.finish(response), []);
});

test("a terminal-only long answer keeps bounded natural chunks and a spoken prefix", () => {
  const buffer = createAnswerSpeechBuffer();
  const sentence = "This synthetic sentence is long enough to exercise the final speech partition without exposing any private content.";
  const final = Array.from({ length: 80 }, () => sentence).join(" ");
  const chunks = buffer.finish(final);
  const notice = "The full answer is available in Chat.";
  assert.equal(chunks.at(-1), notice);
  assert.ok(chunks.length > 10);
  assert.ok(chunks.slice(0, -1).every((chunk) => chunk.length < 400));
  const spoken = chunks.slice(0, -1).join(" ");
  assert.ok(spoken.length > MAX_SPOKEN_TEXT * 0.8);
  assert.ok(spoken.length <= MAX_SPOKEN_TEXT);
  assert.ok(final.startsWith(spoken));
});

test("one oversized terminal sentence retains a bounded spoken prefix", () => {
  const buffer = createAnswerSpeechBuffer();
  const final = `${Array.from({ length: 1500 }, (_, index) => `word${index}`).join(" ")}.`;
  const chunks = buffer.finish(final);
  assert.equal(chunks.at(-1), "The full answer is available in Chat.");
  assert.ok(chunks.length > 10);
  assert.ok(chunks.slice(0, -1).every((chunk) => chunk.length <= 280));
  const spoken = chunks.slice(0, -1).join(" ");
  assert.ok(spoken.length > MAX_SPOKEN_TEXT * 0.8);
  assert.ok(spoken.length <= MAX_SPOKEN_TEXT);
  assert.ok(final.startsWith(spoken));
});

test("an over-cap terminal token without whitespace is still spoken in bounded chunks", () => {
  const buffer = createAnswerSpeechBuffer();
  const final = `${"a".repeat(MAX_SPOKEN_TEXT + 1200)}.`;
  const chunks = buffer.finish(final);
  assert.equal(chunks.at(-1), "The full answer is available in Chat.");
  assert.ok(chunks.length > 10);
  assert.ok(chunks.slice(0, -1).every((chunk) => chunk.length <= 280));
  const spoken = chunks.slice(0, -1).join("");
  assert.ok(spoken.length > MAX_SPOKEN_TEXT * 0.8);
  assert.ok(spoken.length <= MAX_SPOKEN_TEXT);
  assert.ok(final.startsWith(spoken));
});

test("a near-cap terminal remainder retains earlier speech without replay", () => {
  const buffer = createAnswerSpeechBuffer();
  const first = "The initial synthetic result is complete, and this sentence is deliberately long enough to begin speech before the terminal record arrives.";
  assert.deepEqual(buffer.accept({ seq: 1, text: first, messageId: "one" }).chunks, [first]);
  const tailSentence = "Additional synthetic evidence remains available and should continue from the exact prior boundary without repeating it.";
  const final = `${first} ${Array.from({ length: 70 }, () => tailSentence).join(" ")}`;
  const remaining = buffer.finish(final);
  assert.notEqual(remaining[0], first);
  assert.equal(remaining.filter((chunk) => chunk === first).length, 0);
  assert.equal(remaining.at(-1), "The full answer is available in Chat.");
  const spoken = [first, ...remaining.slice(0, -1)].join(" ");
  assert.ok(spoken.length <= MAX_SPOKEN_TEXT);
  assert.ok(final.startsWith(spoken));
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

test("a streamed answer remains visibly partial when the run ends with a separate failure", () => {
  let view = pending(true);
  view = step(view, { type: "STREAM_TEXT", actionId: "run-a", text: "I checked the workspace and found the relevant configuration." });
  view = step(view, {
    type: "SPEAK_COMPLETION",
    actionId: "run-a",
    entryId: "completion-run-a:failed",
    text: "Hermes authentication failed before the request could finish.",
    textOnly: true,
    streamHandled: true,
    isError: true,
    partialResponse: "I checked the workspace and found the relevant configuration. The saved setting needs review.",
  });

  assert.equal(view.state.requestPending, false);
  assert.equal(view.state.transcript.length, 2);
  assert.deepEqual(view.state.transcript[0], {
    id: "run-a:partial",
    role: "hermes",
    text: "I checked the workspace and found the relevant configuration. The saved setting needs review.",
    time: "",
    partialResponse: true,
    interrupted: true,
  });
  assert.equal(view.state.transcript[1].runId, "run-a");
  assert.equal(view.state.transcript[1].isError, true);
  assert.equal(view.state.transcript[1].text, "Hermes authentication failed before the request could finish.");
  assert.equal(view.state.lastError.message, "Hermes authentication failed before the request could finish.");

  view = step(view, { type: "RECONCILE_SERVER_TRANSCRIPT", entries: [
    { id: "run-a:partial", role: "hermes", text: "I checked the workspace and found the relevant configuration. The saved setting needs review.", partialResponse: true, interrupted: true },
    { id: "run-a:result", role: "hermes", runId: "run-a", text: "The runtime reported the exact terminal failure.", isError: true },
  ] });
  assert.equal(view.state.transcript.length, 2);
  assert.equal(view.state.transcript[0].partialResponse, true);
  assert.equal(view.state.transcript[0].text, "I checked the workspace and found the relevant configuration. The saved setting needs review.");
  assert.equal(view.state.transcript[1].isError, true);
  assert.equal(view.state.transcript[1].text, "The runtime reported the exact terminal failure.");
});

test("speech finishing while an action runs keeps listening paused until completion", () => {
  let view = pending();
  view = step(view, { type: "STREAM_SPEECH_CHUNKS", actionId: "run-a", chunks: ["Checking the file."] });
  view = step(view, { type: "TTS_DONE", url: "blob:first" });
  view = step(view, { type: "TTS_PLAYBACK_ENDED", url: "blob:first" });
  assert.equal(view.state.state, "thinking");
  assert.equal(view.state.requestPending, true);
});

test("late streamed speech cannot replace starting, capturing, or transcribing input ownership", () => {
  for (const state of ["starting", "capturing", "transcribing"]) {
    let view = pending();
    view = { ...view, state: { ...view.state, state } };
    const next = step(view, { type: "STREAM_SPEECH_CHUNKS", actionId: "run-a", chunks: ["Late prior answer."] });
    assert.deepEqual(next, view, `${state} remains unchanged`);
  }
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
