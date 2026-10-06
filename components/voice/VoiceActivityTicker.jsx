"use client";

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  formatTickerEvent,
  selectLiveStatus,
  selectTickerEvents,
} from "@/components/voice/voiceActivityTicker.js";

const POLL_MS = 5000;
const ROTATE_MS = 3500;
const FETCH_TIMEOUT_MS = 4000;
// While a detached action/data run is in flight, poll the voice-activity store
// fast so the present-tense status ("Checking your calendar…") appears promptly
// and clears the moment the run finishes.
const LIVE_POLL_MS = 2000;
const tickerStyle = {
  display: "block",
  maxWidth: "100%",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

export default function VoiceActivityTicker({ fallback, sessionId }) {
  const [activity, setActivity] = useState([]);
  const [liveStatus, setLiveStatus] = useState(null);
  const [index, setIndex] = useState(0);
  const [, bumpTick] = useReducer((value) => value + 1, 0);
  const abortRef = useRef(null);

  useEffect(() => {
    let stopped = false;
    let timer = null;

    const schedule = (delay = POLL_MS) => {
      if (!stopped) timer = setTimeout(fetchActivity, Math.max(0, delay));
    };

    const fetchActivity = async () => {
      const startedAt = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      abortRef.current = controller;
      try {
        const res = await fetch("/api/mission-control", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`status_${res.status}`);
        const json = await res.json();
        if (!stopped) {
          setActivity(Array.isArray(json?.activity) ? json.activity : []);
          setIndex(0);
          bumpTick();
        }
      } catch {
        // Keep the previous real event visible on transient failures.
      } finally {
        clearTimeout(timeout);
        if (abortRef.current === controller) abortRef.current = null;
        schedule(POLL_MS - (Date.now() - startedAt));
      }
    };

    fetchActivity();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
    };
  }, []);

  // Live-status poll (T-0008 fix C): watch the voice-activity store for an
  // in-flight action/data run and surface its present-tense label. Separate
  // from the mission-control rotation poll above so the two data sources stay
  // independent; this one is session-scoped and polls fast.
  useEffect(() => {
    let stopped = false;
    let timer = null;
    let controller = null;

    const poll = async () => {
      controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const q = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}&limit=40` : "?limit=40";
        const res = await fetch(`/api/voice/activity${q}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (res.ok) {
          const json = await res.json();
          const events = Array.isArray(json?.events) ? json.events : [];
          if (!stopped) {
            setLiveStatus(selectLiveStatus(events, { sessionId }));
            bumpTick();
          }
        }
      } catch {
        // Keep the previous value on transient failures.
      } finally {
        clearTimeout(timeout);
        if (!stopped) timer = setTimeout(poll, LIVE_POLL_MS);
      }
    };

    poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (controller) controller.abort();
    };
  }, [sessionId]);

  const items = useMemo(() => selectTickerEvents(activity), [activity]);

  useEffect(() => {
    if (items.length <= 1) return undefined;
    const id = setInterval(() => {
      setIndex((current) => (current + 1) % items.length);
      bumpTick();
    }, ROTATE_MS);
    return () => clearInterval(id);
  }, [items.length]);

  const active = items[index % Math.max(1, items.length)] || null;
  const now = Date.now();
  // Live status wins: while a run is in flight, show its present-tense label
  // exclusively, overriding the historical rotation (T-0008 fix C). It clears
  // the instant the run finishes, returning the ticker to normal T-0007
  // behavior.
  const line = liveStatus
    ? liveStatus.label
    : active
      ? formatTickerEvent(active, now)
      : fallback;

  return (
    <span
      className="voiceDock__ticker"
      data-live={liveStatus ? "true" : undefined}
      style={tickerStyle}
      title={liveStatus ? liveStatus.label : active ? line : undefined}
    >
      {line}
    </span>
  );
}
