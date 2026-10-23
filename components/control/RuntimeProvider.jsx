"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useVoice } from "@/components/voice/VoiceProvider.jsx";
import { deriveOrbActivity } from "@/lib/control-center-status.js";
import { startAdaptivePolling } from "@/lib/adaptive-poll.js";

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
    let controller;
    async function refresh() {
      if (stopped) return;
      controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch("/api/control-center", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Status feed unavailable");
        const data = await response.json();
        if (!stopped) { setSnapshot(data); setFetchedAt(Date.now()); setError(null); }
      } catch (err) {
        throw err;
      } finally { clearTimeout(timeout); if (!stopped) setNow(Date.now()); }
    }
    const polling = startAdaptivePolling({ poll: refresh, baseDelay: 3000, maxDelay: 30000, forceInitial: true, onError: () => { if (!stopped) setError("Live updates interrupted"); } });
    // A native webview may mount before its first visibility notification.
    // Always load one snapshot, then suspend background polling as usual.
    function onRefresh() { void polling.refresh(); }
    function onFocus() { void polling.refresh({ force: true }); }
    window.addEventListener("voice-activity", onRefresh);
    window.addEventListener("panel-runtime-changed", onRefresh);
    window.addEventListener("focus", onFocus);
    return () => {
      stopped = true;
      polling.stop();
      controller?.abort();
      window.removeEventListener("voice-activity", onRefresh);
      window.removeEventListener("panel-runtime-changed", onRefresh);
      window.removeEventListener("focus", onFocus);
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
