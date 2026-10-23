"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import VoiceProvider, { useVoice } from "../../../components/voice/VoiceProvider.jsx";

const memoryStorage = () => { const values = new Map(); return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) }; };
export function waveBlob(seconds = 0.35) {
  const rate = 8000, count = Math.floor(rate * seconds), bytes = new Uint8Array(44 + count * 2), view = new DataView(bytes.buffer);
  const text = (at, value) => [...value].forEach((char, index) => view.setUint8(at + index, char.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, 36 + count * 2, true); text(8, "WAVE"); text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, count * 2, true);
  for (let index = 0; index < count; index += 1) view.setInt16(44 + index * 2, Math.sin(index / rate * Math.PI * 880) * 5000, true);
  return new Blob([bytes], { type: "audio/wav" });
}
export function createSyntheticRuntime() {
  let stream, context, scheduled = false, sttTurn = 0, detectorTurn = 0;
  const getUserMedia = async () => {
    if (stream?.getAudioTracks().some((track) => track.readyState === "live")) return stream;
    const Context = window.AudioContext || window.webkitAudioContext;
    context = new Context(); await context.resume();
    const destination = context.createMediaStreamDestination(); stream = destination.stream;
    if (!scheduled) {
      scheduled = true;
      for (const delay of [0.9, 5.5]) { const oscillator = context.createOscillator(), gain = context.createGain(); gain.gain.value = 0.2; oscillator.connect(gain).connect(destination); oscillator.start(context.currentTime + delay); oscillator.stop(context.currentTime + delay + 0.7); }
    }
    return stream;
  };
  const mockFetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith("/api/voice/stt")) { sttTurn += 1; return Response.json({ text: `Synthetic utterance ${sttTurn}`, confidence: 1 }); }
    if (url.endsWith("/api/voice/chat") && init.method === "POST") return Response.json({ response: `Synthetic response ${sttTurn}` });
    if (url.endsWith("/api/voice/tts")) return new Response(waveBlob(), { headers: { "Content-Type": "audio/wav" } });
    if (url.endsWith("/api/voice/status")) return Response.json({ status: "ok", buildId: "dev" });
    if (url.endsWith("/api/voice/voices")) return Response.json({ voices: [] });
    if (url.includes("/api/voice/activity") && (!init.method || init.method === "GET")) return Response.json({ items: [] });
    if (url.includes("/api/voice/runs") && (!init.method || init.method === "GET")) return Response.json({ status: "pending" });
    return new Response(null, { status: 204 });
  };
  const createSpeechDetector = async (options) => {
    let listening = false, timer = null;
    const detector = {
      start: async () => {
        if (listening) return;
        listening = true;
        options.onFrameProcessed?.({ isSpeech: 0, notSpeech: 1 }, new Float32Array([0.01]));
        if (detectorTurn >= 2) return;
        const turn = detectorTurn++;
        timer = setTimeout(() => {
          if (!listening) return;
          options.onSpeechRealStart?.();
          timer = setTimeout(() => {
            if (!listening) return;
            const samples = new Float32Array(16000);
            for (let index = 0; index < samples.length; index += 1) samples[index] = Math.sin(index / 16000 * Math.PI * (turn ? 520 : 440)) * 0.2;
            options.onSpeechEnd?.(samples);
          }, 700);
        }, 500);
      },
      pause: async () => { listening = false; if (timer) clearTimeout(timer); timer = null; },
      destroy: async () => { listening = false; if (timer) clearTimeout(timer); },
    };
    await detector.start();
    return detector;
  };
  return { storage: memoryStorage(), mediaDevices: { getUserMedia }, AudioContext: window.AudioContext || window.webkitAudioContext, MediaRecorder: window.MediaRecorder, Audio: window.Audio, createSpeechDetector, fetch: mockFetch };
}
function createDeferredRuntime() {
  const requests = [], streams = [];
  let fetchCount = 0;
  const getUserMedia = () => new Promise((resolve) => requests.push(resolve));
  const resolveRequest = (index) => {
    const Context = window.AudioContext || window.webkitAudioContext;
    const context = new Context(), destination = context.createMediaStreamDestination();
    streams[index] = { context, stream: destination.stream };
    requests[index]?.(destination.stream);
  };
  return {
    storage: memoryStorage(), mediaDevices: { getUserMedia }, AudioContext: window.AudioContext || window.webkitAudioContext,
    MediaRecorder: window.MediaRecorder, Audio: window.Audio,
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("/api/voice/stt") || url.endsWith("/api/voice/chat") || url.endsWith("/api/voice/tts")) fetchCount += 1;
      if (url.endsWith("/api/voice/status")) return Response.json({ status: "ok", buildId: "dev" });
      if (url.endsWith("/api/voice/voices")) return Response.json({ voices: [] });
      if (url.includes("/api/voice/activity")) return Response.json({ items: [] });
      return new Response(null, { status: 204 });
    },
    controls: { resolveRequest, requestCount: () => requests.length, stream: (index) => streams[index]?.stream, fetchCount: () => fetchCount },
  };
}
function FixtureControls() {
  const voice = useVoice();
  const [phase, setPhase] = useState("ready"), [history, setHistory] = useState([]);
  const captureSeen = useRef(false), lastState = useRef("");
  useEffect(() => {
    if (voice.state !== lastState.current) { lastState.current = voice.state; setHistory((items) => [...items, voice.state]); }
    if (voice.state === "error" && phase !== "ready" && phase !== "passed" && phase !== "failed") { setPhase("failed"); return; }
    const replies = voice.transcript.filter((entry) => entry.role === "hermes").length;
    if (phase === "continuous" && replies >= 2 && voice.state === "listening") { setPhase("ending-continuous"); voice.toggleContinuous(); }
    else if (phase === "ending-continuous" && voice.state === "idle") { setPhase("ptt"); voice.primeAudioStack(); voice.startPushToTalk(); }
    else if (phase === "ptt" && voice.state === "capturing" && !captureSeen.current) { captureSeen.current = true; setTimeout(() => voice.cancelCurrent(), 350); }
    else if (phase === "ptt" && captureSeen.current && voice.state === "idle") setPhase("passed");
  }, [phase, voice]);
  const start = () => { captureSeen.current = false; setHistory([]); setPhase("continuous"); voice.primeAudioStack(); voice.toggleContinuous(); };
  const passed = phase === "passed";
  return <main style={{ maxWidth: 780, margin: "48px auto", padding: 24, fontFamily: "system-ui", color: "#e8eef7", background: "#111827", minHeight: 440, borderRadius: 20 }}>
    <p style={{ color: "#94a3b8" }}>Development fixture · synthetic mic · mocked private APIs · memory-only storage</p><h1>VoiceProvider lifecycle fixture</h1>
    <p>Runs the production provider, effect queue, VAD, recorder, STT/chat/TTS callers, playback, continuous resume, a second utterance, then PTT cancellation.</p>
    <button type="button" onClick={start} disabled={!['ready', 'passed', 'failed'].includes(phase)}>{['ready', 'passed', 'failed'].includes(phase) ? "Run two-turn lifecycle" : "Running…"}</button>
    <h2 data-testid="fixture-status" style={{ color: passed ? "#86efac" : "#f8fafc" }}>{passed ? "PASS: two continuous turns + playback + PTT cancel" : `${phase} · ${voice.state}`}</h2>
    {voice.lastError ? <p role="alert">{voice.lastError.code}: {voice.lastError.message}</p> : null}
    <p>Transcript: {voice.transcript.map((entry) => `${entry.role}: ${entry.text}`).join(" | ") || "none"}</p><p>States: {history.join(" → ") || "idle"}</p>
  </main>;
}
function DeferredPermissionControls({ controls }) {
  const voice = useVoice();
  const [status, setStatus] = useState("Ready");
  const running = useRef(false), stage = useRef("idle");
  useEffect(() => {
    if (!running.current || voice.state !== "capturing") return;
    if (stage.current === "p1-p2") {
      const staleStopped = controls.stream(0)?.getAudioTracks().every((track) => track.readyState === "ended");
      if (controls.requestCount() !== 2 || !staleStopped || controls.fetchCount() !== 0) {
        voice.cancelCurrent(); running.current = false; setStatus("FAIL: deferred permission invariants"); return;
      }
      voice.cancelCurrent(); stage.current = "direct-reacquire"; setStatus("P1/P2 passed; testing direct reacquire…");
      setTimeout(() => { voice.startPushToTalk(); setTimeout(() => controls.resolveRequest(2), 80); }, 100);
      return;
    }
    if (stage.current === "direct-reacquire") {
      const passed = controls.requestCount() === 3 && controls.fetchCount() === 0;
      voice.cancelCurrent(); running.current = false; stage.current = "done";
      setStatus(passed ? "PASS: stale P1 stopped; P2 captured; direct reacquire captured" : "FAIL: direct reacquire invariants");
    }
  }, [controls, voice]);
  const run = () => {
    running.current = true; stage.current = "p1-p2"; setStatus("Running deferred P1/P2 race…");
    voice.primeAudioStack(); voice.startPushToTalk();
    setTimeout(() => {
      voice.stopPushToTalk();
      voice.primeAudioStack(); voice.startPushToTalk();
      setTimeout(() => controls.resolveRequest(0), 80);
      setTimeout(() => controls.resolveRequest(1), 160);
      setTimeout(() => { if (running.current) { running.current = false; voice.cancelCurrent(); setStatus("FAIL: restart did not reach capturing"); } }, 2500);
    }, 80);
  };
  return <section style={{ maxWidth: 780, margin: "24px auto 48px", padding: 24, fontFamily: "system-ui", color: "#e8eef7", background: "#111827", borderRadius: 20 }}>
    <h2>Deferred permission cancellation fixture</h2><p>Runs stale P1 cancellation, P2 restart, then an unprimed direct reacquire through ensureMicAndVad.</p>
    <button type="button" onClick={run} disabled={running.current}>Run deferred permission race</button>
    <h3 data-testid="deferred-status">{status} · {voice.state}</h3>
  </section>;
}

function createMicrophoneSwitchRuntime() {
  const listeners = new Set(), streams = [], streamStopped = [], constraints = [], recorders = [];
  let sttCount = 0;
  const Context = window.AudioContext || window.webkitAudioContext;
  const stats = () => ({
    acquisitions: constraints.length,
    constraints: structuredClone(constraints),
    oldLive: streams[0] ? !streamStopped[0] : false,
    freshLive: streams[1] ? !streamStopped[1] : false,
    oldRecorderPending: !!recorders[0]?.pending,
    sttCount,
  });
  const emit = () => listeners.forEach((listener) => listener(stats()));
  class DelayedRecorder {
    static isTypeSupported() { return true; }
    constructor(stream) { this.stream = stream; this.state = "inactive"; this.mimeType = "audio/webm"; this.pending = false; recorders.push(this); }
    start() { this.state = "recording"; emit(); }
    stop() {
      if (this.state === "inactive") return;
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob([new Uint8Array(512)], { type: this.mimeType }) });
      if (recorders[0] === this) { this.pending = true; emit(); }
      else queueMicrotask(() => this.onstop?.());
    }
    finish() { if (!this.pending) return; this.pending = false; this.onstop?.(); emit(); }
  }
  const getUserMedia = async (request) => {
    const streamIndex = streams.length;
    constraints.push(request);
    const context = new Context(), destination = context.createMediaStreamDestination();
    streamStopped[streamIndex] = false;
    // WebKit does not synchronously expose `readyState = "ended"` after stop
    // on this synthetic destination track. Return observable wrappers from
    // the real MediaStream so the fixture records the production stop call
    // itself while the audio graph still receives a native MediaStream.
    const nativeTracks = destination.stream.getTracks();
    const endedTargets = nativeTracks.map(() => new EventTarget());
    const observedTracks = nativeTracks.map((track, trackIndex) => ({
      id: track.id,
      kind: track.kind,
      enabled: track.enabled,
      get readyState() { return streamStopped[streamIndex] ? "ended" : track.readyState; },
      stop() { streamStopped[streamIndex] = true; track.stop(); emit(); },
      addEventListener: (...args) => endedTargets[trackIndex].addEventListener(...args),
      removeEventListener: (...args) => endedTargets[trackIndex].removeEventListener(...args),
      get onended() { return track.onended; },
      set onended(handler) { track.onended = handler; },
    }));
    Object.defineProperty(destination.stream, "getTracks", { configurable: true, value: () => observedTracks });
    Object.defineProperty(destination.stream, "getAudioTracks", { configurable: true, value: () => observedTracks });
    destination.stream.__fixtureLose = () => {
      streamStopped[streamIndex] = true;
      endedTargets.forEach((target) => target.dispatchEvent(new Event("ended")));
      emit();
    };
    streams.push(destination.stream); emit(); return destination.stream;
  };
  const fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith("/api/voice/stt")) { sttCount += 1; emit(); return Response.json({ text: "Committed PTT utterance", confidence: 1 }); }
    if (url.endsWith("/api/voice/chat") && init.method === "POST") return Response.json({ response: "Committed PTT reply preserved." });
    if (url.endsWith("/api/voice/status")) return Response.json({ status: "running", config: { enabled: true, autoSpeak: false, micDeviceId: "" } });
    if (url.endsWith("/api/voice/voices")) return Response.json({ voices: [] });
    if (url.includes("/api/voice/activity")) return Response.json({ items: [] });
    return new Response(null, { status: 204 });
  };
  return {
    storage: memoryStorage(), mediaDevices: { getUserMedia }, AudioContext: Context, MediaRecorder: DelayedRecorder, Audio: window.Audio, fetch,
    controls: {
      finishOldRecorder: () => recorders[0]?.finish(),
      loseOldMicrophone: () => streams[0]?.__fixtureLose?.(),
      getStats: stats,
      subscribe(listener) { listeners.add(listener); listener(stats()); return () => listeners.delete(listener); },
    },
  };
}

function MicrophoneSwitchControls({ runtime }) {
  const voice = useVoice(), [phase, setPhase] = useState("ready"), [stats, setStats] = useState(runtime.controls.getStats());
  useEffect(() => runtime.controls.subscribe(setStats), [runtime]);
  useEffect(() => {
    if (phase === "starting-old" && voice.state === "capturing") setPhase("old-ready");
    else if (phase === "switching" && voice.state === "idle" && stats.sttCount === 1) { voice.startPushToTalk(); setPhase("fresh-starting"); }
    else if (phase === "fresh-starting" && voice.state === "capturing") {
      const exact = stats.constraints[1]?.audio?.deviceId?.exact === "mac-input";
      setPhase(exact && !stats.oldLive && stats.freshLive ? "passed" : "failed");
    }
  }, [phase, stats, voice]);
  const start = () => { setPhase("starting-old"); voice.startPushToTalk(); };
  const replace = () => { setPhase("switching"); voice.stopPushToTalk(); void voice.updateConfig({ micDeviceId: "mac-input" }, { persist: false }); };
  return <section style={{ maxWidth: 780, margin: "24px auto", padding: 24, fontFamily: "system-ui", color: "#e8eef7", background: "#111827", borderRadius: 20 }}>
    <h2>Committed recorder device switch</h2>
    <button type="button" onClick={start} disabled={phase !== "ready"}>Start committed capture</button>
    <button type="button" onClick={replace} disabled={phase !== "old-ready"}>Release and select built-in microphone</button>
    <button type="button" onClick={runtime.controls.finishOldRecorder} disabled={!stats.oldRecorderPending}>Finish committed recorder</button>
    <h3 data-testid="recorder-switch-status">{phase} · {voice.state}</h3>
    <output data-testid="recorder-switch-stats">requests {stats.acquisitions}; old {stats.oldLive ? "live" : "stopped"}; fresh {stats.freshLive ? "live" : "stopped"}; selected {stats.constraints[1]?.audio?.deviceId?.exact || "none"}; STT {stats.sttCount}</output>
  </section>;
}

function UnsubmittedMicrophoneSwitchControls({ runtime }) {
  const voice = useVoice(), [phase, setPhase] = useState("ready"), [stats, setStats] = useState(runtime.controls.getStats());
  useEffect(() => runtime.controls.subscribe(setStats), [runtime]);
  useEffect(() => {
    if (phase === "starting-old" && voice.state === "capturing") setPhase("old-ready");
    else if (phase === "switching" && voice.state === "idle") { voice.startPushToTalk(); setPhase("fresh-starting"); }
    else if (phase === "fresh-starting" && stats.acquisitions === 2 && stats.freshLive) setPhase("fresh-acquired");
    else if (phase === "fresh-acquired" && voice.state === "capturing") {
      const exact = stats.constraints[1]?.audio?.deviceId?.exact === "mac-input";
      if (exact && !stats.oldLive && stats.freshLive && stats.sttCount === 0) setPhase("passed");
    }
  }, [phase, stats, voice]);
  return <section style={{ maxWidth: 780, margin: "24px auto", padding: 24, fontFamily: "system-ui", color: "#e8eef7", background: "#111827", borderRadius: 20 }}>
    <h2>Discarded recorder device switch</h2>
    <button type="button" onClick={() => { setPhase("starting-old"); voice.startPushToTalk(); }} disabled={phase !== "ready"}>Start discardable capture</button>
    <button type="button" onClick={() => { setPhase("switching"); void voice.updateConfig({ micDeviceId: "mac-input" }, { persist: false }); }} disabled={phase !== "old-ready"}>Select built-in during capture</button>
    <button type="button" onClick={runtime.controls.finishOldRecorder} disabled={!stats.oldRecorderPending}>Finish discarded recorder</button>
    <h3 data-testid="discarded-switch-status">{phase} · {voice.state}</h3>
    <output data-testid="discarded-switch-stats">requests {stats.acquisitions}; old {stats.oldLive ? "live" : "stopped"}; fresh {stats.freshLive ? "live" : "stopped"}; selected {stats.constraints[1]?.audio?.deviceId?.exact || "none"}; STT {stats.sttCount}</output>
  </section>;
}

function CommittedPttLossControls({ runtime }) {
  const voice = useVoice(), [phase, setPhase] = useState("ready"), [stats, setStats] = useState(runtime.controls.getStats());
  useEffect(() => runtime.controls.subscribe(setStats), [runtime]);
  useEffect(() => {
    if (phase === "starting" && voice.state === "capturing") setPhase("capturing");
    else if (phase === "submitted" && stats.sttCount === 1 && voice.transcript.some((entry) => entry.text === "Committed PTT reply preserved.")) setPhase("passed");
  }, [phase, stats, voice]);
  const submitAndLose = () => {
    setPhase("submitted");
    voice.stopPushToTalk();
    runtime.controls.loseOldMicrophone();
  };
  return <section style={{ maxWidth: 780, margin: "24px auto", padding: 24, fontFamily: "system-ui", color: "#e8eef7", background: "#111827", borderRadius: 20 }}>
    <h2>Committed PTT microphone loss</h2>
    <button type="button" onClick={() => { setPhase("starting"); voice.startPushToTalk(); }} disabled={phase !== "ready"}>Start loss-boundary PTT</button>
    <button type="button" onClick={submitAndLose} disabled={phase !== "capturing"}>Release as microphone disconnects</button>
    <button type="button" onClick={runtime.controls.finishOldRecorder} disabled={!stats.oldRecorderPending}>Finish loss-boundary recorder</button>
    <h3 data-testid="ptt-loss-status">{phase} · {voice.state}</h3>
    <output data-testid="ptt-loss-stats">STT {stats.sttCount}; old {stats.oldLive ? "live" : "stopped"}; pending {stats.oldRecorderPending ? "yes" : "no"}</output>
  </section>;
}

function createCommittedVadRuntime({ failRecovery = false } = {}) {
  const listeners = new Set(); let callbacks = null, sttCount = 0, sttBytes = 0, acquisitions = 0, activeTrack = null;
  const Context = window.AudioContext || window.webkitAudioContext;
  const stats = () => ({ sttCount, sttBytes, acquisitions });
  const emit = () => listeners.forEach((listener) => listener(stats()));
  const getUserMedia = async () => {
    acquisitions += 1; emit();
    if (failRecovery && acquisitions > 1) throw new Error("Synthetic replacement unavailable");
    const destination = new Context().createMediaStreamDestination();
    const nativeTrack = destination.stream.getAudioTracks()[0], target = new EventTarget();
    let stopped = false;
    activeTrack = {
      id: `vad-mic-${acquisitions}`,
      kind: "audio",
      enabled: true,
      get readyState() { return stopped ? "ended" : nativeTrack.readyState; },
      stop() { stopped = true; nativeTrack.stop(); },
      addEventListener: (...args) => target.addEventListener(...args),
      removeEventListener: (...args) => target.removeEventListener(...args),
      lose() { stopped = true; target.dispatchEvent(new Event("ended")); },
    };
    Object.defineProperty(destination.stream, "getTracks", { configurable: true, value: () => [activeTrack] });
    Object.defineProperty(destination.stream, "getAudioTracks", { configurable: true, value: () => [activeTrack] });
    return destination.stream;
  };
  const fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith("/api/voice/stt")) { const file = init.body?.get?.("file"); sttCount += 1; sttBytes = file?.size || 0; emit(); return Response.json({ text: "Committed continuous utterance", confidence: 1 }); }
    if (url.endsWith("/api/voice/chat") && init.method === "POST") return Response.json({ response: "Committed reply preserved." });
    if (url.endsWith("/api/voice/status")) return Response.json({ status: "running", config: { enabled: true, autoSpeak: false, micDeviceId: "" } });
    if (url.endsWith("/api/voice/voices")) return Response.json({ voices: [] });
    if (url.includes("/api/voice/activity")) return Response.json({ items: [] });
    return new Response(null, { status: 204 });
  };
  return {
    storage: memoryStorage(), mediaDevices: { getUserMedia }, AudioContext: Context, MediaRecorder: window.MediaRecorder, Audio: window.Audio, fetch,
    createSpeechDetector: async (options) => {
      callbacks = options;
      const detector = { start: async () => options.onFrameProcessed?.({ isSpeech: 0, notSpeech: 1 }, new Float32Array([0.01])), pause: async () => {}, destroy: async () => {} };
      await detector.start();
      return detector;
    },
    controls: {
      beginSpeech: () => callbacks?.onSpeechRealStart?.(),
      endSpeech: () => { const audio = new Float32Array(16000); for (let index = 0; index < audio.length; index += 1) audio[index] = Math.sin(index / 16000 * Math.PI * 440) * 0.2; callbacks?.onSpeechEnd?.(audio); },
      loseMicrophone: () => activeTrack?.lose?.(),
      getStats: stats,
      subscribe(listener) { listeners.add(listener); listener(stats()); return () => listeners.delete(listener); },
    },
  };
}

function CommittedVadLossControls({ runtime }) {
  const voice = useVoice(), [phase, setPhase] = useState("ready"), [stats, setStats] = useState(runtime.controls.getStats());
  useEffect(() => runtime.controls.subscribe(setStats), [runtime]);
  useEffect(() => {
    if (phase === "starting" && voice.state === "listening") setPhase("listening");
    else if (phase === "speech" && voice.state === "capturing") setPhase("capturing");
    else if (phase === "submitted" && stats.acquisitions === 2 && stats.sttCount === 1 && stats.sttBytes > 100 && voice.transcript.some((entry) => entry.text === "Committed reply preserved.")) setPhase("passed");
  }, [phase, stats, voice]);
  const commitAndLose = () => {
    setPhase("submitted");
    runtime.controls.endSpeech();
    runtime.controls.loseMicrophone();
  };
  return <section style={{ maxWidth: 780, margin: "24px auto", padding: 24, fontFamily: "system-ui", color: "#e8eef7", background: "#111827", borderRadius: 20 }}>
    <h2>Committed continuous microphone loss</h2>
    <button type="button" onClick={() => { setPhase("starting"); voice.toggleContinuous(); }} disabled={phase !== "ready"}>Start continuous loss fixture</button>
    <button type="button" onClick={() => { setPhase("speech"); runtime.controls.beginSpeech(); }} disabled={phase !== "listening"}>Begin loss-boundary speech</button>
    <button type="button" onClick={commitAndLose} disabled={phase !== "capturing"}>End speech as microphone disconnects</button>
    <h3 data-testid="vad-loss-status">{phase} · {voice.state}</h3>
    <output data-testid="vad-loss-stats">requests {stats.acquisitions}; STT {stats.sttCount}; bytes {stats.sttBytes}</output>
  </section>;
}

function CommittedVadSwitchControls({ runtime }) {
  const voice = useVoice(), [phase, setPhase] = useState("ready"), [stats, setStats] = useState(runtime.controls.getStats());
  useEffect(() => runtime.controls.subscribe(setStats), [runtime]);
  useEffect(() => {
    if (phase === "starting" && voice.state === "listening") setPhase("listening");
    else if (phase === "speech-started" && voice.state === "capturing") setPhase("capturing");
    else if (phase === "submitted" && stats.sttCount === 1 && stats.sttBytes > 100 && voice.transcript.some((entry) => entry.text === "Committed reply preserved.")) setPhase("passed");
  }, [phase, stats, voice]);
  const start = () => { setPhase("starting"); voice.toggleContinuous(); };
  const begin = () => { runtime.controls.beginSpeech(); setPhase("speech-started"); };
  const commitAndSwitch = () => {
    runtime.controls.endSpeech();
    void voice.updateConfig({ micDeviceId: "mac-input" }, { persist: false });
    setPhase("submitted");
  };
  return <section style={{ maxWidth: 780, margin: "24px auto 48px", padding: 24, fontFamily: "system-ui", color: "#e8eef7", background: "#111827", borderRadius: 20 }}>
    <h2>Committed continuous capture switch</h2>
    <button type="button" onClick={start} disabled={phase !== "ready"}>Start conversation capture</button>
    <button type="button" onClick={begin} disabled={phase !== "listening"}>Begin synthetic speech</button>
    <button type="button" onClick={commitAndSwitch} disabled={phase !== "capturing"}>End speech and select built-in microphone</button>
    <h3 data-testid="vad-switch-status">{phase} · {voice.state}</h3>
    <output data-testid="vad-switch-stats">STT {stats.sttCount}; bytes {stats.sttBytes}</output>
  </section>;
}

function createMicRecoveryRuntime({ deferRecovery = false, deferReplacementReady = false } = {}) {
  const listeners = new Set(), constraints = [], streams = [], detectors = [], activityTitles = [];
  const pending = [];
  let signalReplacementReady = null;
  const stats = () => ({
    acquisitions: constraints.length,
    constraints: structuredClone(constraints),
    streams: streams.map((entry) => ({ stopped: entry.stopped })),
    detectors: detectors.map((entry) => ({ streamIndex: entry.streamIndex, destroyed: entry.destroyed })),
    activityTitles: [...activityTitles],
  });
  const emit = () => listeners.forEach((listener) => listener(stats()));
  const createStream = () => {
    const streamIndex = streams.length;
    const target = new EventTarget();
    const entry = { stopped: false, stream: null, track: null, dispatchEnded: null };
    const track = {
      id: `recovery-mic-${streamIndex}`,
      kind: "audio",
      enabled: true,
      get readyState() { return entry.stopped ? "ended" : "live"; },
      stop() { entry.stopped = true; emit(); },
      addEventListener: (...args) => target.addEventListener(...args),
      removeEventListener: (...args) => target.removeEventListener(...args),
      get onended() { return entry.onended || null; },
      set onended(handler) { entry.onended = handler; },
    };
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
    entry.stream = stream; entry.track = track; entry.dispatchEnded = () => target.dispatchEvent(new Event("ended")); streams.push(entry); emit();
    return stream;
  };
  const getUserMedia = (request) => {
    const requestIndex = constraints.length;
    constraints.push(structuredClone(request)); emit();
    if (deferRecovery && requestIndex === 1) {
      return new Promise((resolve) => pending.push(() => resolve(createStream())));
    }
    return Promise.resolve(createStream());
  };
  const fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith("/api/voice/status")) return Response.json({ status: "running", config: { enabled: true, autoSpeak: false, micDeviceId: "" } });
    if (url.endsWith("/api/voice/voices")) return Response.json({ voices: [] });
    if (url.includes("/api/voice/activity")) {
      if (init.method === "POST") {
        const event = JSON.parse(init.body || "{}");
        if (event.title) activityTitles.push(event.title);
        emit();
        return Response.json({ ok: true });
      }
      return Response.json({ items: [] });
    }
    return new Response(null, { status: 204 });
  };
  return {
    storage: memoryStorage(), mediaDevices: { getUserMedia }, AudioContext: window.AudioContext || window.webkitAudioContext,
    MediaRecorder: window.MediaRecorder, Audio: window.Audio, fetch,
    createSpeechDetector: async (options) => {
      const detectorEntry = { streamIndex: streams.findIndex((entry) => entry.stream === options.stream), destroyed: false };
      detectors.push(detectorEntry); emit();
      const detector = {
        start: async () => {
          const ready = () => options.onFrameProcessed?.({ isSpeech: 0, notSpeech: 1 }, new Float32Array([0.01]));
          if (deferReplacementReady && detectorEntry.streamIndex === 1) signalReplacementReady = ready;
          else ready();
        },
        pause: async () => {},
        destroy: async () => { detectorEntry.destroyed = true; emit(); },
      };
      await detector.start();
      return detector;
    },
    controls: {
      loseStream(index = 0) {
        const entry = streams[index];
        if (!entry) return;
        entry.stopped = true;
        entry.dispatchEnded();
        emit();
      },
      signalReplacementReady() { const signal = signalReplacementReady; signalReplacementReady = null; signal?.(); },
      resolveRecovery() { pending.shift()?.(); },
      getStats: stats,
      subscribe(listener) { listeners.add(listener); listener(stats()); return () => listeners.delete(listener); },
    },
  };
}

function MicRecoveryControls({ runtime, mode }) {
  const voice = useVoice(), [phase, setPhase] = useState("ready"), [stats, setStats] = useState(runtime.controls.getStats());
  useEffect(() => runtime.controls.subscribe(setStats), [runtime]);
  useEffect(() => {
    if (phase === "starting" && voice.state === "listening") setPhase("listening");
    else if (phase === "recovering" && stats.acquisitions >= 2) setPhase("recovery-pending");
    else if (phase === "awaiting-success" && voice.state === "listening") setPhase("passed");
    else if (phase === "awaiting-stale" && stats.streams[1]?.stopped && voice.state === "idle") setPhase(mode === "select" ? "stale-stopped" : "passed");
    else if (phase === "fresh-starting" && voice.state === "listening") setPhase("passed");
  }, [mode, phase, stats, voice.state]);
  const start = () => { setPhase("starting"); voice.toggleContinuous(); };
  const lose = () => { setPhase(mode === "success" ? "awaiting-success" : "recovering"); runtime.controls.loseStream(0); };
  const interruptRecovery = () => {
    if (mode === "select") void voice.updateConfig({ micDeviceId: "mac-input" }, { persist: false });
    else voice.cancelCurrent();
    setPhase("awaiting-stale");
    runtime.controls.resolveRecovery();
  };
  const startSelected = () => { setPhase("fresh-starting"); voice.toggleContinuous(); };
  const title = mode === "success" ? "Successful microphone loss recovery" : mode === "select" ? "Selected-input recovery cancellation" : "Explicit recovery cancellation";
  return <section style={{ maxWidth: 780, margin: "24px auto", padding: 24, fontFamily: "system-ui", color: "#e8eef7", background: "#111827", borderRadius: 20 }}>
    <h2>{title}</h2>
    <button type="button" onClick={start} disabled={phase !== "ready"}>Start recovery fixture</button>
    <button type="button" onClick={lose} disabled={phase !== "listening"}>Disconnect synthetic microphone</button>
    {mode !== "success" ? <button type="button" onClick={interruptRecovery} disabled={phase !== "recovery-pending"}>{mode === "select" ? "Select built-in during recovery" : "Cancel microphone recovery"}</button> : null}
    {mode === "success" ? <button type="button" onClick={runtime.controls.signalReplacementReady} disabled={phase !== "awaiting-success" || stats.detectors.length < 2}>Signal replacement detector ready</button> : null}
    {mode === "select" ? <button type="button" onClick={startSelected} disabled={phase !== "stale-stopped"}>Start selected microphone</button> : null}
    <h3 data-testid={`mic-recovery-${mode}-status`}>{phase} · {voice.state}</h3>
    <output data-testid={`mic-recovery-${mode}-stats`}>requests {stats.acquisitions}; streams {stats.streams.map((entry) => entry.stopped ? "stopped" : "live").join(",") || "none"}; detectors {stats.detectors.map((entry) => `${entry.streamIndex}:${entry.destroyed ? "destroyed" : "active"}`).join(",") || "none"}; reconnected {stats.activityTitles.filter((title) => title === "Microphone reconnected").length}; selected {stats.constraints.at(-1)?.audio?.deviceId?.exact || "default"}</output>
  </section>;
}

export default function VoiceLifecycleFixture() {
  const runtime = useMemo(() => createSyntheticRuntime(), []), deferred = useMemo(() => createDeferredRuntime(), []), microphoneSwitch = useMemo(() => createMicrophoneSwitchRuntime(), []), unsubmittedSwitch = useMemo(() => createMicrophoneSwitchRuntime(), []), committedPttLoss = useMemo(() => createMicrophoneSwitchRuntime(), []), committedVad = useMemo(() => createCommittedVadRuntime(), []), committedVadLoss = useMemo(() => createCommittedVadRuntime({ failRecovery: true }), []), recoverySuccess = useMemo(() => createMicRecoveryRuntime({ deferReplacementReady: true }), []), recoveryCancel = useMemo(() => createMicRecoveryRuntime({ deferRecovery: true }), []), recoverySelect = useMemo(() => createMicRecoveryRuntime({ deferRecovery: true }), []);
  return <><VoiceProvider testRuntime={runtime}><FixtureControls /></VoiceProvider><VoiceProvider testRuntime={deferred}><DeferredPermissionControls controls={deferred.controls} /></VoiceProvider><VoiceProvider testRuntime={unsubmittedSwitch}><UnsubmittedMicrophoneSwitchControls runtime={unsubmittedSwitch} /></VoiceProvider><VoiceProvider testRuntime={microphoneSwitch}><MicrophoneSwitchControls runtime={microphoneSwitch} /></VoiceProvider><VoiceProvider testRuntime={committedPttLoss}><CommittedPttLossControls runtime={committedPttLoss} /></VoiceProvider><VoiceProvider testRuntime={committedVad}><CommittedVadSwitchControls runtime={committedVad} /></VoiceProvider><VoiceProvider testRuntime={committedVadLoss}><CommittedVadLossControls runtime={committedVadLoss} /></VoiceProvider><VoiceProvider testRuntime={recoverySuccess}><MicRecoveryControls runtime={recoverySuccess} mode="success" /></VoiceProvider><VoiceProvider testRuntime={recoveryCancel}><MicRecoveryControls runtime={recoveryCancel} mode="cancel" /></VoiceProvider><VoiceProvider testRuntime={recoverySelect}><MicRecoveryControls runtime={recoverySelect} mode="select" /></VoiceProvider></>;
}
