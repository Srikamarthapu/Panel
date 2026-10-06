"use client";

import { useState } from "react";
import Link from "next/link";
import { useVoice } from "@/components/voice/VoiceProvider.jsx";
import VoiceDockSettings from "@/components/voice/VoiceDockSettings.jsx";
import ElevenLabsKeyPanel from "@/components/voice/ElevenLabsKeyPanel.jsx";

function SettingsDisclosure({ title, description, children, count, onOpen }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="voiceSettings__disclosure" onToggle={(event) => { setOpen(event.currentTarget.open); if (event.currentTarget.open) onOpen?.(); }}>
      <summary>
        <span><strong>{title}</strong><span>{description}</span></span>
        {count != null ? <span className="voiceSettings__count">{count}</span> : null}
        <span className="voiceSettings__chevron" aria-hidden="true">⌄</span>
      </summary>
      {open ? <div className="voiceSettings__disclosureBody">{children}</div> : null}
    </details>
  );
}

function serviceExplanation(service, kind) {
  if (!service) return "Not checked";
  if (service.ok) return service.verified ? "Connection verified" : "Configured. Start a voice turn to verify playback.";
  if (service.status === 401 || service.status === 403) return "Credentials were rejected. Review the provider key and its permissions.";
  if (service.status === 429) return "Provider limit reached. Check the account quota and try again later.";
  if (/API_KEY not set|No API keys/i.test(service.error || "")) return kind === "stt"
    ? "A Deepgram key is needed for transcription. Add it to the server configuration."
    : "Add an ElevenLabs key to enable spoken replies.";
  if (/timeout|abort/i.test(service.error || "")) return "The provider did not respond in time. Try the check again.";
  return "The service could not be reached. Check the connection and provider configuration, then try again.";
}

function VoiceDiagnostics({ voice }) {
  const [result, setResult] = useState(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");

  async function check() {
    setChecking(true);
    setError("");
    try {
      const response = await fetch("/api/voice/status?probe=1", { cache: "no-store", signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error("unavailable");
      setResult(await response.json());
    } catch {
      setError("Hermes could not check the voice services. Make sure the local server is running and try again.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="voiceSettings__diagnostics">
      <p className="voiceSettings__help">Check transcription and speech services when a conversation has trouble connecting.</p>
      <button type="button" className="voiceSettings__button" onClick={check} disabled={checking}>{checking ? "Checking services…" : "Check connection"}</button>
      {error ? <p className="voiceSettings__inlineError" role="alert">{error}</p> : null}
      {result ? <dl className="voiceSettings__diagnosticList" aria-live="polite">
        <div><dt>Speech output</dt><dd>{serviceExplanation(result.tts, "tts")}</dd></div>
        <div><dt>Transcription</dt><dd>{serviceExplanation(result.stt, "stt")}</dd></div>
      </dl> : null}
      {voice?.caption && voice.state !== "idle" ? <p className="voiceSettings__help">Last voice status: {voice.caption}</p> : null}
    </div>
  );
}

export default function VoiceSettingsPage() {
  const voice = useVoice();
  if (!voice) return <section className="voiceSettings"><h1>Voice & audio</h1><p className="voiceSettings__note">Voice settings are still connecting. Reload this page if they do not appear.</p></section>;

  const { config = {}, voices = [], transcript = [], updateConfig, serverStatus } = voice;
  const history = transcript.filter((entry) => entry?.text);
  const voiceList = voices.length ? voices : [{ name: config.ttsVoice || "en-US-AriaNeural" }];
  const statusLabel = { running: "Voice configured", stopped: "Server unavailable", error: "Setup needs attention", checking: "Checking services" }[serverStatus] || "Status unavailable";

  return (
    <section className="voiceSettings">
      <header className="voiceSettings__head">
        <div>
          <span className="voiceSettings__eyebrow">Preferences</span>
          <h1>Voice & audio</h1>
          <p>Make the conversation feel like yours.</p>
        </div>
        <Link href="/" className="voiceSettings__back">Back to workspace <span aria-hidden="true">↗</span></Link>
      </header>

      <div className="voiceSettings__connection" data-state={serverStatus}>
        <div className="voiceSettings__server"><span className="voiceSettings__dot" data-state={serverStatus} aria-hidden="true" /><strong>{statusLabel}</strong></div>
        <span>{serverStatus === "error" ? "Open connection diagnostics below to find what needs attention." : serverStatus === "stopped" ? "Check that the local Hermes server is running, then use connection diagnostics." : serverStatus === "running" ? "Your provider settings are configured. Start a conversation from your workspace." : "You can adjust your preferences while the connection is checked."}</span>
      </div>

      <div className="voiceSettings__layout">
        <aside className="voiceSettings__sectionIntro"><span>01</span><h2>Conversation</h2><p>Your voice, model, and audio devices in one place.</p></aside>
        <article className="voiceSettings__card">
          <VoiceDockSettings voice={voice} embedded />
          <label className="voiceSettings__row voiceSettings__language">
            <span>Transcription language<small>Deepgram speech recognition</small></span>
            <input type="text" key={config.sttLanguage || "en"} defaultValue={config.sttLanguage || "en"} onBlur={(event) => { const value = event.target.value.trim(); if (value && value !== config.sttLanguage) updateConfig({ sttLanguage: value }); }} placeholder="en" aria-label="Transcription language" />
          </label>
        </article>

        <aside className="voiceSettings__sectionIntro"><span>02</span><h2>Fine tuning</h2><p>Provider access, fallback audio, and recent conversations.</p></aside>
        <div className="voiceSettings__advanced">
          <SettingsDisclosure title="ElevenLabs access" description="Manage keys and check remaining credits">
            <ElevenLabsKeyPanel />
          </SettingsDisclosure>
          <SettingsDisclosure title="Connection diagnostics" description="Check voice services when you need them">
            <VoiceDiagnostics voice={voice} />
          </SettingsDisclosure>
          <SettingsDisclosure title="Fallback voice" description="Voice and playback settings for fallback speech" onOpen={voice.loadVoices}>
            <div className="voiceSettings__fallback">
              <label className="voiceSettings__row"><span>Fallback voice</span><select value={config.ttsVoice || "en-US-AriaNeural"} onChange={(event) => updateConfig({ ttsVoice: event.target.value })}>{voiceList.map((item) => <option key={item.name} value={item.name}>{item.name}{item.gender ? ` · ${item.gender}` : ""}</option>)}</select></label>
              {[
                { key: "ttsRate", label: "Rate", fallback: "+0%" },
                { key: "ttsPitch", label: "Pitch", fallback: "+0Hz" },
                { key: "ttsVolume", label: "Volume", fallback: "+0%" },
              ].map((field) => <label className="voiceSettings__row" key={field.key}><span>{field.label}</span><input type="text" key={config[field.key] || field.fallback} defaultValue={config[field.key] || field.fallback} placeholder={field.fallback} onBlur={(event) => { const value = event.target.value.trim(); if (value && value !== config[field.key]) updateConfig({ [field.key]: value }); }} /></label>)}
            </div>
          </SettingsDisclosure>
          <SettingsDisclosure title="Recent transcript" description="Review your conversation with Hermes" count={history.length}>
            <div className="voiceSettings__history" aria-label="Recent voice transcripts">
              {history.length === 0 ? <p className="voiceSettings__empty">Your conversation will appear here after a voice session.</p> : <ul>{history.map((entry) => <li key={entry.id} data-role={entry.role} data-error={entry.isError ? "true" : "false"}><div><strong>{entry.role === "user" ? "You" : "Hermes"}</strong>{entry.time ? <time>{entry.time}</time> : null}</div><p>{entry.text}</p></li>)}</ul>}
            </div>
          </SettingsDisclosure>
        </div>
      </div>
    </section>
  );
}
