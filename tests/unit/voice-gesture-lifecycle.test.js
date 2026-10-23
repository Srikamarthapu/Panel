import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createPushToTalkGesture, subscribeNativeVoiceEvent } from "../../components/voice/voiceLifecycle.js";
import { initialWrapper, reducer } from "../../components/voice/voiceMachine.js";
import { queuedVoiceReducer } from "../../components/voice/voiceEffects.js";
import { voiceChatRequest } from "../../components/voice/voiceTransport.js";
import { canAcceptVoiceCapture, resolveTextOnlyMode, shouldSuppressVoiceOutput } from "../../components/voice/voiceResponseMode.js";
import { microphoneConstraints } from "../../components/voice/voiceCapture.js";

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
    microphoneAcquisitionGenerationRef: ref(0),
    captureSubmissionCommittedRef: ref(false),
    canAcceptVoiceCapture,
    resolveTextOnlyMode,
    shouldSuppressVoiceOutput,
    voiceInputGenerationRef: ref(0),
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
    completionInputOwnershipRef: ref(false), captureSubmissionCommittedRef: ref(false),
    operationEpochRef: epoch, operationAbortRef: abort, dispatch: (event) => events.push(event),
    primeAudioStack: () => { primes++; }, warmVoiceRuntime: () => {}, cancelRequests: () => {}, stopAudio: () => {},
    stopAllTracks: () => { releases++; }, closeAudioContext: () => {},
  };
  const start = callback("startPushToTalk", bindings), finish = callback("finishPushToTalk", bindings);
  const oldSignal = abort.current.signal;
  assert.equal(start(), true); assert.equal(start(), false); assert.equal(finish(), true); assert.equal(finish(), false); assert.equal(start(), true);
  assert.equal(oldSignal.aborted, true); assert.equal(epoch.current, 1); assert.equal(primes, 2); assert.equal(releases, 1);
  assert.equal(bindings.completionInputOwnershipRef.current, true, "the second press owns completion admission before React commits");
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

test("changing microphones stops a late permission stream and a fresh exact-device capture succeeds", async () => {
  const p1 = deferred();
  const p2 = deferred();
  const requests = [];
  const microphoneGeneration = ref(0);
  let stopped = 0;
  const acquire = callback("acquireMediaStream", {
    runtimeMediaDevices: () => ({
      getUserMedia: (constraints) => {
        requests.push(constraints);
        return requests.length === 1 ? p1.promise : p2.promise;
      },
    }),
    microphoneAcquisitionGenerationRef: microphoneGeneration,
    voiceInputGenerationRef: ref(0),
    conversationModeRef: ref("talk"),
    canAcceptVoiceCapture,
    operationEpochRef: ref(0),
    awaitCaptureOperation: (promise) => promise,
  });
  const first = acquire(microphoneConstraints("bluetooth-mic"), 0, new AbortController().signal);
  microphoneGeneration.current += 1;
  const stale = { getTracks: () => [{ stop: () => { stopped += 1; } }] };
  p1.resolve(stale);
  await assert.rejects(first, { name: "AbortError" });
  assert.equal(stopped, 1);

  const second = acquire(microphoneConstraints("mac-built-in"), 0, new AbortController().signal);
  const fresh = { getTracks: () => [] };
  p2.resolve(fresh);
  assert.equal(await second, fresh);
  assert.deepEqual(requests.at(-1).audio.deviceId, { exact: "mac-built-in" });
});

test("mic-loss recovery rebuilds capture and announces success only after readiness", async () => {
  const events = [], activity = [], invalidated = [];
  let ensureOptions = null;
  const bindings = {
    window: {},
    conversationModeRef: ref("talk"),
    micRecoveringRef: ref(false),
    captureSubmissionCommittedRef: ref(false),
    completionInputOwnershipRef: ref(false),
    wrapperRef: ref({ state: { ...initialWrapper.state, state: "listening", continuousRequested: true } }),
    publishVoiceActivity: (event) => activity.push(event),
    invalidateMicrophoneInputRef: ref((state) => invalidated.push(state)),
    ensureMicAndVad: async (options) => { ensureOptions = options; return true; },
    dispatch: (event) => events.push(event),
  };
  await callback("reacquireMic", bindings)();
  assert.equal(invalidated.length, 1);
  assert.deepEqual(ensureOptions, { preserveSubmittedWork: false, awaitDetectorReady: true });
  assert.deepEqual(events.map((event) => event.type), ["MIC_RECOVERY_STARTED", "MIC_RECOVERY_READY"]);
  assert.deepEqual(activity.map((event) => event.title), ["Microphone lost", "Microphone reconnected"]);

  events.length = 0;
  activity.length = 0;
  bindings.micRecoveringRef.current = false;
  await callback("reacquireMic", { ...bindings, ensureMicAndVad: async () => false })();
  assert.deepEqual(events.map((event) => event.type), ["MIC_RECOVERY_STARTED"]);
  assert.deepEqual(activity.map((event) => event.title), ["Microphone lost"]);

  events.length = 0;
  activity.length = 0;
  bindings.micRecoveringRef.current = false;
  bindings.captureSubmissionCommittedRef.current = true;
  bindings.wrapperRef.current = { state: { ...initialWrapper.state, state: "transcribing", requestPending: true, actionId: "run-1" } };
  await callback("reacquireMic", bindings)();
  assert.deepEqual(events.map((event) => event.type), ["MIC_RECOVERY_FAILED"]);
  assert.equal(events[0].code, "MIC_STREAM_ENDED");
  assert.equal(activity[0].title, "Microphone lost");
});

test("destroying a detector generation rejects its late replacement before it can bind", async () => {
  const pendingDetector = deferred();
  const generation = ref(0);
  const detectorRef = ref(null);
  const detectorPromiseRef = ref(null);
  let destroyed = 0;
  const task = callback("ensureContinuousSpeechDetector", {
    speechDetectorRef: detectorRef,
    speechDetectorPromiseRef: detectorPromiseRef,
    speechDetectorReadinessRef: ref(null),
    speechDetectorControlRef: ref(Promise.resolve()),
    speechDetectorGenerationRef: generation,
    mediaStreamRef: ref({ getAudioTracks: () => [{ readyState: "live", enabled: true }] }),
    audioContextRef: ref({}),
    operationEpochRef: ref(0),
    isLiveAudioStream: () => true,
    runtimeSpeechDetector: () => pendingDetector.promise,
    awaitCaptureOperation: (promise) => promise,
    wrapperRef: ref({ state: { state: "starting", continuousRequested: true } }),
    publishVoiceActivity() {},
    dispatch: () => assert.fail("a stale detector must not publish readiness"),
    speechDetectorReadyTimerRef: ref(null),
    speechDetectorSignalTimerRef: ref(null),
    voiceStartupAtRef: ref(0),
    captureSourceRef: ref(null),
    captureSubmissionCommittedRef: ref(false),
    latestBlobRef: ref(null),
    speechEndedAtRef: ref(0),
  })(0, new AbortController().signal);
  generation.current += 1;
  pendingDetector.resolve({ destroy: async () => { destroyed += 1; } });
  await assert.rejects(task, { name: "AbortError" });
  assert.equal(destroyed, 1);
  assert.equal(detectorRef.current, null);
});

test("microphone invalidation preserves submitted recorder finalization and keeps output context alive", async () => {
  const finishing = deferred();
  const oldAbort = new AbortController();
  const microphoneGeneration = ref(4);
  const pending = ref(Promise.resolve());
  let oldStops = 0;
  let newStops = 0;
  let recorderCalls = 0;
  const oldStream = { getTracks: () => [{ stop: () => { oldStops += 1; } }] };
  const newStream = { getTracks: () => [{ stop: () => { newStops += 1; } }] };
  const stream = ref(oldStream);
  const captureSource = ref("ptt");
  let gestureResets = 0;
  const invalidate = callback("invalidateMicrophoneInput", {
    microphoneAcquisitionGenerationRef: microphoneGeneration,
    operationAbortRef: ref(oldAbort),
    pttGestureRef: ref({ reset: () => { gestureResets += 1; } }),
    captureSourceRef: captureSource,
    captureSubmissionCommittedRef: ref(true),
    pendingStreamPromiseRef: pending,
    mediaStreamRef: stream,
    handledTrackIdsRef: ref(new Set(["old-track"])),
    destroySpeechDetector: () => {},
    recorderStopRef: ref(finishing.promise),
    mediaRecorderRef: ref(null),
    stopUtteranceRecorder: () => { recorderCalls += 1; },
  });

  invalidate({ state: "transcribing" });
  assert.equal(microphoneGeneration.current, 5);
  assert.equal(oldAbort.signal.aborted, true);
  assert.equal(pending.current, null);
  assert.equal(gestureResets, 1);
  assert.equal(captureSource.current, null);
  assert.equal(recorderCalls, 0, "an existing finalization must not be replaced or discarded");
  assert.equal(oldStops, 0, "the old track stays until the submitted blob is finalized");
  stream.current = newStream;
  finishing.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(oldStops, 1);
  assert.equal(newStops, 0, "late old-turn teardown must not stop the freshly selected stream");
  assert.equal(stream.current, newStream);
});

test("microphone invalidation discards only an unsubmitted capture and does not close playback context", async () => {
  const stopped = deferred();
  const calls = [];
  let oldStops = 0;
  const invalidate = callback("invalidateMicrophoneInput", {
    microphoneAcquisitionGenerationRef: ref(0),
    operationAbortRef: ref(new AbortController()),
    pttGestureRef: ref({ reset: () => calls.push("gesture") }),
    captureSourceRef: ref("ptt"),
    captureSubmissionCommittedRef: ref(false),
    pendingStreamPromiseRef: ref(null),
    mediaStreamRef: ref({ getTracks: () => [{ stop: () => { oldStops += 1; } }] }),
    handledTrackIdsRef: ref(new Set()),
    destroySpeechDetector: () => calls.push("detector"),
    recorderStopRef: ref(null),
    mediaRecorderRef: ref({ state: "recording" }),
    stopUtteranceRecorder: (discard) => {
      calls.push(discard ? "discard" : "submit");
      return stopped.promise;
    },
  });
  invalidate({ state: "capturing" });
  assert.deepEqual(calls, ["gesture", "detector", "discard"]);
  assert.equal(oldStops, 0);
  stopped.resolve();
  await flush();
  assert.equal(oldStops, 1);
});

test("microphone invalidation preserves a continuous blob committed before the reducer publishes transcribing", async () => {
  const committedBlob = { type: "audio/wav", size: 640 };
  const latestBlobRef = ref(committedBlob);
  const committed = ref(true);
  let recorderCalls = 0;
  let oldStops = 0;
  const invalidate = callback("invalidateMicrophoneInput", {
    microphoneAcquisitionGenerationRef: ref(0),
    operationAbortRef: ref(new AbortController()),
    pttGestureRef: ref({ reset() {} }),
    captureSourceRef: ref(null),
    captureSubmissionCommittedRef: committed,
    pendingStreamPromiseRef: ref(null),
    mediaStreamRef: ref({ getTracks: () => [{ stop: () => { oldStops += 1; } }] }),
    handledTrackIdsRef: ref(new Set()),
    destroySpeechDetector() {},
    recorderStopRef: ref(null),
    mediaRecorderRef: ref(null),
    latestBlobRef,
    stopUtteranceRecorder() {
      recorderCalls += 1;
      latestBlobRef.current = null;
    },
  });

  invalidate({ state: "capturing", continuousRequested: true });
  assert.equal(recorderCalls, 0, "the stale capturing view must not discard a committed VAD result");
  assert.equal(latestBlobRef.current, committedBlob);
  assert.equal(committed.current, true);
  assert.equal(oldStops, 1);

  const queued = {
    ...initialWrapper,
    state: { ...initialWrapper.state, state: "capturing", continuousRequested: true },
    effects: [{ effectId: 1, kind: "callSTT" }],
    effectSequence: 1,
  };
  const changed = queuedVoiceReducer(queued, { type: "MIC_INPUT_CHANGED", partial: { micDeviceId: "built-in" } });
  assert.deepEqual(changed.effects.map(({ kind }) => kind), ["callSTT"]);
});

test("microphone invalidation finalizes a PTT recording committed before the reducer publishes transcribing", async () => {
  const finishing = deferred();
  const committed = ref(true);
  let discard;
  let oldStops = 0;
  const invalidate = callback("invalidateMicrophoneInput", {
    microphoneAcquisitionGenerationRef: ref(0),
    operationAbortRef: ref(new AbortController()),
    pttGestureRef: ref({ reset() {} }),
    captureSourceRef: ref(null),
    captureSubmissionCommittedRef: committed,
    pendingStreamPromiseRef: ref(null),
    mediaStreamRef: ref({ getTracks: () => [{ stop: () => { oldStops += 1; } }] }),
    handledTrackIdsRef: ref(new Set()),
    destroySpeechDetector() {},
    recorderStopRef: ref(null),
    mediaRecorderRef: ref({ state: "recording" }),
    stopUtteranceRecorder(value) { discard = value; return finishing.promise; },
  });

  invalidate({ state: "capturing", continuousRequested: false });
  assert.equal(discard, false, "a synchronously committed PTT release must finalize rather than discard");
  assert.equal(oldStops, 0);
  finishing.resolve();
  await flush();
  assert.equal(oldStops, 1);
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
test("dock records immediately, ignores other pointers, and sends only once when capture is lost after release", async () => {
  const press = ref(), suppressNextClick = ref(false); const calls = [];
  const bindings = { modeRef: ref("ptt"), pressRef: press, suppressNextClickRef: suppressNextClick, voiceRef: ref({ startPushToTalk: () => { calls.push("start"); return true; }, stopPushToTalk: () => calls.push("send"), cancelPushToTalk: () => calls.push("cancel") }), setPttActive: () => {} };
  const begin = callback("beginPtt", bindings, dock), finish = callback("finishPtt", bindings, dock);
  const target = { setPointerCapture: () => { throw new Error("unsupported"); }, releasePointerCapture: () => finish(true, { pointerId: 1 }) };
  begin({ pointerId: 1, button: 0, currentTarget: target });
  begin({ pointerId: 2, button: 0, currentTarget: target });
  assert.deepEqual(calls, ["start"]);
  finish(false, { pointerId: 2 }); assert.ok(press.current);
  finish(false, { code: "Space", key: " " }); assert.ok(press.current);
  finish(false, { pointerId: 1 }); assert.equal(press.current, null);
  assert.deepEqual(calls, ["start", "send"]);
  assert.equal(suppressNextClick.current, true, "a successful pointer hold suppresses its trailing click");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(suppressNextClick.current, false, "a later intentional click remains available");
});

test("dock cancellation discards keyboard and pointer holds without accidental submission", () => {
  for (const event of [{ key: " " }, { key: "Enter" }, { pointerId: 8, button: 0, currentTarget: { setPointerCapture() {} } }]) {
    const calls = [], suppressNextClick = ref(false), bindings = { modeRef: ref("ptt"), pressRef: ref(), suppressNextClickRef: suppressNextClick, voiceRef: ref({ startPushToTalk: () => true, stopPushToTalk: () => calls.push("send"), cancelPushToTalk: () => calls.push("cancel") }), setPttActive: () => {} };
    callback("beginPtt", bindings, dock)(event);
    const finish = callback("finishPtt", bindings, dock);
    finish(true); finish(false, event);
    assert.deepEqual(calls, ["cancel"]);
    assert.equal(suppressNextClick.current, false, "cancelled holds do not suppress the next action");
  }
});

test("dock ignores rejected starts instead of showing an active hold", () => {
  const bindings = { modeRef: ref("ptt"), pressRef: ref(), voiceRef: ref({ startPushToTalk: () => false }), setPttActive: () => assert.fail("rejected hold") };
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
