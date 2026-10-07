import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createPushToTalkGesture, subscribeNativeVoiceEvent } from "../../components/voice/voiceLifecycle.js";
import { initialWrapper, reducer } from "../../components/voice/voiceMachine.js";
import { queuedVoiceReducer } from "../../components/voice/voiceEffects.js";
import { voiceChatRequest } from "../../components/voice/voiceTransport.js";
import { canAcceptVoiceCapture, resolveTextOnlyMode, shouldSuppressVoiceOutput } from "../../components/voice/voiceResponseMode.js";

const source = fs.readFileSync(new URL("../../components/voice/VoiceProvider.jsx", import.meta.url), "utf8");
// Execute the production imperative callbacks with fake resources. No microphone,
// React renderer, provider request, or server is needed to exercise these races.
function callback(name, bindings, text = source) {
  const anchor = `const ${name} = useCallback(`;
  const start = text.indexOf(anchor) + anchor.length;
  assert.ok(start >= anchor.length, `${name} exists`);
  const end = text.indexOf("\n  }, [", start) + 4;
  const injected = text === source ? {
    conversationModeRef: ref("talk"),
    voiceInputGenerationRef: ref(0),
    canAcceptVoiceCapture,
    resolveTextOnlyMode,
    shouldSuppressVoiceOutput,
    ...bindings,
  } : bindings;
  return Function(...Object.keys(injected), `return (${text.slice(start, end)});`)(...Object.values(injected));
}
const ref = (current = null) => ({ current });
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test("native listener is removed exactly once when async registration resolves after unmount", async () => {
  const registration = deferred(); let calls = 0, events = 0, handler;
  const dispose = subscribeNativeVoiceEvent((name, fn) => { assert.equal(name, "voice-toggle"); handler = fn; return registration.promise; }, () => events++);
  handler(); assert.equal(events, 1);
  dispose(); dispose(); handler(); assert.equal(events, 1);
  registration.resolve(() => { calls++; return Promise.reject(new TypeError("listeners[eventId].handlerId is undefined")); });
  await flush(); dispose(); assert.equal(calls, 1);
});

test("native listener disposal handles sync throws, async rejection, and failed registration", async () => {
  for (const off of [() => { throw new Error("already removed"); }, () => Promise.reject(new Error("bridge reset"))]) {
    const dispose = subscribeNativeVoiceEvent(async () => off, () => {});
    await flush(); assert.doesNotThrow(dispose); dispose(); await flush();
  }
  const dispose = subscribeNativeVoiceEvent(() => Promise.reject(new Error("no bridge")), () => {});
  dispose(); await flush();
});

test("hold ownership rejects repeated starts, unrelated releases, and busy turns", () => {
  const gesture = createPushToTalkGesture();
  assert.equal(gesture.finish(), false);
  assert.equal(gesture.begin({ state: "thinking" }), false);
  assert.equal(gesture.begin({ state: "capturing", continuousRequested: true }), false);
  assert.equal(gesture.begin({ state: "idle" }), true);
  assert.equal(gesture.begin({ state: "idle" }), false);
  assert.equal(gesture.finish({ startup: true }), true);
  assert.equal(gesture.finish(), false);
  assert.equal(gesture.begin({ state: "starting", pttRequested: true }), true);
  gesture.reset(); assert.equal(gesture.isHeld(), false);
});

test("a same-frame press/release/repress invalidates P1 and queues only P2 startup", () => {
  const events = [], epoch = ref(0), abort = ref(new AbortController()); let primes = 0, releases = 0;
  const bindings = {
    wrapperRef: ref(initialWrapper), pttGestureRef: ref(createPushToTalkGesture()), mediaRecorderRef: ref(), captureSourceRef: ref(),
    operationEpochRef: epoch, operationAbortRef: abort, dispatch: (event) => events.push(event),
    primeAudioStack: () => { primes++; }, warmVoiceRuntime: () => {}, cancelRequests: () => {}, stopAudio: () => {},
    clearVadInterval: () => {}, stopAllTracks: () => { releases++; }, closeAudioContext: () => {},
  };
  const start = callback("startPushToTalk", bindings), finish = callback("finishPushToTalk", bindings);
  const oldSignal = abort.current.signal;
  assert.equal(start(), true); assert.equal(start(), false); assert.equal(finish(), true); assert.equal(finish(), false); assert.equal(start(), true);
  assert.equal(oldSignal.aborted, true); assert.equal(epoch.current, 1); assert.equal(primes, 2); assert.equal(releases, 1);
  const next = events.reduce(queuedVoiceReducer, initialWrapper);
  assert.equal(next.state.pttRequested, true);
  assert.deepEqual(next.effects.map(({ kind }) => kind), ["requestPermission"]);
});

test("pointer cancellation discards a captured hold without STT and restores continuous listening", () => {
  for (const continuousRequested of [false, true]) {
    let view = { ...initialWrapper, state: { ...initialWrapper.state, permission: "granted", continuousRequested, state: continuousRequested ? "listening" : "idle" } };
    view = queuedVoiceReducer(view, { type: "START_PTT" });
    view = queuedVoiceReducer(view, { type: "RECORDER_STARTED" });
    view = queuedVoiceReducer(view, { type: "CANCEL_PTT" });
    assert.equal(view.state.state, continuousRequested ? "listening" : "idle");
    assert.ok(view.effects.some((effect) => effect.kind === "stopRecorder" && effect.discard));
    assert.ok(!view.effects.some((effect) => ["startRecorder", "callSTT", "callChat"].includes(effect.kind)));
  }
});

test("repeated presses during permission pending request the mic only once", () => {
  let view = queuedVoiceReducer(initialWrapper, { type: "START_PTT" });
  view = queuedVoiceReducer(view, { type: "START_PTT" });
  assert.deepEqual(view.effects.map(({ kind }) => kind), ["requestPermission"]);
  const next = reducer({ ...view, state: { ...view.state, state: "thinking", pttRequested: false } }, { type: "START_PTT" });
  assert.deepEqual(next.effects, []);
});

test("turning off continuous startup clears pending permission and any PTT request", () => {
  let view = reducer(initialWrapper, { type: "TOGGLE_CONTINUOUS" });
  view = reducer(view, { type: "TOGGLE_CONTINUOUS" });
  assert.equal(view.state.permission, "unknown"); assert.equal(view.state.pttRequested, false);
});

test("stale mic startup cannot clear P2's pending permission promise or replace its stream", async () => {
  const p1 = deferred(), p2 = deferred(), signal = new AbortController().signal;
  const epoch = ref(0), pending = ref(p1.promise), stream = ref(); let stopped = 0;
  const bindings = {
    window: {}, wrapperRef: ref({ state: { state: "starting" } }), operationEpochRef: epoch, operationAbortRef: ref({ signal }),
    mediaStreamRef: stream, pendingStreamPromiseRef: pending, isLiveAudioStream: () => false,
    awaitCaptureOperation: (promise) => promise, dispatch: () => assert.fail("stale startup must not dispatch"),
    acquireMediaStream: () => assert.fail("P1 already pending"),
  };
  const ensure = callback("ensureMicAndVad", bindings);
  const task = ensure();
  epoch.current++; pending.current = p2.promise; const current = {}; stream.current = current;
  p1.resolve({ getTracks: () => [{ stop: () => stopped++ }] });
  await task;
  assert.equal(pending.current, p2.promise); assert.equal(stream.current, current); assert.equal(stopped, 1);
});

test("an aborted AudioContext resume cannot publish a stale capture failure", async () => {
  const resume = deferred(), epoch = ref(0), abort = new AbortController();
  const bindings = {
    window: {}, wrapperRef: ref({ state: { state: "starting" } }), operationEpochRef: epoch, operationAbortRef: ref(abort),
    mediaStreamRef: ref({}), pendingStreamPromiseRef: ref(), isLiveAudioStream: () => true,
    audioContextRef: ref({ state: "suspended", resume: () => resume.promise }),
    awaitCaptureOperation: (promise) => promise, dispatch: () => assert.fail("stale resume must not dispatch"),
  };
  const task = callback("ensureMicAndVad", bindings)();
  epoch.current++; abort.abort(); resume.reject(new Error("closed")); await task;
});

test("track teardown detaches pending permission even before any stream arrives", () => {
  const pending = ref(Promise.resolve()), bindings = {
    destroySpeechDetector: () => {}, mediaStreamRef: ref(), pendingStreamPromiseRef: pending, handledTrackIdsRef: ref(new Set(["old"])),
  };
  callback("stopAllTracks", bindings)();
  assert.equal(pending.current, null); assert.equal(bindings.handledTrackIdsRef.current.size, 0);
});

const dock = fs.readFileSync(new URL("../../components/voice/VoiceDock.jsx", import.meta.url), "utf8");
test("dock records immediately, ignores other pointers, and sends only once when capture is lost after release", () => {
  const press = ref(); const calls = [];
  const bindings = { pressRef: press, voiceRef: ref({ startPushToTalk: () => { calls.push("start"); return true; }, stopPushToTalk: () => calls.push("send"), cancelPushToTalk: () => calls.push("cancel") }), setPttActive: () => {} };
  const begin = callback("beginPtt", bindings, dock), finish = callback("finishPtt", bindings, dock);
  const target = { setPointerCapture: () => { throw new Error("unsupported"); }, releasePointerCapture: () => finish(true, { pointerId: 1 }) };
  begin({ pointerId: 1, button: 0, currentTarget: target });
  begin({ pointerId: 2, button: 0, currentTarget: target });
  assert.deepEqual(calls, ["start"]);
  finish(false, { pointerId: 2 }); assert.ok(press.current);
  finish(false, { pointerId: 1 }); assert.equal(press.current, null);
  assert.deepEqual(calls, ["start", "send"]);
});

test("dock cancellation discards keyboard and pointer holds without accidental submission", () => {
  for (const event of [{ key: " " }, { key: "Enter" }, { pointerId: 8, button: 0, currentTarget: { setPointerCapture() {} } }]) {
    const calls = [], bindings = { pressRef: ref(), voiceRef: ref({ startPushToTalk: () => true, stopPushToTalk: () => calls.push("send"), cancelPushToTalk: () => calls.push("cancel") }), setPttActive: () => {} };
    callback("beginPtt", bindings, dock)(event);
    const finish = callback("finishPtt", bindings, dock);
    finish(true); finish(false, event);
    assert.deepEqual(calls, ["cancel"]);
  }
});

test("dock ignores rejected starts instead of showing an active hold", () => {
  const bindings = { pressRef: ref(), voiceRef: ref({ startPushToTalk: () => false }), setPttActive: () => assert.fail("rejected hold") };
  callback("beginPtt", bindings, dock)({ key: "Enter" });
  assert.equal(bindings.pressRef.current, null);
});

for (const outcome of ["accepted", "mismatched", "cancelled"]) {
  test(`a deferred POST cannot authorize session detachment before ${outcome} acknowledgement`, async () => {
    const response = deferred(); let accepted = "previous-run", submittedId;
    const epoch = ref(0), events = [];
    const bindings = {
      setAcceptedActionId: (id) => { accepted = id; }, stopVoiceFeedback: () => {}, operationEpochRef: epoch, chatAbortRef: ref(), lastRequestRef: ref(),
      markRunPending: () => {}, dispatch: (event) => events.push(event), wrapperRef: ref({ state: { config: { autoSpeak: false }, transcript: [] } }),
      preparedVoiceFeedbackRef: ref(), voiceChatRequest, sessionIdRef: ref("test-session"), sttMsRef: ref(0), normalizeTranscriptEntries: (entries) => entries,
      runtimeFetch: (_url, request) => { submittedId = JSON.parse(request.body).actionId; return response.promise; },
      publishVoiceActivity: () => {}, startAnswerStream: () => {},
    };
    const call = callback("callChat", bindings)("Test", true);
    assert.ok(submittedId); assert.ok(events.some((event) => event.type === "CHAT_PENDING"));
    assert.equal(accepted, null, "optimistic CHAT_PENDING must not authorize a switch");
    if (outcome === "cancelled") epoch.current++;
    response.resolve(Response.json({ pending: true, actionId: outcome === "mismatched" ? "other-run" : submittedId }, { status: 202 }));
    await call;
    assert.equal(accepted, outcome === "accepted" ? submittedId : null);
  });
}
