import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { canAcceptVoiceCapture, conversationModeForPathname, resolveTextOnlyMode, shouldSuppressVoiceOutput } from "../../components/voice/voiceResponseMode.js";
import { queuedVoiceReducer } from "../../components/voice/voiceEffects.js";
import { initialWrapper } from "../../components/voice/voiceMachine.js";
import { createAnswerSpeechBuffer } from "../../components/voice/voiceAnswerStream.js";
import { voiceChatRequest } from "../../components/voice/voiceTransport.js";

const providerSource = fs.readFileSync(new URL("../../components/voice/VoiceProvider.jsx", import.meta.url), "utf8");
const ref = (current = null) => ({ current });
const flush = () => new Promise((resolve) => setImmediate(resolve));

function callback(name, bindings, source = providerSource) {
  const anchor = `const ${name} = useCallback(`;
  const start = source.indexOf(anchor) + anchor.length;
  assert.ok(start >= anchor.length, `${name} exists`);
  const end = source.indexOf("\n  }, [", start) + 4;
  assert.ok(end >= 4, `${name} callback has a dependency list`);
  return Function(...Object.keys(bindings), `return (${source.slice(start, end)});`)(...Object.values(bindings));
}

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name.toLowerCase() === "content-type" ? "application/json" : null },
    json: async () => body,
    body: { cancel: async () => {} },
  };
}

function routeBindings({ wrapperRef, dispatch, conversationModeRef, generationRef = ref(0), stopCalls = [] }) {
  return {
    wrapperRef,
    conversationModeRef,
    voiceInputGenerationRef: generationRef,
    pttGestureRef: ref({ reset: () => stopCalls.push("gesture") }),
    captureSourceRef: ref("ptt"),
    operationAbortRef: ref(new AbortController()),
    pendingStreamPromiseRef: ref(Promise.resolve()),
    latestBlobRef: ref("pending-blob"),
    clearVadInterval: () => stopCalls.push("vad"),
    stopUtteranceRecorder: async (discard) => stopCalls.push(discard ? "discard-recorder" : "stop-recorder"),
    stopAllTracks: () => stopCalls.push("tracks"),
    closeAudioContext: async () => stopCalls.push("context"),
    stopVoiceFeedbackRef: ref(() => stopCalls.push("feedback")),
    stopAudio: () => stopCalls.push("audio"),
    dispatch,
  };
}

test("Talk and Chat routes resolve only the conversation pages and preserve typed modality", () => {
  assert.equal(conversationModeForPathname("/"), "talk");
  assert.equal(conversationModeForPathname("/chat"), "chat");
  assert.equal(conversationModeForPathname("/chat/"), "chat");
  assert.equal(conversationModeForPathname("/chat/session-1"), "chat");
  assert.equal(conversationModeForPathname("/projects"), "default");
  assert.equal(conversationModeForPathname(null), "default");

  assert.equal(resolveTextOnlyMode(false, "talk"), false, "a voiced Talk prompt requests audio");
  assert.equal(resolveTextOnlyMode(false, "chat"), true, "recognized speech submitted from Chat requests text");
  assert.equal(resolveTextOnlyMode(true, "chat"), true, "typed Chat prompts request text");
  assert.equal(resolveTextOnlyMode(true, "talk"), true, "typed prompts remain text-only in Talk");
  assert.equal(resolveTextOnlyMode(false, "default"), false, "other routes keep explicit prompt modality");
  assert.equal(shouldSuppressVoiceOutput("chat", false), true);
  assert.equal(shouldSuppressVoiceOutput("talk", true), true);
  assert.equal(shouldSuppressVoiceOutput("talk", false), false);
});

test("Chat route transition preserves an accepted run and any queued transcript work", () => {
  let wrapper = queuedVoiceReducer(initialWrapper, { type: "CHAT_PENDING", textOnly: false, actionId: "run-7" });
  wrapper = queuedVoiceReducer(wrapper, { type: "STREAM_TEXT", actionId: "run-7", text: "The answer is still arriving." });
  wrapper = queuedVoiceReducer(wrapper, { type: "STREAM_SPEECH_CHUNKS", actionId: "run-7", textOnly: false, chunks: ["A queued sentence."] });
  assert.equal(wrapper.state.requestPending, true);
  assert.equal(wrapper.state.streamSpeechActive, true);
  const beforeTranscript = wrapper.state.transcript;

  const changed = queuedVoiceReducer(wrapper, { type: "RESPONSE_MODE_CHANGED", mode: "chat" });
  assert.equal(changed.state.requestPending, true);
  assert.equal(changed.state.actionId, "run-7");
  assert.equal(changed.state.continuousRequested, false);
  assert.deepEqual(changed.state.transcript, beforeTranscript);
  assert.equal(changed.state.streamSpeechActive, false);
  assert.deepEqual(changed.state.streamSpeechQueue, []);
  const returnedToTalk = queuedVoiceReducer(changed, { type: "RESPONSE_MODE_CHANGED", mode: "talk" });
  assert.equal(returnedToTalk.state.continuousRequested, false, "returning to Talk does not auto-open the microphone");
  assert.deepEqual(returnedToTalk.effects, []);

  const submitted = queuedVoiceReducer(initialWrapper, { type: "STT_OK", text: "Accepted before navigation", textOnly: false });
  const afterNavigation = queuedVoiceReducer(submitted, { type: "RESPONSE_MODE_CHANGED", mode: "chat" });
  assert.ok(afterNavigation.effects.some((effect) => effect.kind === "callChat"), "mode change must retain a queued accepted voice prompt");
  assert.ok(afterNavigation.state.transcript.some((entry) => entry.text === "Accepted before navigation"));
  assert.equal(afterNavigation.effects.some((effect) => effect.kind === "cancelRequests"), false);
});

test("Chat route settles a completed JSON reply but keeps an accepted detached run pending", () => {
  let immediate = queuedVoiceReducer(initialWrapper, { type: "CHAT_PENDING", textOnly: false, actionId: "reply-1" });
  immediate = queuedVoiceReducer(immediate, { type: "CHAT_OK", response: "A complete JSON reply." });
  assert.equal(immediate.state.requestPending, false, "a finished response is not an accepted background run");
  assert.equal(immediate.state.state, "thinking", "Talk can still finish preparing speech");
  immediate = queuedVoiceReducer(immediate, { type: "RESPONSE_MODE_CHANGED", mode: "chat" });
  assert.equal(immediate.state.state, "idle", "Chat stops the remaining speech state without leaving its composer blocked");
  assert.equal(immediate.state.requestPending, false);

  let detached = queuedVoiceReducer(initialWrapper, { type: "CHAT_PENDING", textOnly: false, actionId: "run-1" });
  detached = queuedVoiceReducer(detached, { type: "CHAT_OK", response: "Accepted run acknowledgement.", pendingRun: true });
  assert.equal(detached.state.requestPending, true);
  detached = queuedVoiceReducer(detached, { type: "RESPONSE_MODE_CHANGED", mode: "chat" });
  assert.equal(detached.state.state, "thinking");
  assert.equal(detached.state.requestPending, true, "an accepted run remains pending while Chat suppresses voice output");
  assert.equal(detached.state.actionId, "run-1");
});

test("a pending Talk POST survives navigation to Chat and its streamed answer stays visible as text", async () => {
  let wrapper = {
    ...initialWrapper,
    state: {
      ...initialWrapper.state,
      state: "thinking",
      config: { ...initialWrapper.state.config, autoSpeak: false },
      transcript: [{ id: "user:1", role: "user", text: "spoken request", isError: false }],
    },
  };
  const wrapperRef = ref(wrapper);
  const events = [];
  const dispatch = (event) => {
    events.push(event);
    wrapper = queuedVoiceReducer(wrapper, event);
    wrapperRef.current = wrapper;
  };
  const post = deferred();
  const requests = [];
  let actionId;
  const pendingRunsRef = ref(new Map());
  const textRunIdsRef = ref(new Set());
  const answerStreamsRef = ref(new Map());
  const streamedRunsRef = ref(new Map());
  const cancelledRunIdsRef = ref(new Set());
  const conversationModeRef = ref("talk");
  const accepted = ref(null);
  const runtimeFetch = (url, request) => {
    requests.push({ url, request });
    if (url === "/api/voice/chat") {
      actionId = JSON.parse(request.body).actionId;
      return post.promise;
    }
    return Promise.resolve({ ok: true, headers: { get: () => "text/event-stream" }, body: { cancel: async () => {} } });
  };
  const markRunPending = (id, textOnly) => {
    pendingRunsRef.current.set(id, Date.now());
    if (textOnly) textRunIdsRef.current.add(id);
  };
  const startAnswerStream = callback("startAnswerStream", {
    answerStreamsRef,
    pendingRunsRef,
    cancelledRunIdsRef,
    streamedRunsRef,
    createAnswerSpeechBuffer,
    runtimeFetch,
    sessionIdRef: ref("session-1"),
    readAnswerEvents: async (_response, onEvent) => {
      onEvent("text", { runId: actionId, seq: 1, text: "The answer remains visible." });
      return false;
    },
    observeRun: () => {},
    dispatch,
    retireVoiceFeedbackRef: ref(() => {}),
    shouldSuppressVoiceOutput,
    conversationModeRef,
  });
  const call = callback("callChat", {
    conversationModeRef,
    resolveTextOnlyMode,
    shouldSuppressVoiceOutput,
    setAcceptedActionId: (id) => { accepted.current = id; },
    stopVoiceFeedback: () => {},
    operationEpochRef: ref(0),
    chatAbortRef: ref(null),
    lastRequestRef: ref(null),
    dispatch,
    markRunPending,
    wrapperRef,
    preparedVoiceFeedbackRef: ref(null),
    voiceChatRequest,
    sessionIdRef: ref("session-1"),
    sttMsRef: ref(0),
    normalizeTranscriptEntries: (entries) => entries,
    runtimeFetch,
    publishVoiceActivity: () => {},
    startAnswerStream,
    playVoiceFeedback: () => {},
    prepareVoiceFeedback: () => null,
    selectEarlyVoiceFeedback: () => null,
    crypto: { randomUUID: () => "run-7" },
  });

  const pendingCall = call("spoken request", false);
  const submitted = requests.find((item) => item.url === "/api/voice/chat");
  assert.equal(JSON.parse(submitted.request.body).audio, true, "the Talk request keeps its voice modality after submission");
  assert.equal(wrapper.state.requestPending, true);

  conversationModeRef.current = "chat";
  const transition = callback("enterChatResponseMode", routeBindings({ wrapperRef, dispatch, conversationModeRef }));
  transition();
  assert.equal(wrapper.state.requestPending, true);
  assert.equal(wrapper.state.actionId, actionId);
  assert.ok(wrapper.state.transcript.some((entry) => entry.text === "spoken request"));

  post.resolve(response({ pending: true, actionId }, 202));
  await pendingCall;
  await flush();
  assert.equal(accepted.current, actionId, "navigation must not stale or cancel acceptance");
  assert.equal(pendingRunsRef.current.has(actionId), true);
  assert.ok(wrapper.state.transcript.some((entry) => entry.text === "The answer remains visible."));
  assert.equal(wrapper.state.requestPending, true, "the accepted run remains active");
  assert.equal(wrapper.state.streamSpeechActive, false);
  assert.deepEqual(wrapper.state.streamSpeechQueue, []);
  assert.equal(wrapper.effects.some((effect) => effect.kind === "callTTS"), false);
  assert.equal(requests.some((item) => item.request?.method === "DELETE"), false, "route changes never cancel the server run");
});

test("a microphone permission result resolving after Chat entry is stopped", async () => {
  let wrapper = { ...initialWrapper, state: { ...initialWrapper.state, state: "starting", pttRequested: true } };
  const wrapperRef = ref(wrapper);
  const dispatch = (event) => { wrapper = queuedVoiceReducer(wrapper, event); wrapperRef.current = wrapper; };
  const permission = deferred();
  let stopped = 0;
  const conversationModeRef = ref("talk");
  const generationRef = ref(0);
  const abort = new AbortController();
  const acquire = callback("acquireMediaStream", {
    runtimeMediaDevices: () => ({ getUserMedia: () => permission.promise }),
    voiceInputGenerationRef: generationRef,
    conversationModeRef,
    canAcceptVoiceCapture,
    operationEpochRef: ref(0),
    awaitCaptureOperation: (promise) => promise,
  });
  const pendingMic = acquire({ audio: true }, 0, abort.signal);

  conversationModeRef.current = "chat";
  const transition = callback("enterChatResponseMode", routeBindings({ wrapperRef, dispatch, conversationModeRef, generationRef }));
  transition();
  const stream = { getTracks: () => [{ stop: () => { stopped += 1; } }] };
  permission.resolve(stream);

  await assert.rejects(pendingMic, { name: "AbortError" });
  assert.equal(stopped, 1);
  assert.equal(generationRef.current, 1);
  assert.equal(wrapper.state.continuousRequested, false);
});

test("the provider applies current mode to each prompt and refuses voice activation in Chat", async () => {
  async function submit(mode, requestedTextOnly) {
    const body = ref(null);
    const call = callback("callChat", {
      conversationModeRef: ref(mode),
      resolveTextOnlyMode,
      shouldSuppressVoiceOutput,
      setAcceptedActionId: () => {},
      stopVoiceFeedback: () => {},
      operationEpochRef: ref(0),
      chatAbortRef: ref(null),
      lastRequestRef: ref(null),
      dispatch: () => {},
      markRunPending: () => {},
      wrapperRef: ref({ state: { config: { autoSpeak: false, muteOutput: false }, transcript: [] } }),
      preparedVoiceFeedbackRef: ref(null),
      voiceChatRequest,
      sessionIdRef: ref("session-1"),
      sttMsRef: ref(0),
      normalizeTranscriptEntries: (entries) => entries,
      runtimeFetch: async (_url, request) => {
        body.current = JSON.parse(request.body);
        return response({ response: "Text result." });
      },
      publishVoiceActivity: () => {},
      startAnswerStream: () => {},
      playVoiceFeedback: () => {},
      prepareVoiceFeedback: () => null,
      selectEarlyVoiceFeedback: () => null,
      crypto: { randomUUID: () => "new-run" },
    });
    await call("prompt", requestedTextOnly);
    return body.current;
  }

  assert.equal((await submit("talk", false)).audio, true);
  assert.equal((await submit("chat", false)).audio, false, "a voice result submitted in Chat is text-only");
  assert.equal((await submit("chat", true)).audio, false, "typed Chat remains text-only");
  assert.equal((await submit("default", false)).audio, true, "other routes do not force text-only behavior");

  const start = callback("startPushToTalk", {
    conversationModeRef: ref("chat"),
    wrapperRef: ref({ state: { state: "idle" } }),
    pttGestureRef: ref({ begin: () => assert.fail("Chat must reject PTT before starting a gesture") }),
  });
  assert.equal(start(), false);
  assert.match(providerSource, /const toggleContinuous = useCallback\([\s\S]*?conversationModeRef\.current === "chat"\) return false/);
});
