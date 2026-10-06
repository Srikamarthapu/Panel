"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useVoice } from "@/components/voice/VoiceProvider.jsx";

const ACTIVE_STATES = new Set([
  "listening",
  "capturing",
  "transcribing",
  "thinking",
  "speaking",
]);

function stateLabel(state) {
  switch (state) {
    case "listening":
      return "Listening";
    case "capturing":
      return "Capturing speech";
    case "transcribing":
      return "Transcribing";
    case "thinking":
      return "Hermes is thinking";
    case "speaking":
      return "Speaking";
    case "error":
      return "Voice needs attention";
    default:
      return "Ready for voice";
  }
}

function timeLabel(value, now = 0) {
  if (!value) return "now";
  const time = new Date(value).getTime();
  if (!Number.isFinite(time) || time <= 0) return "now";
  const seconds = Math.max(0, Math.floor((now - time) / 1000));
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

export default function VoiceActionConsole() {
  const voice = useVoice();
  const reduceMotion = useReducedMotion();
  const sessionId = voice?.sessionId || "";
  const [events, setEvents] = useState([]);
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (!sessionId) return undefined;
    let cancelled = false;
    let timer = null;
    const clock = setInterval(() => setNow(Date.now()), 5000);
    setNow(Date.now());

    async function load() {
      try {
        const res = await fetch(
          `/api/voice/activity?sessionId=${encodeURIComponent(sessionId)}&limit=16`,
          { cache: "no-store" }
        );
        const json = await res.json().catch(() => ({}));
        if (!cancelled) setEvents(Array.isArray(json.events) ? json.events : []);
      } catch {
        /* leave current events in place */
      } finally {
        if (!cancelled) timer = setTimeout(load, 2200);
      }
    }

    load();
    const onActivity = (event) => {
      const item = event.detail;
      if (!item || item.sessionId !== sessionId) return;
      setEvents((current) =>
        [item, ...current.filter((entry) => entry.id !== item.id)].slice(0, 16)
      );
    };
    window.addEventListener("voice-activity", onActivity);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      clearInterval(clock);
      window.removeEventListener("voice-activity", onActivity);
    };
  }, [sessionId]);

  const rows = useMemo(() => events.slice(0, 5), [events]);
  const isLive = voice && ACTIVE_STATES.has(voice.state);
  const headline = isLive ? stateLabel(voice.state) : rows.length ? "Recent" : "Ready";

  return (
    <motion.section
      className="voiceActionConsole glass"
      aria-label="Voice action timeline"
      initial={reduceMotion ? false : { opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.28, ease: [0.2, 0, 0, 1] }}
    >
      <header className="voiceActionConsole__head">
        <div>
          <span>Voice actions</span>
          <h2>{headline}</h2>
        </div>
        <strong data-live={isLive ? "true" : "false"}>
          {isLive ? "live" : "idle"}
        </strong>
      </header>
      {rows.length === 0 ? (
        <p className="voiceActionConsole__empty">
          {isLive
            ? "Waiting for Hermes to act."
            : "Tool calls will appear here while Hermes works."}
        </p>
      ) : (
        <ul className="voiceActionConsole__list">
          <AnimatePresence initial={false}>
            {rows.map((event) => (
              <motion.li
                key={event.id}
                className="voiceActionConsole__item"
                data-kind={event.kind}
                data-state={event.state}
                initial={reduceMotion ? false : { opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
                transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
              >
                <span className="voiceActionConsole__marker" aria-hidden="true" />
                <div>
                  <strong>{event.title}</strong>
                  <p>{event.summary || event.target || "Voice step updated."}</p>
                </div>
                <time dateTime={event.updatedAt || undefined}>
                  {timeLabel(event.updatedAt, now)}
                </time>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
    </motion.section>
  );
}
