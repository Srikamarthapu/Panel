"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, CircleAlert, RefreshCw } from "lucide-react";
import MissionOrb from "@/components/MissionOrb.jsx";
import { useInterfacePreferences } from "@/components/preferences/InterfacePreferencesProvider.jsx";
import { onboardingReadinessResults } from "@/lib/onboarding-state.js";
import styles from "./OnboardingFlow.module.css";

const steps = ["Welcome", "Hermes", "Models", "Voice", "Your data", "First task"];

async function readJson(url) {
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "This check is unavailable right now.");
  return data;
}

function Status({ ok, children }) {
  return <div className={styles.status} data-ready={ok ? "true" : "false"}>{ok ? <Check aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}<span>{children}</span></div>;
}

function PathRow({ label, value }) {
  return <div className={styles.pathRow}><span>{label}</span><code>{value}</code></div>;
}

export default function OnboardingFlow({ environment, onFinish, onClose, replay = false }) {
  const { avatar } = useInterfacePreferences();
  const [step, setStep] = useState(0);
  const [models, setModels] = useState(null);
  const [voice, setVoice] = useState(null);
  const [errors, setErrors] = useState({ models: "", voice: "", save: "" });
  const [busy, setBusy] = useState(false);
  const heading = useRef(null);
  const dialog = useRef(null);
  const loadReadiness = useCallback(async () => {
    setErrors(previous => ({ ...previous, models: "", voice: "" }));
    const [modelResult, voiceResult] = await Promise.allSettled([readJson("/api/models/catalog"), readJson("/api/voice/status")]);
    const result = onboardingReadinessResults(modelResult, voiceResult);
    setModels(result.models); setVoice(result.voice);
    setErrors(previous => ({ ...previous, ...result.errors }));
  }, []);
  useEffect(() => { void loadReadiness(); }, [loadReadiness]);
  useEffect(() => { heading.current?.focus(); }, [step]);
  useEffect(() => {
    const trap = event => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!busy) replay ? onClose() : void complete("skipped");
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...dialog.current.querySelectorAll('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')];
      if (!focusable.length) return;
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    const node = dialog.current;
    node?.addEventListener("keydown", trap);
    return () => node?.removeEventListener("keydown", trap);
  }, [busy, onClose, replay]);
  const configuredProviders = useMemo(() => models?.providers?.filter(provider => provider.configured) || [], [models]);
  const current = models?.current || {};
  const currentLabel = current.model ? `${current.provider} / ${current.model}` : "Hermes default";
  const complete = async outcome => {
    setBusy(true); setErrors(previous => ({ ...previous, save: "" }));
    try { await onFinish(outcome); }
    catch (error) { setErrors(previous => ({ ...previous, save: error.message })); setBusy(false); }
  };

  const panels = [
    <div key="welcome" className={styles.hero}><div className={styles.orb} aria-hidden="true"><MissionOrb size="hero" avatar={avatar} voiceState="idle" /></div><p className={styles.eyebrow}>{replay ? "SETUP GUIDE" : "WELCOME TO PANEL"}</p><h1 id="onboarding-title" ref={heading} tabIndex={-1}>{replay ? "A quick tour of your workspace." : "Your agent, ready when you are."}</h1><p>Panel keeps Hermes conversations, voice, models, and local work in one calm workspace. This guide takes about a minute.</p></div>,
    <div key="hermes"><p className={styles.eyebrow}>LOCAL RUNTIME</p><h1 id="onboarding-title" ref={step === 1 ? heading : undefined} tabIndex={-1}>Hermes powers the workspace.</h1><p>Panel uses the Hermes installation on this Mac. Setup checks are local and never ask for provider keys.</p><div className={styles.cardStack}><Status ok={environment?.hermes?.installed}>{environment?.hermes?.installed ? "Hermes runtime found" : "Hermes runtime was not found in the expected local installation"}</Status><Status ok={environment?.hermes?.configured}>{environment?.hermes?.configured ? "Hermes configuration found" : "Hermes still needs a local configuration"}</Status></div>{!environment?.hermes?.installed || !environment?.hermes?.configured ? <p className={styles.help}>You can finish this guide and run <code>npm run doctor</code> from the Panel project to see the exact missing local requirement.</p> : null}</div>,
    <div key="models"><p className={styles.eyebrow}>MODEL ROUTING</p><h1 id="onboarding-title" ref={step === 2 ? heading : undefined} tabIndex={-1}>Use the models Hermes already knows.</h1><p>Panel reads configured providers from Hermes. No credentials are copied into this guide.</p>{errors.models ? <div className={styles.error} role="alert"><span>{errors.models}</span><button type="button" onClick={loadReadiness}><RefreshCw aria-hidden="true" />Retry check</button></div> : models ? <div className={styles.cardStack}><Status ok={!models.degraded && configuredProviders.length > 0}>{models.degraded ? models.warning || "The model catalog is in read-only mode" : `${configuredProviders.length} provider${configuredProviders.length === 1 ? "" : "s"} configured`}</Status><div className={styles.detailRow}><span>Primary route</span><strong>{currentLabel}</strong></div>{current.fallback?.model ? <div className={styles.detailRow}><span>Fallback</span><strong>{current.fallback.provider} / {current.fallback.model}</strong></div> : null}</div> : <p className={styles.loading} role="status">Reading the local model catalog…</p>}<p className={styles.help}>You can review providers, choose a primary model, and test supported connections later in Models.</p></div>,
    <div key="voice"><p className={styles.eyebrow}>OPTIONAL</p><h1 id="onboarding-title" ref={step === 3 ? heading : undefined} tabIndex={-1}>Voice is there when you want it.</h1><p>Type in Chat without microphone access, or enable Talk for hands-free conversations.</p>{errors.voice ? <div className={styles.error} role="alert"><span>{errors.voice}</span><button type="button" onClick={loadReadiness}><RefreshCw aria-hidden="true" />Retry check</button></div> : voice ? <div className={styles.cardStack}><Status ok={voice.readiness === "configured"}>{voice.readiness === "configured" ? "Speech input and output are configured" : "Voice needs more local setup"}</Status><div className={styles.detailRow}><span>Speech input</span><strong>{voice.stt?.configured ? `${voice.stt.backend} configured` : "Not configured"}</strong></div><div className={styles.detailRow}><span>Speech output</span><strong>{voice.tts?.configured ? `${voice.tts.backend} configured` : "Not configured"}</strong></div></div> : <p className={styles.loading} role="status">Checking voice readiness…</p>}<p className={styles.help}>These are configuration checks, not live provider tests. Panel asks for microphone access only when you use Talk.</p></div>,
    <div key="data"><p className={styles.eyebrow}>LOCAL BY DEFAULT</p><h1 id="onboarding-title" ref={step === 4 ? heading : undefined} tabIndex={-1}>Know where your work lives.</h1><p>Panel saves workspace history on this Mac. Hermes keeps its own configuration and memories in its local home.</p><div className={styles.paths}><PathRow label="Panel workspace data" value={environment?.storage?.panelData || "Unavailable"} /><PathRow label="Hermes home" value={environment?.storage?.hermesHome || "Unavailable"} /></div><p className={styles.help}>Provider requests still follow the services and models you choose in Hermes.</p></div>,
    <div key="task"><p className={styles.eyebrow}>YOU’RE READY</p><h1 id="onboarding-title" ref={step === 5 ? heading : undefined} tabIndex={-1}>Start with one concrete task.</h1><p>Open Chat and tell Hermes the outcome you want. Add the folder or constraints that matter; Panel keeps the conversation with the work.</p><div className={styles.example}><span>Try asking</span><q>Review this project and tell me the three highest-impact things to fix first.</q></div></div>,
  ];

  return <div className={styles.backdrop}><section ref={dialog} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="onboarding-title" aria-describedby="onboarding-progress">
    <div className={styles.topbar}><span className={styles.wordmark}>Panel</span><button type="button" className={styles.skip} onClick={() => replay ? onClose() : complete("skipped")} disabled={busy}>{replay ? "Close guide" : "Skip setup"}</button></div>
    <div className={styles.progress} id="onboarding-progress"><span>Step {step + 1} of {steps.length}</span><ol aria-label="Setup progress">{steps.map((label, index) => <li key={label} aria-current={index === step ? "step" : undefined} data-complete={index < step}><span className={styles.dot} /><span className={styles.stepLabel}>{label}</span></li>)}</ol></div>
    <div className={styles.body}>{panels[step]}</div>
    <footer className={styles.footer}>{step > 0 ? <button type="button" className={styles.secondary} onClick={() => setStep(value => value - 1)} disabled={busy}><ArrowLeft aria-hidden="true" />Back</button> : <span />}{step < panels.length - 1 ? <button type="button" className={styles.primary} onClick={() => setStep(value => value + 1)}>Continue<ArrowRight aria-hidden="true" /></button> : <button type="button" className={styles.primary} onClick={() => complete("completed")} disabled={busy}>{busy ? "Saving…" : "Open workspace"}<ArrowRight aria-hidden="true" /></button>}</footer>
    {errors.save ? <p className={styles.saveError} role="alert">{errors.save}</p> : null}
  </section></div>;
}
