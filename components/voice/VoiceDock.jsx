"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useVoice } from "@/components/voice/VoiceProvider.jsx";
import VoiceDockSettings from "@/components/voice/VoiceDockSettings.jsx";
import { AudioLines, Mic, SlidersHorizontal, Square } from "lucide-react";

function isEditableTarget(target) {
  return target instanceof Element && !!target.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])");
}

function isInteractiveTarget(target) {
  return target instanceof Element && !!target.closest("button, a[href], input, textarea, select, summary, [contenteditable]:not([contenteditable=false]), [data-talk-voice-control]");
}

function hasModalFocus() {
  return !!document.querySelector("dialog[open], [role=dialog][aria-modal=true]");
}

function isPlainSpace(event) {
  return (event.code === "Space" || event.key === " ") && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}

function isModeShortcut(event) {
  return (event.code === "KeyV" || event.key?.toLowerCase() === "v") && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
}

export function useTalkVoiceControls() {
  const voice = useVoice();
  const [mode, setMode] = useState(voice?.continuousRequested ? "conversation" : "ptt");
  const [pttActive, setPttActive] = useState(false);
  const pressRef = useRef(null);
  const suppressNextClickRef = useRef(false);
  const voiceRef = useRef(voice);
  const modeRef = useRef(mode);
  voiceRef.current = voice;
  modeRef.current = mode;

  const beginPtt = useCallback((event, source = "control") => {
    const current = voiceRef.current;
    if (modeRef.current !== "ptt" || pressRef.current || !current) return false;
    if (event?.pointerId !== undefined && (event.button !== 0 || event.isPrimary === false)) return false;
    if (current.startPushToTalk() === false) return false;
    pressRef.current = event?.pointerId !== undefined
      ? { type: "pointer", pointerId: event.pointerId, target: event.currentTarget }
      : { type: source, key: event?.code || event?.key };
    if (event?.pointerId !== undefined) {
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* capture may be unavailable */ }
    }
    setPttActive(true);
    return true;
  }, []);

  const finishPtt = useCallback((cancel = false, event) => {
    const press = pressRef.current;
    if (!press) return false;
    if (event?.pointerId !== undefined && press.pointerId !== event.pointerId) return false;
    if (event && event.pointerId === undefined && (event.code || event.key)) {
      if (press.pointerId !== undefined || press.key !== event.code && press.key !== event.key) return false;
    }
    pressRef.current = null;
    setPttActive(false);
    if (!cancel) {
      suppressNextClickRef.current = true;
      setTimeout(() => { suppressNextClickRef.current = false; }, 0);
    }
    if (cancel) voiceRef.current?.cancelPushToTalk();
    else voiceRef.current?.stopPushToTalk();
    if (press.pointerId !== undefined) {
      try { press.target?.releasePointerCapture(press.pointerId); } catch { /* already released */ }
    }
    return true;
  }, []);

  const chooseMode = useCallback((next) => {
    if (next === modeRef.current) return false;
    finishPtt(true);
    // Stop local permission, capture, and playback without cancelling an
    // acknowledged assistant run. Its result can still finish in Chat.
    voiceRef.current?.suspendVoiceSurface?.();
    modeRef.current = next;
    setMode(next);
    return true;
  }, [finishPtt]);

  const cycleMode = useCallback(() => chooseMode(modeRef.current === "ptt" ? "conversation" : "ptt"), [chooseMode]);

  const cancelInteraction = useCallback(() => {
    if (pressRef.current) return finishPtt(true);
    const current = voiceRef.current;
    if (!current) return false;
    const active = current.continuousRequested || ["starting", "listening", "capturing", "thinking", "transcribing", "speaking"].includes(current.state) || current.permission === "pending";
    if (!active) return false;
    current.cancelCurrent();
    return true;
  }, [finishPtt]);

  useEffect(() => {
    if (voice?.continuousRequested) {
      modeRef.current = "conversation";
      setMode("conversation");
    }
  }, [voice?.continuousRequested]);

  useEffect(() => {
    const releasePointer = (event) => finishPtt(false, event);
    const cancelPointer = (event) => finishPtt(true, event);
    const discardHeld = () => finishPtt(true);
    const hide = () => { if (document.visibilityState === "hidden") discardHeld(); };
    const focusChanged = (event) => {
      if (pressRef.current?.type === "global-key" && (isInteractiveTarget(event.target) || hasModalFocus())) discardHeld();
    };
    const keyDown = (event) => {
      if (event.repeat || event.isComposing || event.defaultPrevented || hasModalFocus()) return;
      if (isModeShortcut(event) && !isEditableTarget(event.target)) {
        event.preventDefault();
        cycleMode();
        return;
      }
      if (modeRef.current === "ptt" && isPlainSpace(event) && !isInteractiveTarget(event.target)) {
        event.preventDefault();
        beginPtt(event, "global-key");
        return;
      }
      if (event.key === "Escape" && cancelInteraction()) event.preventDefault();
    };
    const keyUp = (event) => {
      if (pressRef.current?.type !== "global-key" || (event.code !== "Space" && event.key !== " ")) return;
      event.preventDefault();
      finishPtt(false, event);
    };
    window.addEventListener("pointerup", releasePointer);
    window.addEventListener("pointercancel", cancelPointer);
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", discardHeld);
    window.addEventListener("pagehide", discardHeld);
    document.addEventListener("visibilitychange", hide);
    document.addEventListener("focusin", focusChanged);
    return () => {
      window.removeEventListener("pointerup", releasePointer);
      window.removeEventListener("pointercancel", cancelPointer);
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", discardHeld);
      window.removeEventListener("pagehide", discardHeld);
      document.removeEventListener("visibilitychange", hide);
      document.removeEventListener("focusin", focusChanged);
      if (pressRef.current) voiceRef.current?.cancelPushToTalk();
      pressRef.current = null;
    };
  }, [beginPtt, cancelInteraction, cycleMode, finishPtt]);

  if (!voice) return { available: false, mode, chooseMode, cycleMode };

  const permissionResolving = voice.permission === "pending";
  const requestActive = ["thinking", "transcribing", "speaking"].includes(voice.state);
  const listeningActive = !!voice.continuousRequested || ["starting", "listening", "capturing"].includes(voice.state) || permissionResolving;
  const isError = voice.state === "error";
  const stopResponse = requestActive && !pttActive;
  const instruction = isError
    ? voice.caption
    : permissionResolving
      ? voice.caption || "Waiting for microphone permission"
    : pttActive
      ? voice.state === "capturing" ? "Release to send" : "Starting microphone…"
      : stopResponse
        ? voice.caption || "Working on your response"
        : mode === "ptt"
          ? "Hold the avatar or Space to talk. Release to send."
          : listeningActive
            ? voice.caption
            : "Select the avatar to start a hands-free conversation.";
  const mainLabel = stopResponse
    ? "Stop response"
    : mode === "ptt"
      ? pttActive ? voice.state === "capturing" ? "Release to send" : "Starting microphone" : voice.state === "speaking" ? "Hold to interrupt" : "Hold to talk"
      : listeningActive ? "End conversation" : "Start conversation";

  const activateConversation = () => {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }
    if (requestActive || listeningActive) voice.cancelCurrent();
    else voice.toggleContinuous();
  };
  const mainControl = {
    mode,
    label: mainLabel,
    description: instruction,
    active: pttActive || listeningActive,
    pressed: pttActive || (mode === "conversation" && !!voice.continuousRequested),
    stopResponse,
    onClick: mode === "conversation" || stopResponse ? activateConversation : undefined,
    onPointerDown: mode === "ptt" && !stopResponse ? beginPtt : undefined,
    onPointerUp: mode === "ptt" && !stopResponse ? (event) => finishPtt(false, event) : undefined,
    onPointerCancel: mode === "ptt" && !stopResponse ? (event) => finishPtt(true, event) : undefined,
    onLostPointerCapture: mode === "ptt" && !stopResponse ? (event) => finishPtt(true, event) : undefined,
    onBlur: mode === "ptt" && !stopResponse ? () => finishPtt(true) : undefined,
    onKeyDown: mode === "ptt" && !stopResponse ? (event) => {
      if (event.key === "Escape") { event.preventDefault(); finishPtt(true); return; }
      if (event.key !== " " && event.key !== "Enter") return;
      if (event.repeat || event.isComposing || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      event.preventDefault();
      beginPtt(event, "control-key");
    } : undefined,
    onKeyUp: mode === "ptt" && !stopResponse ? (event) => {
      if (event.key !== " " && event.key !== "Enter") return;
      event.preventDefault();
      finishPtt(false, event);
    } : undefined,
  };

  return {
    available: true, voice, mode,
    modeLabel: mode === "ptt" ? "Push to talk" : "Conversation",
    chooseMode, cycleMode, pttActive, requestActive, listeningActive, isError,
    instruction, mainControl,
  };
}

function VoiceStatus({ controller, instructionId, showInstruction = true }) {
  const { voice, isError, instruction } = controller;
  const showRetry = isError && voice.permission === "denied";
  return <>
    {showInstruction || isError ? <div className="voiceDock__captions" id={instructionId}>
      <span className="voiceDock__caption voiceDock__caption--polite" aria-live="polite">{!isError ? instruction : ""}</span>
      <span className="voiceDock__caption voiceDock__caption--error" role="alert">{isError ? voice.caption : ""}</span>
    </div> : null}
    {isError && voice.permissionError && !voice.lastError ? <p className="voiceDock__diagnostic"><small>{voice.permissionError}</small></p> : null}
    {voice.updateReady ? <div className="voiceDock__updateReady"><button type="button" className="voiceDock__update" onClick={() => voice.applyUpdate?.({ force: true })}>Update ready — tap to refresh</button></div> : null}
    {showRetry ? <button type="button" className="voiceDock__retry" onClick={() => voice.retryPermission()}>Retry microphone</button> : null}
    {voice.settingsOpen ? <VoiceDockSettings voice={voice} /> : null}
  </>;
}

function VoiceDockView({ compact, controller, children, stage }) {
  const instructionId = useId();
  if (!controller.available) return <section className="voiceDock voiceDock--unavailable" aria-label="Voice controls"><p>Voice provider unavailable.</p></section>;
  const { voice, mode, mainControl } = controller;
  const onSettingsClick = () => voice.settingsOpen ? voice.closeSettings() : voice.openSettings();

  if (stage) return <section className="voiceDock voiceDock--stage" data-state={voice.state} data-mode={mode} aria-label="Voice controls">
    {typeof children === "function" ? children({ ...controller, instructionId }) : children}
    <VoiceStatus controller={controller} instructionId={`${instructionId}-status`} showInstruction={false} />
  </section>;

  return <section className={`voiceDock${compact ? " voiceDock--compact" : ""}`} data-state={voice.state} data-mode={mode} aria-label="Voice controls">
    <div className="voiceDock__modes" role="group" aria-label="Voice mode">
      <button type="button" aria-pressed={mode === "ptt"} onClick={() => controller.chooseMode("ptt")}>Push to talk</button>
      <button type="button" aria-pressed={mode === "conversation"} onClick={() => controller.chooseMode("conversation")}>Conversation</button>
    </div>
    <div className="voiceDock__row">
      <button type="button" className={`${mode === "ptt" ? "voiceDock__ptt voiceDock__hold" : "voiceDock__primary"}${mainControl.active ? " is-active" : ""}`} aria-label={mainControl.label} aria-pressed={mainControl.pressed} aria-describedby={instructionId} data-talk-voice-control="primary" onClick={mainControl.onClick} onPointerDown={mainControl.onPointerDown} onPointerUp={mainControl.onPointerUp} onPointerCancel={mainControl.onPointerCancel} onLostPointerCapture={mainControl.onLostPointerCapture} onBlur={mainControl.onBlur} onKeyDown={mainControl.onKeyDown} onKeyUp={mainControl.onKeyUp}>
        <span aria-hidden="true">{mainControl.stopResponse ? <Square size={13} /> : mode === "ptt" ? <Mic size={18} /> : <AudioLines size={18} />}</span><span>{mainControl.label}</span>
      </button>
    </div>
    <VoiceStatus controller={controller} instructionId={instructionId} />
    <div className="voiceDock__actions"><button type="button" className="voiceDock__settings" aria-expanded={!!voice.settingsOpen} onClick={onSettingsClick}><SlidersHorizontal size={14} aria-hidden="true" /> Voice settings</button></div>
  </section>;
}

function StandaloneVoiceDock(props) {
  const controller = useTalkVoiceControls();
  return <VoiceDockView {...props} controller={controller} />;
}

export default function VoiceDock({ controller, ...props }) {
  return controller ? <VoiceDockView {...props} controller={controller} /> : <StandaloneVoiceDock {...props} />;
}
