"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { microphoneConstraints } from "@/components/voice/voiceCapture.js";
import { microphoneCaptureActive, savedDeviceStatus } from "@/components/voice/voiceDeviceSettings.js";

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
const MIC_TEST_DURATION_MS = 15_000;

function MicMeter({ deviceId, onError, onFinished }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    let stream;
    let context;
    let frame = 0;
    let finishTimer = 0;
    let cancelled = false;
    const release = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (finishTimer) clearTimeout(finishTimer);
      finishTimer = 0;
      const activeStream = stream;
      stream = null;
      activeStream?.getTracks().forEach((track) => track.stop());
      const activeContext = context;
      context = null;
      if (activeContext && activeContext.state !== "closed") activeContext.close().catch(() => {});
    };
    finishTimer = window.setTimeout(() => {
      if (cancelled) return;
      cancelled = true;
      release();
      onFinished();
    }, MIC_TEST_DURATION_MS);

    async function start() {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("Microphone testing is unavailable in this browser.");
        }
        stream = await navigator.mediaDevices.getUserMedia(microphoneConstraints(deviceId));
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
        if (!cancelled) {
          onError(error.name === "NotAllowedError"
            ? "Microphone access was denied. Allow access in your browser settings, then try again."
            : ["NotFoundError", "OverconstrainedError"].includes(error.name)
            ? deviceId
              ? "The selected microphone is unavailable. Connect it or choose System default."
              : "No microphone was found. Connect a microphone and try again."
            : error.message || "The microphone could not be started. Check your input device.");
          onFinished();
        }
      }
    }
    start();
    return () => { cancelled = true; release(); };
  }, [deviceId, onError, onFinished]);

  return <canvas ref={canvasRef} className="dockSettings__meter" aria-label="Microphone input level" role="img" />;
}

export default function VoiceDockSettings({ voice, embedded = false }) {
  const idPrefix = useId();
  const microphoneHelpId = `${idPrefix}-microphone-help`;
  const speakerHelpId = `${idPrefix}-speaker-help`;
  const deviceGuidanceId = `${idPrefix}-device-guidance`;
  const microphoneTestStatusId = `${idPrefix}-microphone-test-status`;
  const [devices, setDevices] = useState({ inputs: [], outputs: [] });
  const [enumerationStatus, setEnumerationStatus] = useState("checking");
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
      if (!media?.enumerateDevices) {
        if (!cancelled) setEnumerationStatus("unavailable");
        return;
      }
      try {
        if (!cancelled) setEnumerationStatus("checking");
        const all = await media.enumerateDevices();
        if (cancelled) return;
        setDevices({
          inputs: all.filter((device) => device.kind === "audioinput" && device.deviceId),
          outputs: all.filter((device) => device.kind === "audiooutput" && device.deviceId),
        });
        setEnumerationStatus("ready");
      } catch {
        if (!cancelled) setEnumerationStatus("unavailable");
      }
    }
    readDevices();
    media?.addEventListener?.("devicechange", readDevices);
    return () => {
      cancelled = true;
      media?.removeEventListener?.("devicechange", readDevices);
    };
  }, [testingMic]);

  const voiceKnown = ELEVENLABS_PRESETS.some((preset) => preset.id === cfg.elevenlabsVoiceId);
  const micStatus = savedDeviceStatus({ kind: "microphone", selectedId: cfg.micDeviceId, devices: devices.inputs, enumerationStatus, permission: voice?.permission });
  const speakerStatus = savedDeviceStatus({ kind: "speaker", selectedId: cfg.speakerDeviceId, devices: devices.outputs, enumerationStatus, permission: voice?.permission });
  const captureActive = microphoneCaptureActive(voice);
  const finishMicTest = useCallback(() => setTestingMic(false), []);

  useEffect(() => {
    if (captureActive) setTestingMic(false);
  }, [captureActive]);

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
        <div className="dockSettings__row dockSettings__modelLink"><div><strong>Talk model</strong><span>Choose the model and effort from the central Models workspace.</span></div><Link href="/models">Open Models <span aria-hidden="true">↗</span></Link></div>
        <div className="dockSettings__row dockSettings__row--two">
          <label className="dockSettings__field">
            <span>Microphone</span>
            <select aria-label="Microphone" aria-describedby={`${microphoneHelpId} ${deviceGuidanceId}`} value={cfg.micDeviceId || ""} onChange={(event) => { setTestingMic(false); setMicError(""); voice.updateConfig({ micDeviceId: event.target.value }); }}>
              <option value="">System default</option>
              {micStatus.missing ? <option value={cfg.micDeviceId}>{micStatus.label}</option> : null}
              {devices.inputs.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}
            </select>
            {micStatus.missing ? <small id={microphoneHelpId}>{micStatus.unavailable ? "This saved microphone is unavailable. Connect it or choose System default." : "Panel cannot confirm this saved microphone until device access is available."}</small> : <small id={microphoneHelpId}>Changing microphones stops listening. Start voice again to use your selection.</small>}
          </label>
          <label className="dockSettings__field">
            <span>Speaker</span>
            <select aria-label="Speaker" aria-describedby={`${speakerHelpId} ${deviceGuidanceId}`} value={cfg.speakerDeviceId || ""} onChange={(event) => voice.updateConfig({ speakerDeviceId: event.target.value })} disabled={!supportsSinkId} title={!supportsSinkId ? "This browser uses your system output device." : "Output device for spoken replies"}>
              <option value="">System default</option>
              {speakerStatus.missing ? <option value={cfg.speakerDeviceId}>{speakerStatus.label}</option> : null}
              {devices.outputs.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Speaker ${index + 1}`}</option>)}
            </select>
            <small id={speakerHelpId}>{!supportsSinkId ? "Panel uses your system output in this app." : speakerStatus.missing ? speakerStatus.unavailable ? "This saved speaker is unavailable. Connect it or choose System default." : "Panel cannot confirm this saved speaker until device access is available." : "Used for spoken replies."}</small>
          </label>
        </div>
        <p id={deviceGuidanceId} className="voiceSettings__help">For clearer Bluetooth headphone audio, choose your Mac or USB microphone and keep your headphones as the speaker or system output.</p>
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
          <button type="button" className="voiceSettings__button" aria-pressed={testingMic} aria-describedby={!testingMic ? microphoneTestStatusId : undefined} disabled={captureActive} onClick={() => { setMicError(""); setTestingMic((current) => !current); }}>{testingMic ? "Stop microphone test" : "Test microphone"}</button>
          {testingMic && !micError ? <MicMeter deviceId={cfg.micDeviceId || ""} onError={setMicError} onFinished={finishMicTest} /> : <span id={microphoneTestStatusId} className="dockSettings__meterLabel" role="status">{captureActive ? "Stop voice capture to test" : micError ? "Test unavailable" : "Check your input level"}</span>}
        </div>
        {micError ? <p className="voiceSettings__inlineError" role="alert">{micError}</p> : null}
        {voice?.configSaveStatus && voice.configSaveStatus !== "idle" ? <p className={`voiceSettings__saveStatus${voice.configSaveStatus === "error" ? " is-error" : ""}`} role={voice.configSaveStatus === "error" ? "alert" : "status"}>{voice.configSaveStatus === "saving" ? "Saving your change…" : voice.configSaveStatus === "error" ? voice.configSaveError || "Could not save your last change. Try that setting again." : "Last change saved."}</p> : null}
        {!embedded ? <Link href="/voice" className="dockSettings__moreLink">All voice settings <span aria-hidden="true">↗</span></Link> : null}
      </div>
    </div>
  );
}

export { ELEVENLABS_PRESETS };
