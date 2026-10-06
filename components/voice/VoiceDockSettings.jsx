"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { VOICE_REASONING_OPTIONS } from "@/components/voice/voiceModelOptions.js";
import VoiceModelPicker from "@/components/voice/VoiceModelPicker.jsx";

const ELEVENLABS_PRESETS = [
  { id: "pFZP5JQG7iQjIQuC4Bku", name: "Lily", note: "Velvety British female · narrator (current)" },
  { id: "Xb7hH8MSUJpSbSDYk0k2", name: "Alice", note: "Clear, engaging British female" },
  { id: "cgSgspJ2msm6clMCkdW9", name: "Jessica", note: "Playful, bright young female" },
  { id: "XrExE9yKIg1WjnnlVkGX", name: "Matilda", note: "Knowledgeable, professional female" },
  { id: "FGY2WhTYpPnrIDTdsKH5", name: "Laura", note: "Sunny, quirky young female" },
  { id: "SAz9YHcvj6GT2YYXdXww", name: "River", note: "Relaxed, neutral, gender-neutral narrator" },
  { id: "cjVigY5qzO86Huf0OWal", name: "Eric", note: "Smooth, agentic conversational male" },
  { id: "nPczCjzI2devNBz1zQrb", name: "Brian", note: "Deep, resonant, comforting male" },
  { id: "bIHbv24MWmeRgasZH58o", name: "Will", note: "Relaxed, optimistic young male" },
  { id: "iP95p4xoKVk53GoZ742B", name: "Chris", note: "Charming, down-to-earth male" },
  { id: "IKne3meq5aSn9XLyUdCD", name: "Charlie", note: "Confident young Australian male" },
  { id: "JBFqnCBsd6RMkjVDRZzb", name: "George", note: "Warm British male storyteller" },
  { id: "onwK4e9ZLuTAKqWW03F9", name: "Daniel", note: "Steady British male broadcaster" },
  { id: "TX3LPaxmHKxFdv7VOQHJ", name: "Liam", note: "Energetic, social-media male" },
  { id: "pNInz6obpgDQGcFmaJgB", name: "Adam", note: "Firm, dominant male" },
  { id: "pqHfZKP75CvOlQylNhV4", name: "Bill", note: "Wise older male narrator" },
  { id: "N2lVS1w4EtoT3dr4eOWO", name: "Callum", note: "Husky, gravelly character voice" },
  { id: "SOYHLrjzK2X1ezoPC6cr", name: "Harry", note: "Animated, fierce character voice" },
];


/** The microphone is acquired only after the user chooses Test microphone. */
function MicMeter({ deviceId, onError }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    let stream;
    let context;
    let frame = 0;
    let cancelled = false;
    const release = () => {
      if (frame) cancelAnimationFrame(frame);
      stream?.getTracks().forEach((track) => track.stop());
      if (context?.state !== "closed") context?.close().catch(() => {});
    };

    async function start() {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("Microphone testing is unavailable in this browser.");
        }
        stream = await navigator.mediaDevices.getUserMedia({
          audio: deviceId ? { deviceId: { exact: deviceId } } : true,
        });
        if (cancelled) { release(); return; }
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        context = new AudioContext();
        await context.resume();
        if (cancelled) { release(); return; }
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        context.createMediaStreamSource(stream).connect(analyser);
        const samples = new Uint8Array(analyser.fftSize);
        const canvas = canvasRef.current;
        const drawing = canvas?.getContext("2d");
        if (!drawing) { release(); return; }
        const density = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.max(1, canvas.clientWidth * density);
        canvas.height = Math.max(1, canvas.clientHeight * density);
        const meterStyles = getComputedStyle(canvas);
        const meterTrack = meterStyles.getPropertyValue("--voice-meter-track").trim();
        const meterLevel = meterStyles.getPropertyValue("--voice-meter-level").trim();
        let previousFrame = 0;
        const draw = (time) => {
          if (cancelled) return;
          if (time - previousFrame >= 50) {
            previousFrame = time;
            analyser.getByteTimeDomainData(samples);
            const squared = samples.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0);
            const level = Math.min(1, Math.sqrt(squared / samples.length) * 4);
            drawing.fillStyle = meterTrack;
            drawing.fillRect(0, 0, canvas.width, canvas.height);
            drawing.fillStyle = meterLevel;
            drawing.fillRect(0, 0, canvas.width * level, canvas.height);
          }
          frame = requestAnimationFrame(draw);
        };
        frame = requestAnimationFrame(draw);
      } catch (error) {
        release();
        if (!cancelled) onError(error.name === "NotAllowedError"
          ? "Microphone access was denied. Allow access in your browser settings, then try again."
          : error.name === "NotFoundError"
          ? "No microphone was found. Connect a microphone and try again."
          : error.message || "The microphone could not be started. Check your input device.");
      }
    }
    start();
    return () => { cancelled = true; release(); };
  }, [deviceId, onError]);

  return <canvas ref={canvasRef} className="dockSettings__meter" aria-label="Microphone input level" role="img" />;
}

export default function VoiceDockSettings({ voice, embedded = false }) {
  const [devices, setDevices] = useState({ inputs: [], outputs: [] });
  const [testingMic, setTestingMic] = useState(false);
  const [micError, setMicError] = useState("");
  const [supportsSinkId, setSupportsSinkId] = useState(false);
  const cfg = voice?.config ?? {};

  // Enumeration does not request permission or open the microphone.
  useEffect(() => {
    let cancelled = false;
    const media = navigator.mediaDevices;
    setSupportsSinkId(typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype);
    async function readDevices() {
      try {
        const all = await media?.enumerateDevices();
        if (cancelled || !all) return;
        setDevices({
          inputs: all.filter((device) => device.kind === "audioinput" && device.deviceId),
          outputs: all.filter((device) => device.kind === "audiooutput" && device.deviceId),
        });
      } catch { /* System defaults remain usable when enumeration is unavailable. */ }
    }
    readDevices();
    media?.addEventListener?.("devicechange", readDevices);
    return () => {
      cancelled = true;
      media?.removeEventListener?.("devicechange", readDevices);
    };
  }, [testingMic]);

  const voiceKnown = ELEVENLABS_PRESETS.some((preset) => preset.id === cfg.elevenlabsVoiceId);

  return (
    <div className={`voiceSettings__quick${embedded ? " voiceSettings__quick--embedded" : ""}`}>
      <div className="dockSettings">
        <div className="dockSettings__row">
          <label className="dockSettings__field">
            <span>Hermes voice</span>
            <select value={cfg.elevenlabsVoiceId || ""} onChange={(event) => voice.updateConfig({ elevenlabsVoiceId: event.target.value })}>
              {!voiceKnown ? <option value={cfg.elevenlabsVoiceId || ""}>{cfg.elevenlabsVoiceId ? "Custom voice" : "Choose a voice"}</option> : null}
              {ELEVENLABS_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.name} · {preset.note.replace(" (current)", "")}</option>)}
            </select>
          </label>
        </div>
        <div className="dockSettings__row dockSettings__modelRow">
          <VoiceModelPicker voice={voice} />
          <label className="dockSettings__field">
            <span>Reasoning effort</span>
            <select value={cfg.voiceReasoningEffort || "low"} onChange={(event) => voice.updateConfig({ voiceReasoningEffort: event.target.value })}>
              {VOICE_REASONING_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </label>
        </div>
        <div className="dockSettings__row dockSettings__row--two">
          <label className="dockSettings__field">
            <span>Microphone</span>
            <select value={cfg.micDeviceId || ""} onChange={(event) => voice.updateConfig({ micDeviceId: event.target.value })}>
              <option value="">System default</option>
              {cfg.micDeviceId && !devices.inputs.some((device) => device.deviceId === cfg.micDeviceId) ? <option value={cfg.micDeviceId}>Saved microphone</option> : null}
              {devices.inputs.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}
            </select>
          </label>
          <label className="dockSettings__field">
            <span>Speaker</span>
            <select value={cfg.speakerDeviceId || ""} onChange={(event) => voice.updateConfig({ speakerDeviceId: event.target.value })} disabled={!supportsSinkId} title={!supportsSinkId ? "This browser uses your system output device." : "Output device for spoken replies"}>
              <option value="">System default</option>
              {cfg.speakerDeviceId && !devices.outputs.some((device) => device.deviceId === cfg.speakerDeviceId) ? <option value={cfg.speakerDeviceId}>Saved speaker</option> : null}
              {devices.outputs.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Speaker ${index + 1}`}</option>)}
            </select>
          </label>
        </div>
        <div className="dockSettings__toggles">
          <div className="dockSettings__toggleField">
            <span>Speak replies automatically</span>
            <button type="button" className={`dockSettings__toggle${cfg.autoSpeak !== false ? " is-on" : ""}`} onClick={() => voice.updateConfig({ autoSpeak: !(cfg.autoSpeak !== false) })} aria-pressed={cfg.autoSpeak !== false} aria-label="Speak replies automatically">{cfg.autoSpeak !== false ? "On" : "Off"}</button>
          </div>
          <div className="dockSettings__toggleField">
            <span>Mute output</span>
            <button type="button" className={`dockSettings__toggle${cfg.muteOutput ? " is-on" : ""}`} onClick={() => voice.updateConfig({ muteOutput: !cfg.muteOutput })} aria-pressed={!!cfg.muteOutput} aria-label="Mute output">{cfg.muteOutput ? "On" : "Off"}</button>
          </div>
        </div>
        <div className="dockSettings__meterRow">
          <button type="button" className="voiceSettings__button" aria-pressed={testingMic} onClick={() => { setMicError(""); setTestingMic((current) => !current); }}>{testingMic ? "Stop microphone test" : "Test microphone"}</button>
          {testingMic && !micError ? <MicMeter deviceId={cfg.micDeviceId || ""} onError={setMicError} /> : <span className="dockSettings__meterLabel">{micError ? "Test unavailable" : "Check your input level"}</span>}
        </div>
        {micError ? <p className="voiceSettings__inlineError" role="alert">{micError}</p> : null}
        {voice?.configSaveStatus && voice.configSaveStatus !== "idle" ? <p className={`voiceSettings__saveStatus${voice.configSaveStatus === "error" ? " is-error" : ""}`} role={voice.configSaveStatus === "error" ? "alert" : "status"}>{voice.configSaveStatus === "saving" ? "Saving your change…" : voice.configSaveStatus === "error" ? voice.configSaveError || "Could not save your last change. Try that setting again." : "Last change saved."}</p> : null}
        {!embedded ? <Link href="/voice" className="dockSettings__moreLink">All voice settings <span aria-hidden="true">↗</span></Link> : null}
      </div>
    </div>
  );
}

export { ELEVENLABS_PRESETS };
