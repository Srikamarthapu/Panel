"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import VoiceProvider, { useVoice } from "@/components/voice/VoiceProvider.jsx";
import RuntimeProvider from "@/components/control/RuntimeProvider.jsx";
import StartupScreen from "./StartupScreen.jsx";
import { normalizeTranscriptEntries } from "@/lib/publicReply.js";
import { sessionSwitchBlocked } from "@/lib/work-session-state.js";

const WorkSessionContext = createContext(null);
export const useWorkSessions = () => useContext(WorkSessionContext);
const selectionKey = "panel.activeSession";

export async function workRequest(url, options = {}) {
  const response = await fetch(url, { ...options, cache: "no-store", signal: options.signal || AbortSignal.timeout(15000), headers: { "Content-Type": "application/json", ...options.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Panel could not load this workspace. Try again.");
  return data;
}

function BusyBridge({ setBusy }) {
  const voice = useVoice();
  const busy = sessionSwitchBlocked(voice);
  useEffect(() => { setBusy(busy); return () => setBusy(false); }, [busy, setBusy]);
  return null;
}

export default function WorkSessionProvider({ children }) {
  const [sessions, setSessions] = useState([]);
  const [active, setActive] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, updateBusy] = useState(false);
  const busyRef = useRef(false);
  const switching = useRef(false);
  const revision = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  const refreshRevision = useRef(0);
  const setBusy = useCallback(value => { busyRef.current = value; updateBusy(value); }, []);
  const remember = useCallback((detail) => {
    setActive({ ...detail, revision: ++revision.current });
    try { localStorage.setItem(selectionKey, detail.session.id); } catch { /* server history still persists */ }
  }, []);
  const refresh = useCallback(async () => {
    const requestRevision = ++refreshRevision.current;
    const data = await workRequest("/api/sessions");
    if (requestRevision === refreshRevision.current) {
      setSessions(data.sessions);
      setActive(previous => {
        const session = data.sessions.find(item => item.id === previous?.session.id);
        return session ? { ...previous, session } : previous;
      });
    }
    return data.sessions;
  }, []);
  useEffect(() => {
    let stopped = false, timer;
    const poll = async () => {
      if (stopped) return;
      try { if (document.visibilityState !== "hidden") await refresh(); }
      catch { /* Keep usable saved state; explicit actions report their failure. */ }
      if (!stopped) timer = setTimeout(poll, 3000);
    };
    timer = setTimeout(poll, 3000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [refresh]);
  const boot = useCallback(async () => {
    setLoading(true); setError("");
    try {
      let list = await refresh();
      let saved; try { saved = localStorage.getItem(selectionKey); } catch { /* storage may be disabled */ }
      if (!saved || !list.some(session => session.id === saved)) {
        let legacy;
        try {
          const sessionId = localStorage.getItem("hermes.voice.sessionId");
          if (/^[a-zA-Z0-9_-]{1,200}$/.test(sessionId || "")) {
            let entries = []; try { entries = JSON.parse(localStorage.getItem("hermes.voice.transcript") || "[]"); } catch { /* keep damaged browser copy untouched */ }
            legacy = { sessionId, messages: normalizeTranscriptEntries(entries) };
          }
        } catch { /* storage may be disabled */ }
        if (legacy) {
          const adopted = await workRequest("/api/sessions/adopt", { method: "POST", body: JSON.stringify(legacy) });
          saved = adopted.session.id;
          list = await refresh();
        }
      }
      let session = list.find(item => item.id === saved && !item.archivedAt) || list.find(item => !item.archivedAt);
      if (!session) {
        session = (await workRequest("/api/sessions", { method: "POST", body: JSON.stringify({ name: "New session" }) })).session;
        setSessions(previous => [session, ...previous]);
      }
      remember(await workRequest(`/api/sessions/${session.id}`));
    } catch (failure) { setError(failure.message); }
    finally { setLoading(false); }
  }, [refresh, remember]);
  const booted = useRef(false);
  useEffect(() => { if (!booted.current) { booted.current = true; void boot(); } }, [boot]);
  const selectSession = useCallback(async (id) => {
    if (id === activeRef.current?.session.id) return;
    if (switching.current) throw new Error("A session is opening. Try again in a moment.");
    if (busyRef.current) throw new Error("Wait for request acceptance or stop the current interaction before switching sessions.");
    switching.current = true;
    try {
      const detail = await workRequest(`/api/sessions/${id}`);
      if (detail.session.archivedAt) throw new Error("Restore this session before opening it.");
      if (busyRef.current) throw new Error("Wait for request acceptance or stop the current interaction before switching sessions.");
      remember(detail); await refresh();
    }
    finally { switching.current = false; }
  }, [refresh, remember]);
  const createSession = useCallback(async (input) => {
    if (busyRef.current) throw new Error("Wait for request acceptance or stop the current interaction before creating a session.");
    const data = await workRequest("/api/sessions", { method: "POST", body: JSON.stringify(input) });
    await selectSession(data.session.id);
    return data.session;
  }, [selectSession]);
  const updateSession = useCallback(async (id, patch) => {
    const data = await workRequest(`/api/sessions/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
    setActive(previous => previous?.session.id === id ? { ...previous, session: data.session } : previous);
    await refresh();
    return data.session;
  }, [refresh]);
  const renameSession = useCallback((id, name) => updateSession(id, { name }), [updateSession]);
  const pinSession = useCallback((id, pinned) => updateSession(id, { pinned }), [updateSession]);
  const restoreSession = useCallback((id) => updateSession(id, { archived: false }), [updateSession]);
  const archiveSession = useCallback(async (id) => {
    if (activeRef.current?.session.id === id && busyRef.current) throw new Error("Wait for request acceptance or stop the current interaction before archiving this session.");
    const session = await updateSession(id, { archived: true });
    if (activeRef.current?.session.id === id) {
      const list = await refresh();
      const next = list.find(item => item.id !== id && !item.archivedAt);
      if (next) await selectSession(next.id);
      else await createSession({ name: "New session" });
    }
    return session;
  }, [createSession, refresh, selectSession, updateSession]);
  const stopSessionRun = useCallback(async (id, runId) => {
    let actionId = runId;
    if (!actionId) actionId = (await workRequest(`/api/sessions/${id}`)).activeRun?.id;
    if (!actionId) return null;
    const data = await workRequest("/api/voice/runs", { method: "DELETE", body: JSON.stringify({ sessionId: id, actionId }) });
    await refresh();
    return data.run;
  }, [refresh]);
  const activeRuns = useMemo(() => sessions.filter(session => session.activeRun).map(session => ({ ...session.activeRun, sessionName: session.name, workingDirectory: session.workingDirectory })), [sessions]);
  const value = useMemo(() => ({ sessions, activeRuns, activeSession: active?.session, busy, loading, error, refresh, selectSession, createSession, updateSession, renameSession, pinSession, archiveSession, restoreSession, stopSessionRun }), [sessions, activeRuns, active, busy, loading, error, refresh, selectSession, createSession, updateSession, renameSession, pinSession, archiveSession, restoreSession, stopSessionRun]);
  if (!active) return <StartupScreen loading={loading} error={error} onRetry={boot} />;
  return <WorkSessionContext.Provider value={value}>
    <VoiceProvider key={`${active.session.id}:${active.revision}`} sessionId={active.session.id} initialTranscript={active.messages || []} initialActiveRun={active.activeRun}>
      <BusyBridge setBusy={setBusy} /><RuntimeProvider>{children}</RuntimeProvider>
    </VoiceProvider>
  </WorkSessionContext.Provider>;
}
