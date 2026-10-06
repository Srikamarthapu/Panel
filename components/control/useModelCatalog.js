"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export default function useModelCatalog() {
  const [catalog, setCatalog] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const requestRef = useRef(null);

  const load = useCallback(async (refresh = false, provider = "") => {
    requestRef.current?.abort();
    const controller = new AbortController();
    const timeoutSignal = AbortSignal.timeout(refresh ? 20_000 : 15_000);
    const signal = AbortSignal.any([controller.signal, timeoutSignal]);
    requestRef.current = controller;
    if (refresh) setRefreshing(true);
    setError("");
    setWarning("");
    try {
      const params = new URLSearchParams();
      if (refresh) params.set("refresh", "1");
      if (provider) params.set("provider", provider);
      const query = params.toString();
      const response = await fetch(`/api/models/catalog${query ? `?${query}` : ""}`, {
        cache: "no-store",
        signal,
      });
      const data = await response.json().catch(() => {
        throw new Error("The local model catalog returned an unreadable response. Run npm run doctor for compatibility details.");
      });
      if (!response.ok || data?.ok === false) {
        throw new Error(data?.error || "The local model catalog could not be read. Run npm run doctor for compatibility details.");
      }
      if (!controller.signal.aborted) setCatalog(data);
      if (!controller.signal.aborted && data?.warning) setWarning(data.warning);
      return data;
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(timeoutSignal.aborted || failure.name === "TimeoutError"
          ? "The local model catalog timed out. Try again."
          : failure.name === "TypeError"
            ? "The local model catalog endpoint could not be reached. Try again."
            : failure.message || "The local model catalog could not be read. Run npm run doctor for compatibility details.");
      }
      return null;
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    load();
    return () => requestRef.current?.abort();
  }, [load]);

  return { catalog, loading, refreshing, error, warning, load };
}
