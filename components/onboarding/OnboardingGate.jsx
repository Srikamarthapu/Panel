"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import StartupScreen from "@/components/work/StartupScreen.jsx";
import { ONBOARDING_REPLAY_EVENT, ONBOARDING_STORAGE_KEY, parseOnboardingDecision } from "@/lib/onboarding-state.js";
import OnboardingFlow from "./OnboardingFlow.jsx";
import styles from "./OnboardingGate.module.css";

const existingBrowserKeys = ["panel.activeSession", "hermes.voice.sessionId", "hermes.voice.transcript"];
const FIRST_RUN_STARTED_KEY = "panel.onboarding.firstRunStarted.v1";

async function request(url, options) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10000), ...options, cache: "no-store", headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Panel could not load setup.");
  return data;
}

function browserDecision() {
  try { return parseOnboardingDecision(localStorage.getItem(ONBOARDING_STORAGE_KEY)); } catch { return null; }
}

function hasLegacyBrowserEvidence() {
  try { return existingBrowserKeys.some(key => localStorage.getItem(key)); } catch { return false; }
}

function firstRunStarted() {
  try { return localStorage.getItem(FIRST_RUN_STARTED_KEY) === "1"; } catch { return false; }
}

function rememberFirstRunStarted() {
  try { localStorage.setItem(FIRST_RUN_STARTED_KEY, "1"); } catch { /* The guide still works without browser storage. */ }
}

function clearFirstRunStarted() {
  try { localStorage.removeItem(FIRST_RUN_STARTED_KEY); } catch { /* The server decision remains authoritative. */ }
}

function validEnvironment(value) {
  return value && typeof value === "object"
    && typeof value.needsOnboarding === "boolean"
    && typeof value.hermes?.installed === "boolean"
    && typeof value.hermes?.configured === "boolean"
    && typeof value.storage?.panelData === "string"
    && typeof value.storage?.hermesHome === "string";
}

export default function OnboardingGate({ children }) {
  const [state, setState] = useState({ phase: "checking", environment: null, error: "", replay: false });
  const mounted = useRef(true);
  const replayTrigger = useRef(null);
  const replayRequested = useRef(false);
  const loadRevision = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const load = useCallback(async () => {
    const revision = ++loadRevision.current;
    setState(previous => ({ ...previous, phase: "checking", error: "", replay: previous.replay || replayRequested.current }));
    try {
      const local = browserDecision();
      const result = await request("/api/onboarding");
      if (!validEnvironment(result)) throw new Error("Panel returned an incomplete setup status. Try again.");
      if (!mounted.current || revision !== loadRevision.current) return;
      if (replayRequested.current) {
        setState({ phase: "onboarding", environment: result, error: "", replay: true });
        return;
      }
      if (firstRunStarted() && !local && !result.decision) {
        setState({ phase: "onboarding", environment: result, error: "", replay: false });
        return;
      }
      if (local || result.decision || !result.needsOnboarding) {
        if (local || result.decision) clearFirstRunStarted();
        if (!local && !result.decision && result.existingEvidence?.length) {
          try {
            const saved = await request("/api/onboarding", { method: "POST", body: JSON.stringify({ outcome: "existing-user" }) });
            try { localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(saved.decision)); } catch {}
          } catch { /* Existing evidence remains sufficient for this launch. */ }
          if (!mounted.current || revision !== loadRevision.current) return;
          if (replayRequested.current) { setState({ phase: "onboarding", environment: result, error: "", replay: true }); return; }
        }
        setState({ phase: "ready", environment: result, error: "", replay: false });
        return;
      }
      if (hasLegacyBrowserEvidence()) {
        try {
          const saved = await request("/api/onboarding", { method: "POST", body: JSON.stringify({ outcome: "existing-user" }) });
          try { localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(saved.decision)); } catch {}
        } catch { /* Browser evidence still keeps an existing user out of first-run UI. */ }
        if (!mounted.current || revision !== loadRevision.current) return;
        if (replayRequested.current) setState({ phase: "onboarding", environment: result, error: "", replay: true });
        else setState({ phase: "ready", environment: result, error: "", replay: false });
        return;
      }
      rememberFirstRunStarted();
      setState({ phase: "onboarding", environment: result, error: "", replay: false });
    } catch (error) {
      if (mounted.current && revision === loadRevision.current) setState({ phase: "error", environment: null, error: error.message, replay: replayRequested.current });
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void load();
    const replay = event => {
      replayTrigger.current = event.detail?.trigger || document.activeElement;
      replayRequested.current = true;
      const current = stateRef.current;
      if (current.environment) setState({ phase: "onboarding", environment: current.environment, replay: true, error: "" });
      else if (current.phase === "checking") setState(previous => ({ ...previous, replay: true }));
      else void load();
    };
    window.addEventListener(ONBOARDING_REPLAY_EVENT, replay);
    return () => { mounted.current = false; window.removeEventListener(ONBOARDING_REPLAY_EVENT, replay); };
  }, [load]);
  useEffect(() => {
    if (state.phase === "ready" && replayTrigger.current) {
      const trigger = replayTrigger.current; replayTrigger.current = null;
      if (trigger.isConnected) trigger.focus?.();
    }
  }, [state.phase]);

  const finish = useCallback(async outcome => {
    const saved = await request("/api/onboarding", { method: "POST", body: JSON.stringify({ outcome }) });
    try { localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(saved.decision)); } catch {}
    clearFirstRunStarted();
    replayRequested.current = false;
    setState(previous => ({ ...previous, phase: "ready", replay: false, error: "" }));
  }, []);
  const dismiss = useCallback(() => {
    replayRequested.current = false;
    setState(previous => ({ ...previous, phase: "ready", replay: false, error: "" }));
  }, []);
  const continueWithoutEnvironment = useCallback(() => {
    replayRequested.current = false;
    setState({ phase: "ready", environment: null, error: "", replay: false });
  }, []);

  if (state.phase === "checking") return <StartupScreen loading loadingMessage="Preparing your local workspace…" />;
  if (state.phase === "error") return <StartupScreen loading={false} error={state.error} onRetry={load} onContinue={continueWithoutEnvironment} />;
  if (state.phase === "onboarding" && !state.replay) return <OnboardingFlow environment={state.environment} onFinish={finish} onClose={dismiss} />;
  const replaying = state.phase === "onboarding" && state.replay;
  return <><div className={styles.appContents} inert={replaying ? true : undefined} aria-hidden={replaying ? "true" : undefined}>{children}</div>{replaying ? <OnboardingFlow environment={state.environment} onFinish={finish} onClose={dismiss} replay /> : null}</>;
}
