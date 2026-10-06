"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useVoice } from "@/components/voice/VoiceProvider.jsx";
import { deriveOrbActivity } from "@/lib/control-center-status.js";

const RuntimeContext = createContext(null);
export const useRuntime = () => useContext(RuntimeContext);

// One bounded, visibility-aware subscription for the entire control center.
export default function RuntimeProvider({ children }) {
  const voice = useVoice();
  const [snapshot, setSnapshot] = useState(null);
  const [fetchedAt, setFetchedAt] = useState(null);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(0);
  useEffect(() => {
    let stopped = false;
    let timer;
    let controller;
    let busy = false;
    async function refresh(force = false) {
      if (stopped || busy || (document.hidden && force !== true)) return;
      clearTimeout(timer);
      busy = true;
      controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch("/api/control-center", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Status feed unavailable");
        const data = await response.json();
        if (!stopped) { setSnapshot(data); setFetchedAt(Date.now()); setError(null); }
      } catch (err) {
        if (!stopped) setError("Live updates interrupted");
      } finally {
        clearTimeout(timeout);
        busy = false;
        if (!stopped) { setNow(Date.now()); timer = setTimeout(refresh, 3000); }
      }
    }
    function onVisibility() {
      clearTimeout(timer);
      if (!document.hidden) { setNow(Date.now()); refresh(); }
    }
    // A native webview may mount before its first visibility notification.
    // Always load one snapshot, then suspend background polling as usual.
    function onFocus() { refresh(true); }
    refresh(true);
    window.addEventListener("voice-activity", refresh);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      window.removeEventListener("voice-activity", refresh);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  const value = useMemo(() => ({
    snapshot, fetchedAt, error, now,
    status: deriveOrbActivity({
      voiceState: voice?.state, voiceCaption: voice?.caption,
      activity: snapshot?.activity || [], gateway: snapshot?.gateway, sessionId: voice?.sessionId, runtimeReady: snapshot?.runtime?.available,
      fetchedAt, connectionError: Boolean(error), now: now || Date.now(),
    }),
  }), [snapshot, fetchedAt, error, now, voice?.state, voice?.caption, voice?.sessionId]);
  return <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>;
}
