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
export default function VoiceLifecycleFixture() {
  const runtime = useMemo(() => createSyntheticRuntime(), []), deferred = useMemo(() => createDeferredRuntime(), []);
  return <><VoiceProvider testRuntime={runtime}><FixtureControls /></VoiceProvider><VoiceProvider testRuntime={deferred}><DeferredPermissionControls controls={deferred.controls} /></VoiceProvider></>;
}
