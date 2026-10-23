"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useWorkSessions } from "@/components/work/WorkSessionProvider.jsx";

const ModelResolutionContext = createContext(null);
const SURFACES = ["chat", "talk"];

function resolutionUrl(surface, sessionId) {
  const params = new URLSearchParams({ surface });
  if (sessionId) params.set("sessionId", sessionId);
  return `/api/models/resolution?${params}`;
}

async function readJson(response) {
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || "Panel could not read the model used for the next request.");
  return value;
}

export default function ModelResolutionProvider({ children }) {
  const work = useWorkSessions();
  const sessionId = work?.activeSession?.id || "";
  const directSignature = [work?.directConfig?.executionMode, work?.directConfig?.provider, work?.directConfig?.model].join(":");
  const activeAgentSignature = [work?.activeAgent?.id, work?.activeAgent?.name, work?.activeAgent?.provider, work?.activeAgent?.model].join(":");
  const [state, setState] = useState({ chat: null, talk: null, preferences: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const request = useRef(null);
  const mutation = useRef(null);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  const applyPayload = useCallback((surface, payload) => {
    setState(current => ({
      ...current,
      ...(payload?.resolutions || {}),
      ...(payload?.resolution ? { [surface]: payload.resolution } : {}),
      ...(payload?.preferences ? { preferences: payload.preferences } : {}),
    }));
  }, []);

  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    try {
      const values = await Promise.all(SURFACES.map(async surface => {
        const response = await fetch(resolutionUrl(surface, sessionId), { cache: "no-store", signal: controller.signal });
        return [surface, await readJson(response)];
      }));
      if (controller.signal.aborted) return null;
      setState(current => {
        const next = { ...current };
        for (const [surface, payload] of values) {
          next[surface] = payload.resolution || null;
          if (payload.preferences) next.preferences = payload.preferences;
        }
        return next;
      });
      return Object.fromEntries(values);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure.message || "Panel could not read the model used for the next request.");
      return null;
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [sessionId, directSignature, activeAgentSignature]);

  useEffect(() => {
    mutation.current?.abort();
    setState(current => ({ ...current, chat: null, talk: null }));
    refresh();
    return () => { request.current?.abort(); mutation.current?.abort(); };
  }, [refresh]);

  useEffect(() => {
    const handleRefresh = () => { void refresh(); };
    const handleFocus = handleRefresh;
    window.addEventListener("focus", handleFocus);
    window.addEventListener("panel-runtime-changed", handleRefresh);
    return () => {
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("panel-runtime-changed", handleRefresh);
    };
  }, [refresh]);

  const updateSurface = useCallback(async (surface, change) => {
    request.current?.abort();
    mutation.current?.abort();
    const controller = new AbortController();
    mutation.current = controller;
    const mutationSession = sessionId;
    setLoading(false);
    setError("");
    const response = await fetch("/api/models/resolution", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ surface, ...(sessionId ? { sessionId } : {}), ...change }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
    });
    const payload = await readJson(response);
    if (!controller.signal.aborted && sessionRef.current === mutationSession) applyPayload(surface, payload);
    return payload;
  }, [applyPayload, sessionId]);

  const switchMain = useCallback(async ({ provider, model }) => {
    request.current?.abort();
    mutation.current?.abort();
    const controller = new AbortController();
    mutation.current = controller;
    const mutationSession = sessionId;
    setLoading(false);
    setError("");
    const response = await fetch("/api/models/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "primary", provider, model, ...(sessionId ? { sessionId } : {}) }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
    });
    const payload = await readJson(response);
    if (!controller.signal.aborted && sessionRef.current === mutationSession) await refresh();
    return payload;
  }, [refresh, sessionId]);

  const value = useMemo(() => ({ ...state, loading, error, refresh, updateSurface, switchMain, applyPayload }), [state, loading, error, refresh, updateSurface, switchMain, applyPayload]);
  return <ModelResolutionContext.Provider value={value}>{children}</ModelResolutionContext.Provider>;
}

export function useModelResolution() {
  const context = useContext(ModelResolutionContext);
  if (!context) throw new Error("useModelResolution requires ModelResolutionProvider");
  return context;
}
