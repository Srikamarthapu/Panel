"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useVoice } from "@/components/voice/VoiceProvider.jsx";
import VoiceDockSettings from "@/components/voice/VoiceDockSettings.jsx";
import { Mic, AudioLines, Square, SlidersHorizontal } from "lucide-react";

export default function VoiceDock({ compact = false }) {
  const voice = useVoice();
  const [mode, setMode] = useState("ptt");
  const [pttActive, setPttActive] = useState(false);
  const pressRef = useRef(null);
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const instructionId = useId();

  const beginPtt = useCallback((event) => {
    if (pressRef.current || !voiceRef.current) return;
    if (event?.pointerId !== undefined && (event.button !== 0 || event.isPrimary === false)) return;
    if (voiceRef.current.startPushToTalk() === false) return;
    pressRef.current = event?.pointerId !== undefined
      ? { pointerId: event.pointerId, target: event.currentTarget }
      : { key: event?.key };
    if (event?.pointerId !== undefined) {
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* window may have lost capture */ }
    }
    setPttActive(true);
  }, []);

  const finishPtt = useCallback((cancel = false, event) => {
    const press = pressRef.current;
    if (!press) return;
    if (event?.pointerId !== undefined && press.pointerId !== event.pointerId) return;
    if (event?.key !== undefined && press.key !== event.key) return;
    // Clear ownership before releasing capture: lostpointercapture can fire
    // synchronously, and must not cancel a recording already released to send.
    pressRef.current = null;
    setPttActive(false);
    if (cancel) voiceRef.current?.cancelPushToTalk();
    else voiceRef.current?.stopPushToTalk();
    if (press.pointerId !== undefined) {
      try { press.target?.releasePointerCapture(press.pointerId); } catch { /* already released */ }
    }
  }, []);

  useEffect(() => {
    const cancel = () => finishPtt(true);
    const hide = () => { if (document.visibilityState === "hidden") cancel(); };
    const releasePointer = (event) => finishPtt(false, event);
    const cancelPointer = (event) => finishPtt(true, event);
    window.addEventListener("pointerup", releasePointer);
    window.addEventListener("pointercancel", cancelPointer);
    window.addEventListener("blur", cancel);
    window.addEventListener("pagehide", cancel);
    document.addEventListener("visibilitychange", hide);
    return () => {
      window.removeEventListener("pointerup", releasePointer);
      window.removeEventListener("pointercancel", cancelPointer);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("pagehide", cancel);
      document.removeEventListener("visibilitychange", hide);
      // Navigation must discard a held recording, never submit it.
      if (pressRef.current) voiceRef.current?.cancelPushToTalk();
      pressRef.current = null;
    };
  }, [finishPtt]);

  // A native voice shortcut can start hands-free independently of the dock.
  useEffect(() => { if (voice?.continuousRequested) setMode("hands-free"); }, [voice?.continuousRequested]);

  if (!voice) return <section className="voiceDock voiceDock--unavailable" aria-label="Voice dock"><p>Voice provider unavailable.</p></section>;

  const isError = voice.state === "error";
  const permissionResolving = voice.permission === "pending";
  const isActive = !!voice.continuousRequested || ["starting", "listening", "capturing", "speaking"].includes(voice.state) || permissionResolving;
  const requestActive = ["thinking", "transcribing", "speaking"].includes(voice.state);
  const showRetry = isError && voice.permission === "denied";
  const primaryLabel = isActive ? "End conversation" : requestActive ? "Stop response" : "Start conversation";
  const idle = !isActive && !requestActive && !isError;
  const instruction = idle
    ? mode === "ptt" ? "Hold the button, Space, or Enter. Release to send." : "Start a conversation to listen hands-free."
    : pttActive && voice.state === "capturing" ? "Release to send. Move focus away to cancel." : voice.caption;

  const chooseMode = (next) => {
    if (next === mode) return;
    finishPtt(true);
    if (isActive && !pressRef.current) voice.cancelCurrent();
    setMode(next);
  };
  const onPrimaryClick = () => {
    if (isActive || requestActive) voice.cancelCurrent();
    else voice.toggleContinuous();
  };
  const onPttKeyDown = (event) => {
    if (event.key === "Escape") { event.preventDefault(); finishPtt(true); return; }
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    if (!event.repeat) beginPtt(event);
  };
  const onPttKeyUp = (event) => {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    finishPtt(false, event);
  };
  const onSettingsClick = () => voice.settingsOpen ? voice.closeSettings() : voice.openSettings();

  return (
    <section className={`voiceDock${compact ? " voiceDock--compact" : ""}`} data-state={voice.state} data-mode={mode} aria-label="Voice dock">
      <div className="voiceDock__modes" role="group" aria-label="Voice mode">
        <button type="button" aria-pressed={mode === "ptt"} onClick={() => chooseMode("ptt")}>Push to talk</button>
        <button type="button" aria-pressed={mode === "hands-free"} onClick={() => chooseMode("hands-free")}>Hands-free</button>
      </div>
      <div className="voiceDock__row">
        {mode === "ptt" ? (
          <button
            type="button"
            className={`voiceDock__ptt voiceDock__hold${pttActive ? " is-active" : ""}`}
            aria-pressed={pttActive}
            aria-label="Push to talk"
            aria-describedby={instructionId}
            title="Hold to talk, release to send"
            disabled={!pttActive && (["thinking", "transcribing", "starting", "capturing"].includes(voice.state) || permissionResolving)}
            onPointerDown={beginPtt}
            onPointerUp={(event) => finishPtt(false, event)}
            onPointerCancel={(event) => finishPtt(true, event)}
            onLostPointerCapture={(event) => finishPtt(true, event)}
            onBlur={() => finishPtt(true)}
            onKeyDown={onPttKeyDown}
            onKeyUp={onPttKeyUp}
          >
            <span className="voiceDock__pttGlyph" aria-hidden="true"><Mic size={18} /></span>
            <span>{pttActive ? voice.state === "capturing" ? "Release to send" : "Starting microphone…" : voice.state === "speaking" ? "Hold to interrupt" : "Hold to talk"}</span>
          </button>
        ) : (
          <button type="button" className={`voiceDock__primary${isActive ? " is-active" : ""}`} onClick={onPrimaryClick} aria-pressed={!!voice.continuousRequested}>
            <span className="voiceDock__primaryGlyph" aria-hidden="true">{isActive || requestActive ? <Square size={13} /> : <AudioLines size={18} />}</span>
            <span className="voiceDock__primaryLabel">{primaryLabel}</span>
          </button>
        )}
        {mode === "ptt" && requestActive ? <button type="button" className="voiceDock__stop" onClick={() => voice.cancelCurrent()}><Square size={13} aria-hidden="true" /> Stop response</button> : null}
      </div>
      <div className="voiceDock__captions" id={instructionId}>
        <span className="voiceDock__caption voiceDock__caption--polite" aria-live="polite">{!isError ? instruction : ""}</span>
        <span className="voiceDock__caption voiceDock__caption--error" role="alert">{isError && !voice.lastError ? voice.caption : ""}</span>
      </div>

      {isError && voice.permissionError && !voice.lastError ? (
        <p className="voiceDock__diagnostic">
          <small>{voice.permissionError}</small>
        </p>
      ) : null}

      {/* Law 9: a newer server build is live. We auto-reload at the next idle
          moment, but expose a one-tap refresh so the user is never stuck on a
          stale bundle mid-session (e.g. if they keep talking). */}
      {voice.updateReady ? (
        <div className="voiceDock__updateReady">
          <button
            type="button"
            className="voiceDock__update"
            onClick={() => voice.applyUpdate && voice.applyUpdate({ force: true })}
          >
            Update ready — tap to refresh
          </button>
        </div>
      ) : null}

      <div className="voiceDock__actions">
        {showRetry ? (
          <button
            type="button"
            className="voiceDock__retry"
            onClick={() => voice.retryPermission()}
          >
            Retry microphone
          </button>
        ) : null}
        <button
          type="button"
          className="voiceDock__settings"
          aria-expanded={!!voice.settingsOpen}
          onClick={onSettingsClick}
        >
          <SlidersHorizontal size={14} aria-hidden="true" /> Voice settings
        </button>
      </div>

      {voice.settingsOpen ? <VoiceDockSettings voice={voice} /> : null}
    </section>
  );
}
