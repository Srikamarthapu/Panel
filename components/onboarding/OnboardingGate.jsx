"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import StartupScreen from "@/components/work/StartupScreen.jsx";
import { ONBOARDING_REPLAY_EVENT, ONBOARDING_STORAGE_KEY, parseOnboardingDecision } from "@/lib/onboarding-state.js";
import OnboardingFlow from "./OnboardingFlow.jsx";
import styles from "./OnboardingGate.module.css";

const existingBrowserKeys = ["panel.activeSession", "hermes.voice.sessionId", "hermes.voice.transcript"];

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

export default function OnboardingGate({ children }) {
  const [state, setState] = useState({ phase: "checking", environment: null, error: "", replay: false });
  const mounted = useRef(true);
  const replayTrigger = useRef(null);
  const load = useCallback(async () => {
    setState(previous => ({ ...previous, phase: "checking", error: "" }));
    try {
      const local = browserDecision();
      const result = await request("/api/onboarding");
      if (!mounted.current) return;
      if (local || result.decision || !result.needsOnboarding) {
        if (!local && !result.decision && result.existingEvidence?.length) {
          try {
            const saved = await request("/api/onboarding", { method: "POST", body: JSON.stringify({ outcome: "existing-user" }) });
            try { localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(saved.decision)); } catch {}
          } catch { /* Existing evidence remains sufficient for this launch. */ }
        }
        setState({ phase: "ready", environment: result, error: "", replay: false });
        return;
      }
      if (hasLegacyBrowserEvidence()) {
        try {
          const saved = await request("/api/onboarding", { method: "POST", body: JSON.stringify({ outcome: "existing-user" }) });
          try { localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(saved.decision)); } catch {}
        } catch { /* Browser evidence still keeps an existing user out of first-run UI. */ }
        if (mounted.current) setState({ phase: "ready", environment: result, error: "", replay: false });
        return;
      }
      setState({ phase: "onboarding", environment: result, error: "", replay: false });
    } catch (error) {
      if (mounted.current) setState({ phase: "error", environment: null, error: error.message, replay: false });
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void load();
    const replay = event => { replayTrigger.current = event.detail?.trigger || document.activeElement; setState(previous => ({ ...previous, phase: "onboarding", replay: true, error: "" })); };
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
    setState(previous => ({ ...previous, phase: "ready", replay: false, error: "" }));
  }, []);
  const closeReplay = useCallback(() => setState(previous => ({ ...previous, phase: "ready", replay: false, error: "" })), []);

  if (state.phase === "checking") return <StartupScreen loading loadingMessage="Preparing your local workspace…" />;
  if (state.phase === "error") return <StartupScreen loading={false} error={state.error} onRetry={load} onContinue={() => setState({ phase: "ready", environment: null, error: "", replay: false })} />;
  if (state.phase === "onboarding" && !state.replay) return <OnboardingFlow environment={state.environment} onFinish={finish} />;
  const replaying = state.phase === "onboarding" && state.replay;
  return <><div className={styles.appContents} inert={replaying ? true : undefined} aria-hidden={replaying ? "true" : undefined}>{children}</div>{replaying ? <OnboardingFlow environment={state.environment} onFinish={finish} onClose={closeReplay} replay /> : null}</>;
}
