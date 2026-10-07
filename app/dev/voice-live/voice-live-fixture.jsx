"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import VoiceProvider, { useVoice } from "../../../components/voice/VoiceProvider.jsx";

const WORKING_DIRECTORY = "/tmp/hermes-voice-demo-zwxFwx";
const PROMPTS = [
  { file: "/voice-fixtures/live-demo-greeting.wav", label: "Greeting", text: "Hi Hermes, how are you today?" },
  { file: "/voice-fixtures/live-demo-orchid.wav", label: "ORCHID terminal action", text: "Use your terminal tool to print the word ORCHID. Tell me the result in one short sentence." },
  { file: "/voice-fixtures/live-demo-overlap.wav", label: "Stream while tool runs", text: "First say, I am checking the timer now. Then use your terminal to run sleep 6 followed by printf READY. After it finishes, tell me the result. Do not use other tools." },
  { file: "/voice-fixtures/live-demo-rain.wav", label: "Long streamed answer", text: "Explain how rain forms in thirty short numbered sentences. Start with Rain begins with water. Do not use tools." },
];
const card = { background: "#121d2e", border: "1px solid #263650", borderRadius: 16, padding: 20, marginTop: 16 };
const muted = { color: "#9aaac0", lineHeight: 1.5 };
const button = { background: "#34d399", color: "#06130f", border: 0, borderRadius: 9, padding: "10px 14px", font: "inherit", fontWeight: 800, cursor: "pointer" };
const disabled = { ...button, background: "#263650", color: "#8292a9", cursor: "not-allowed" };

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) };
}

function createRuntime() {
  const subscribers = new Set();
  const data = { acquisitions: 0, states: [], activities: [], requests: [], turns: [] };
  const seenActivityIds = new Set();
  let context = null, destination = null, activeTurn = null, previousState = "idle";
  const now = () => performance.now();
  const snapshot = () => ({ ...data, states: [...data.states], activities: [...data.activities], requests: [...data.requests], turns: data.turns.map((turn) => ({ ...turn, requests: [...turn.requests] })) });
  const emit = () => { const value = snapshot(); subscribers.forEach((listener) => listener(value)); };

  const getUserMedia = async () => {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("This browser does not support AudioContext.");
    if (!context || context.state === "closed") context = new AudioContextClass();
    await context.resume();
    destination = context.createMediaStreamDestination();
    data.acquisitions += 1;
    emit();
    return destination.stream;
  };

  const fetchThrough = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = String(init.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    const route = url.includes("/api/voice/stt") ? "STT" : url.includes("/api/voice/chat") && method === "POST" ? "Hermes chat" : url.includes("/api/voice/tts") ? "TTS" : url.includes("/api/voice/runs") ? "Run status" : null;
    if (!route) return globalThis.fetch(input, init);
    const startedAt = now(), request = { route, method, startedAt, elapsedMs: null, status: "pending" };
    data.requests.push(request);
    if (activeTurn) activeTurn.requests.push(request);
    emit();
    try {
      const response = await globalThis.fetch(input, init);
      request.status = response.status;
      request.elapsedMs = Math.round(now() - startedAt);
      emit();
      return response;
    } catch (error) {
      request.status = "network error";
      request.elapsedMs = Math.round(now() - startedAt);
      emit();
      throw error;
    }
  };

  return {
    storage: memoryStorage(), mediaDevices: { getUserMedia },
    AudioContext: typeof window === "undefined" ? null : (window.AudioContext || window.webkitAudioContext),
    MediaRecorder: typeof window === "undefined" ? null : window.MediaRecorder,
    Audio: typeof window === "undefined" ? null : window.Audio,
    fetch: fetchThrough,
    subscribe(listener) { subscribers.add(listener); listener(snapshot()); return () => subscribers.delete(listener); },
    beginTurn(index) {
      activeTurn = { index, label: PROMPTS[index].label, startedAt: now(), inputStart: null, speechStart: null, speechEnd: null, firstAudioSummary: "", result: "", error: "", requests: [] };
      data.turns.push(activeTurn); emit();
    },
    async playPrompt(index) {
      if (!context || !destination) throw new Error("Start the synthetic voice session first.");
      const response = await globalThis.fetch(PROMPTS[index].file, { cache: "no-store" });
      if (!response.ok) throw new Error(`Prompt audio could not load (${response.status}).`);
      const decoded = await context.decodeAudioData((await response.arrayBuffer()).slice(0));
      if (context.state !== "running") await context.resume();
      const source = context.createBufferSource();
      source.buffer = decoded; source.connect(destination);
      activeTurn.inputStart = now() + 350;
      source.start(context.currentTime + 0.35);
      emit();
    },
    recordState(state) {
      const at = now();
      if (state === previousState) return;
      data.states.push({ state, at });
      if (activeTurn) {
        if (state === "capturing" && activeTurn.speechStart === null) activeTurn.speechStart = at;
        if (state === "transcribing" && previousState === "capturing" && activeTurn.speechEnd === null) activeTurn.speechEnd = at;
      }
      previousState = state; emit();
    },
    recordActivity(event) {
      const id = String(event.id || "");
      if (id && seenActivityIds.has(id)) return;
      if (id) {
        seenActivityIds.add(id);
        if (seenActivityIds.size > 300) seenActivityIds.delete(seenActivityIds.values().next().value);
      }
      const item = { id, title: String(event.title || "Voice activity"), summary: String(event.summary || ""), source: String(event.source || ""), at: now() };
      data.activities.push(item);
      if (activeTurn && item.title === "Answer audio started" && !activeTurn.firstAudioSummary) {
        activeTurn.firstAudioSummary = item.summary;
        activeTurn.firstAudioWhilePending = Boolean(event.requestPending);
        activeTurn.firstAudioAt = item.at;
      }
      emit();
    },
    reset(state) {
      data.states = []; data.activities = []; data.requests = []; data.turns = [];
      seenActivityIds.clear(); activeTurn = null; previousState = state || "idle";
      emit();
    },
    setResult(index, result) { const turn = data.turns.find((item) => item.index === index); if (turn) { turn.result = result; emit(); } },
    setError(index, error) { const turn = data.turns.find((item) => item.index === index); if (turn) { turn.error = error; emit(); } },
    close() { try { destination?.stream.getTracks().forEach((track) => track.stop()); } catch {} if (context && context.state !== "closed") void context.close().catch(() => {}); },
    snapshot,
  };
}

function VoiceLiveControls({ runtime, session, config }) {
  const voice = useVoice();
  const [data, setData] = useState(runtime.snapshot());
  const [activeIndex, setActiveIndex] = useState(null), [nextPrompt, setNextPrompt] = useState(0), [error, setError] = useState("");
  const baseline = useRef(new Map());

  useEffect(() => runtime.subscribe(setData), [runtime]);
  useEffect(() => {
    const onActivity = (event) => { if (event.detail?.sessionId === session.id) runtime.recordActivity({ ...event.detail, requestPending: voice.requestPending }); };
    window.addEventListener("voice-activity", onActivity);
    return () => window.removeEventListener("voice-activity", onActivity);
  }, [runtime, session.id, voice.requestPending]);
  useEffect(() => runtime.recordState(voice.state), [runtime, voice.state]);
  useEffect(() => () => runtime.close(), [runtime]);
  useEffect(() => {
    if (activeIndex === null) return;
    const entries = (voice.transcript || []).slice(baseline.current.get(activeIndex) || 0);
    const user = entries.find((entry) => entry.role === "user" && !entry.pending && !entry.isError);
    const answer = entries.find((entry) => ["hermes", "assistant"].includes(entry.role) && !entry.pending && !entry.isError);
    if (user && answer) {
      const text = String(answer.text || answer.content || "").trim();
      if (text) runtime.setResult(activeIndex, text);
      if (["listening", "idle"].includes(voice.state) && !voice.requestPending) { setNextPrompt(activeIndex + 1); setActiveIndex(null); }
    }
  }, [activeIndex, runtime, voice.state, voice.requestPending, voice.transcript]);
  useEffect(() => {
    if (activeIndex === null || voice.state !== "error") return;
    const message = voice.lastError?.message || voice.lastError?.code || "Voice request failed.";
    runtime.setError(activeIndex, message); setError(message); setActiveIndex(null);
  }, [activeIndex, runtime, voice.lastError, voice.state]);

  const start = () => { setError(""); voice.primeAudioStack(); voice.toggleContinuous(); };
  const stop = () => {
    if (activeIndex !== null) runtime.setError(activeIndex, "Interrupted by Stop; reset turns to replay.");
    setActiveIndex(null);
    voice.toggleContinuous();
  };
  const reset = () => {
    if (activeIndex !== null && !["idle", "error"].includes(voice.state)) return;
    runtime.reset(voice.state); setNextPrompt(0); setError(""); setActiveIndex(null); baseline.current.clear();
  };
  const play = async (index) => {
    if (voice.state !== "listening" || activeIndex !== null) return;
    baseline.current.set(index, voice.transcript?.length || 0); runtime.beginTurn(index); setActiveIndex(index); setError("");
    try { await runtime.playPrompt(index); } catch (cause) { const message = cause.message || String(cause); runtime.setError(index, message); setError(message); setActiveIndex(null); }
  };
  const canPrompt = voice.state === "listening" && activeIndex === null;
  const lastTurn = data.turns.at(-1);
  const transcript = (voice.transcript || []).slice(-8);

  return <main style={{ maxWidth: 980, margin: "30px auto", padding: "0 18px 40px", color: "#e5edf8", fontFamily: "system-ui, sans-serif" }}>
    <p style={{ color: "#6ee7b7", fontWeight: 800, letterSpacing: ".12em", textTransform: "uppercase", fontSize: 12 }}>Dev only · real provider path</p>
    <h1 style={{ fontSize: 42, margin: "8px 0" }}>Real voice QA</h1>
    <p style={muted}>macOS <code>say</code> recordings pass through the production VAD and MediaRecorder via a synthetic audio stream. STT, Hermes tools, and TTS use the actual server routes. This page never requests the physical microphone.</p>
    <section style={card}>
      <b>Voice state:</b> {voice.state}　 <b>Runtime:</b> {voice.runtimeStatus || "idle"}　 <b>Server:</b> {voice.serverStatus}　 <b>Session:</b> {session.id.slice(0, 12)}…　 <b>Injected streams:</b> {data.acquisitions}
      <p style={muted}>Scratch working folder: <code>{session.workingDirectory}</code></p>
      <p style={muted}>Public config: {config?.sttBackend || "STT"} → Hermes ({config?.voiceModelProvider || "default"}/{config?.voiceModel || "configured model"}) → {config?.ttsBackend || "TTS"}</p>
      {voice.lastError ? <p role="alert" style={{ color: "#fca5a5" }}>{voice.lastError.code}: {voice.lastError.message}</p> : null}
      {voice.runtimeError ? <p role="alert" style={{ color: "#fca5a5" }}>{voice.runtimeError}</p> : null}
      {voice.state === "idle" || voice.state === "error" ? <button style={button} onClick={start}>Start synthetic mic</button> : <button style={button} onClick={stop}>Stop voice session</button>}
      <button style={{ ...button, marginLeft: 10 }} disabled={activeIndex !== null && !["idle", "error"].includes(voice.state)} onClick={reset}>Reset turns for replay</button>
    </section>
    <section style={card}>
      <h2>Run prompts in order</h2>
      {PROMPTS.map((prompt, index) => {
        const turn = data.turns.find((item) => item.index === index);
        const enabled = index === nextPrompt && canPrompt;
        return <div key={prompt.label} style={{ borderTop: "1px solid #263650", padding: "14px 0" }}>
          <b>{index + 1}. {prompt.label}</b><p style={{ color: "#bdcadb" }}>“{prompt.text}”</p>
          <button style={enabled ? button : disabled} disabled={!enabled} onClick={() => void play(index)}>{activeIndex === index ? "Running real voice turn…" : `Play ${prompt.label}`}</button>
          {turn?.result ? <p><b>Actual Hermes result:</b> {turn.result}</p> : null}
          {turn?.error ? <p role="alert" style={{ color: "#fca5a5" }}>{turn.error}</p> : null}
          {turn?.firstAudioSummary ? <p style={muted}><b>First audible answer:</b> {turn.firstAudioSummary} <b>while request pending:</b> {turn.firstAudioWhilePending ? "yes" : "no"}</p> : null}
        </div>;
      })}
      {nextPrompt === PROMPTS.length ? <p role="status" style={{ color: "#86efac", fontWeight: 800 }}>All live turns completed.</p> : null}
      {error ? <p role="alert" style={{ color: "#fca5a5" }}>{error}</p> : null}
    </section>
    <section style={card}>
      <h2>Observed timing</h2>
      {data.turns.map((turn) => {
        const stt = turn.requests.find((request) => request.route === "STT");
        const tts = turn.requests.filter((request) => request.route === "TTS");
        const time = (startAt, endAt) => Number.isFinite(startAt) && Number.isFinite(endAt) ? `${Math.round(endAt - startAt)} ms` : "—";
        return <p key={turn.index}><b>{turn.label}:</b> VAD capture {time(turn.speechStart, turn.speechEnd)}; speech end → STT response {time(turn.speechEnd, stt ? stt.startedAt + (stt.elapsedMs || 0) : null)}; TTS response(s) {tts.map((item) => `${item.status}/${item.elapsedMs ?? "…"}ms`).join(", ") || "—"}.</p>;
      })}
      <p style={muted}>The answer-audio activity reports speech-end → first audible playback from VoiceProvider. Provider request times are measured around real fetch calls.</p>
      <h3>Actual transcript</h3>
      {transcript.length ? transcript.map((entry) => <p key={entry.id}><b>{entry.role}:</b> {entry.text}</p>) : <p style={muted}>No speech has been processed yet.</p>}
      <h3>Voice activity and errors</h3>
      <ul>{data.activities.slice(-8).map((event, index) => <li key={`${event.at}-${index}`}><b>{event.title}:</b> {event.summary}</li>)}</ul>
      <p style={muted}>State path: {data.states.slice(-18).map((item) => item.state).join(" → ") || "Waiting for session start"}</p>
      <p style={muted}>Real API requests: {data.requests.slice(-12).map((item) => `${item.route} ${item.status} ${item.elapsedMs ?? "…"}ms`).join(" · ") || "none"}</p>
    </section>
  </main>;
}

function SessionSetup() {
  const [session, setSession] = useState(null), [config, setConfig] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const lock = useRef(false);
  const runtime = useMemo(() => session ? createRuntime() : null, [session?.id]);
  const prepare = async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try {
      const cfgResponse = await globalThis.fetch("/api/voice/chat", { cache: "no-store" });
      const cfg = await cfgResponse.json().catch(() => ({}));
      if (!cfgResponse.ok) throw new Error(cfg.error || "Could not load public voice configuration.");
      const response = await globalThis.fetch("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: `Voice live demo ${new Date().toISOString()}`, workingDirectory: WORKING_DIRECTORY }) });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || !json.session?.id) throw new Error(json.error || "Could not create an isolated work session.");
      setConfig(cfg.config || {}); setSession(json.session);
    } catch (cause) { setError(cause.message || String(cause)); }
    finally { lock.current = false; setBusy(false); }
  };
  if (!session || !runtime) return <main style={{ ...card, maxWidth: 900, margin: "48px auto", color: "#e5edf8", fontFamily: "system-ui, sans-serif" }}>
    <p style={{ color: "#6ee7b7", fontWeight: 800, letterSpacing: ".12em", textTransform: "uppercase", fontSize: 12 }}>Dev only · live provider path</p>
    <h1>Prepare real voice QA</h1><p style={muted}>Creates a new session via the existing Sessions API in <code>{WORKING_DIRECTORY}</code>. It does not load personal conversation history or request a microphone.</p>
    <button style={busy ? disabled : button} disabled={busy} onClick={() => void prepare()}>{busy ? "Preparing isolated session…" : "Create isolated session"}</button>
    {error ? <p role="alert" style={{ color: "#fca5a5" }}>{error}</p> : null}
  </main>;
  return <VoiceProvider testRuntime={runtime} sessionId={session.id} initialTranscript={[]} initialActiveRun={null}><VoiceLiveControls runtime={runtime} session={session} config={config} /></VoiceProvider>;
}

export default function VoiceLiveFixture() { return <SessionSetup />; }
