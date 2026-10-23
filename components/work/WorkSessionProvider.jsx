"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import VoiceProvider, { useVoice } from "@/components/voice/VoiceProvider.jsx";
import RuntimeProvider from "@/components/control/RuntimeProvider.jsx";
import StartupScreen from "./StartupScreen.jsx";
import { normalizeTranscriptEntries } from "@/lib/publicReply.js";
import { sessionSwitchBlocked } from "@/lib/work-session-state.js";
import { migrateAgentPresence, parseAgentPresence, parseSelectedAgentIds, reconcileAgentPresence, selectedAgentIdsFromPresence, WORK_AGENT_PRESENCE_KEY, WORK_AGENT_SELECTION_KEY } from "@/lib/work-agent-selection.js";
import { startAdaptivePolling } from "@/lib/adaptive-poll.js";

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
  const pathname = usePathname();
  const [sessions, setSessions] = useState([]);
  const [agents, setAgents] = useState([]);
  const [agentsReady, setAgentsReady] = useState(false);
  const [agentPresence, setAgentPresence] = useState(null);
  const [agentPresenceLoaded, setAgentPresenceLoaded] = useState(false);
  const [legacyAgentSelection, setLegacyAgentSelection] = useState(undefined);
  const [delegations, setDelegations] = useState([]);
  const [agentsError, setAgentsError] = useState("");
  const [directConfig, setDirectConfig] = useState(null);
  const [active, setActive] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [canSkipImport, setCanSkipImport] = useState(false);
  const [busy, updateBusy] = useState(false);
  const busyRef = useRef(false);
  const switching = useRef(false);
  const skipLegacyImport = useRef(false);
  const revision = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  const refreshRevision = useRef(0);
  const setBusy = useCallback(value => { busyRef.current = value; updateBusy(value); }, []);
  const remember = useCallback((detail) => {
    setActive({ ...detail, detailUpdatedAt: detail.session.updatedAt || "", revision: ++revision.current });
    try { localStorage.setItem(selectionKey, detail.session.id); } catch { /* server history still persists */ }
  }, []);
  const refresh = useCallback(async ({ forceActiveDetail = false } = {}) => {
    const requestRevision = ++refreshRevision.current;
    const [data, agentData, directData] = await Promise.all([
      workRequest("/api/sessions"),
      workRequest("/api/agents?archived=true").catch(() => null),
      workRequest("/api/direct/config").catch(() => null),
    ]);
    const observedActive = activeRef.current;
    const observedSummary = data.sessions.find(item => item.id === observedActive?.session.id);
    let activeDetail = null;
    if (observedSummary && (forceActiveDetail || observedSummary.updatedAt !== observedActive.detailUpdatedAt)) {
      activeDetail = await workRequest(`/api/sessions/${observedSummary.id}`).catch(() => null);
    }
    if (requestRevision === refreshRevision.current) {
      setSessions(data.sessions);
      if (agentData) { setAgents(agentData.agents || []); setAgentsReady(true); setDelegations(agentData.delegations || []); setAgentsError(""); }
      else setAgentsError("Agent status could not refresh. Saved conversations remain available.");
      if (directData?.config) setDirectConfig(directData.config);
      setActive(previous => {
        const session = data.sessions.find(item => item.id === previous?.session.id);
        if (!session) return previous;
        if (activeDetail?.session?.id === previous.session.id) {
          return {
            ...previous,
            session,
            messages: Array.isArray(activeDetail.messages) ? activeDetail.messages : previous.messages,
            activeRun: activeDetail.activeRun,
            detailUpdatedAt: activeDetail.session.updatedAt || session.updatedAt || previous.detailUpdatedAt,
          };
        }
        return { ...previous, session };
      });
    }
    return data.sessions;
  }, []);
  useEffect(() => {
    const polling = startAdaptivePolling({ poll: refresh, baseDelay: 3000, maxDelay: 30000, immediate: false });
    return () => polling.stop();
  }, [refresh]);
  const previousPathname = useRef(pathname);
  useEffect(() => {
    const previous = previousPathname.current;
    previousPathname.current = pathname;
    if (pathname !== "/chat" || previous === pathname) return;
    void refresh({ forceActiveDetail: true }).catch(() => { /* periodic refresh retries changed history */ });
  }, [pathname, refresh]);
  useEffect(() => {
    try {
      const saved = parseAgentPresence(localStorage.getItem(WORK_AGENT_PRESENCE_KEY));
      if (saved) setAgentPresence(saved);
      else {
        const legacy = localStorage.getItem(WORK_AGENT_SELECTION_KEY);
        setLegacyAgentSelection(legacy === null ? null : parseSelectedAgentIds(legacy));
        setAgentPresence({ version: 2, knownIds: [], hiddenIds: [] });
      }
    } catch {
      setLegacyAgentSelection(null);
      setAgentPresence({ version: 2, knownIds: [], hiddenIds: [] });
    } finally { setAgentPresenceLoaded(true); }
  }, []);
  useEffect(() => {
    if (!agentPresenceLoaded || !agentsReady) return;
    const next = legacyAgentSelection !== undefined
      ? migrateAgentPresence(legacyAgentSelection, agents)
      : reconcileAgentPresence(agentPresence, agents);
    const selected = selectedAgentIdsFromPresence(next, agents);
    try {
      localStorage.setItem(WORK_AGENT_PRESENCE_KEY, JSON.stringify(next));
      // Keep the v1 mirror during the migration window for older Panel builds.
      localStorage.setItem(WORK_AGENT_SELECTION_KEY, JSON.stringify(selected));
    } catch { /* Presence stays usable for this view. */ }
    const unchanged = agentPresence && next.knownIds.length === agentPresence.knownIds.length && next.hiddenIds.length === agentPresence.hiddenIds.length
      && next.knownIds.every((id, index) => id === agentPresence.knownIds[index])
      && next.hiddenIds.every((id, index) => id === agentPresence.hiddenIds[index]);
    if (!unchanged) setAgentPresence(next);
    if (legacyAgentSelection !== undefined) setLegacyAgentSelection(undefined);
  }, [agentPresenceLoaded, agentsReady, agents, agentPresence, legacyAgentSelection]);
  const boot = useCallback(async () => {
    setLoading(true); setError(""); setCanSkipImport(false);
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
        if (legacy && !skipLegacyImport.current) {
          try {
            const adopted = await workRequest("/api/sessions/adopt", { method: "POST", body: JSON.stringify(legacy) });
            saved = adopted.session.id;
            list = await refresh();
          } catch (failure) {
            const adoptionFailure = new Error(failure.message);
            adoptionFailure.legacyImport = true;
            throw adoptionFailure;
          }
        }
      }
      let session = list.find(item => item.id === saved && !item.archivedAt) || list.find(item => !item.archivedAt);
      if (!session) {
        session = (await workRequest("/api/sessions", { method: "POST", body: JSON.stringify({ name: "New session" }) })).session;
        setSessions(previous => [session, ...previous]);
      }
      remember(await workRequest(`/api/sessions/${session.id}`));
    } catch (failure) { setError(failure.message); setCanSkipImport(failure.legacyImport === true); }
    finally { setLoading(false); }
  }, [refresh, remember]);
  const continueWithoutImport = useCallback(() => { skipLegacyImport.current = true; void boot(); }, [boot]);
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
  const activeAgent = agents.find(agent => agent.id === active?.session?.agentId) || null;
  const selectedAgentIds = useMemo(() => agentPresenceLoaded && agentsReady ? selectedAgentIdsFromPresence(agentPresence, agents) : [], [agentPresenceLoaded, agentsReady, agentPresence, agents]);
  const selectedAgents = useMemo(() => selectedAgentIds
    .map(id => agents.find(agent => agent.id === id))
    .filter(agent => agent && agent.sessionId !== active?.session?.id), [selectedAgentIds, agents, active]);
  const toggleAgentPresence = useCallback(id => {
    if (!agents.some(agent => agent.id === id && !agent.archivedAt)) return false;
    const current = reconcileAgentPresence(agentPresence, agents);
    const hidden = new Set(current.hiddenIds);
    if (hidden.has(id)) hidden.delete(id); else hidden.add(id);
    const next = { ...current, hiddenIds: current.knownIds.filter(value => hidden.has(value)) };
    setAgentPresence(next);
    try {
      localStorage.setItem(WORK_AGENT_PRESENCE_KEY, JSON.stringify(next));
      localStorage.setItem(WORK_AGENT_SELECTION_KEY, JSON.stringify(selectedAgentIdsFromPresence(next, agents)));
    } catch { /* Presence stays usable for this view. */ }
    return true;
  }, [agents, agentPresence]);
  const clearAgentPresence = useCallback(() => {
    const current = reconcileAgentPresence(agentPresence, agents);
    const next = { ...current, hiddenIds: [...current.knownIds] };
    setAgentPresence(next);
    try {
      localStorage.setItem(WORK_AGENT_PRESENCE_KEY, JSON.stringify(next));
      localStorage.setItem(WORK_AGENT_SELECTION_KEY, "[]");
    } catch { /* Presence stays usable for this view. */ }
  }, [agents, agentPresence]);
  const saveAgent = useCallback(async (input, id) => {
    const data = await workRequest(id ? `/api/agents/${id}` : "/api/agents", { method: id ? "PATCH" : "POST", body: JSON.stringify(input) });
    const list = await refresh();
    if (input.archived && data.agent.sessionId === activeRef.current?.session.id) {
      const next = list.find(session => !session.archivedAt && session.id !== data.agent.sessionId);
      if (next) await selectSession(next.id); else await createSession({ name: "New session" });
    }
    return data.agent;
  }, [refresh, selectSession, createSession]);
  const runAgent = useCallback(async (id, text, actionId) => {
    const data = await workRequest(`/api/agents/${id}/runs`, { method: "POST", body: JSON.stringify({ text, actionId }) });
    await refresh(); return data;
  }, [refresh]);
  const openAgentConversation = useCallback(async id => {
    const data = await workRequest(`/api/agents/${id}/session`, { method: "POST", body: "{}" });
    await refresh();
    await selectSession(data.session.id);
    return data;
  }, [refresh, selectSession]);
  const stopDelegation = useCallback(async agent => {
    const data = await workRequest("/api/agents/delegations", { method: "DELETE", body: JSON.stringify({ sessionId: agent.sessionId, runId: agent.runId, agentId: agent.id, ...(agent.delegationId ? { delegationId: agent.delegationId } : {}) }) });
    await refresh(); return data;
  }, [refresh]);
  const value = useMemo(() => ({ sessions, agents, delegations, agentsError, directConfig, activeAgent, selectedAgentIds, selectedAgents, toggleAgentPresence, clearAgentPresence, saveAgent, runAgent, openAgentConversation, stopDelegation, activeRuns, activeSession: active?.session, busy, loading, error, refresh, selectSession, createSession, updateSession, renameSession, pinSession, archiveSession, restoreSession, stopSessionRun }), [sessions, agents, delegations, agentsError, directConfig, activeAgent, selectedAgentIds, selectedAgents, toggleAgentPresence, clearAgentPresence, saveAgent, runAgent, openAgentConversation, stopDelegation, activeRuns, active, busy, loading, error, refresh, selectSession, createSession, updateSession, renameSession, pinSession, archiveSession, restoreSession, stopSessionRun]);
  if (!active) return <StartupScreen loading={loading} error={error} onRetry={boot} onContinue={canSkipImport ? continueWithoutImport : undefined} continueLabel="Continue without importing" />;
  return <WorkSessionContext.Provider value={value}>
    <VoiceProvider key={`${active.session.id}:${active.revision}`} sessionId={active.session.id} initialTranscript={active.messages || []} serverTranscript={active.messages || []} initialActiveRun={active.activeRun}>
      <BusyBridge setBusy={setBusy} /><RuntimeProvider>{children}</RuntimeProvider>
    </VoiceProvider>
  </WorkSessionContext.Provider>;
}
