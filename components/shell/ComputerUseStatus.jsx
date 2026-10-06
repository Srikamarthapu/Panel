"use client";

import { useEffect, useMemo, useState } from "react";
import { motion, useReducedMotion } from "motion/react";

const SCREEN_TERMS = [
  "computer_use",
  "computer use",
  "screenshot",
  "screen shot",
  "screenrecord",
  "screen record",
  "screen recording",
  "mouse",
  "cursor",
  "click",
  "typed",
  "keyboard",
];

function eventText(item) {
  return `${item?.kind || ""} ${item?.label || ""} ${item?.title || ""} ${item?.summary || ""} ${item?.source || ""}`.toLowerCase();
}

function findComputerUseEvent(activity) {
  if (!Array.isArray(activity)) return null;
  return activity.find((item) => SCREEN_TERMS.some((term) => eventText(item).includes(term))) || null;
}

export default function ComputerUseStatus({ initialActivity = [] }) {
  const reduceMotion = useReducedMotion();
  const [activity, setActivity] = useState(initialActivity);
  const [lastChecked, setLastChecked] = useState(null);
  const latest = useMemo(() => findComputerUseEvent(activity), [activity]);
  const isWatching = Boolean(latest);

  useEffect(() => {
    let stopped = false;
    let timer = null;

    async function poll() {
      try {
        const response = await fetch("/api/mission-control", { cache: "no-store" });
        if (!response.ok) throw new Error(`status_${response.status}`);
        const json = await response.json();
        if (!stopped) {
          setActivity(Array.isArray(json?.activity) ? json.activity : []);
          setLastChecked(new Date().toISOString());
        }
      } catch {
        if (!stopped) setLastChecked(new Date().toISOString());
      } finally {
        if (!stopped) timer = setTimeout(poll, 5000);
      }
    }

    timer = setTimeout(poll, 1200);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return (
    <motion.section
      className="computerUseStatus glass"
      aria-label="Computer use visibility"
      initial={reduceMotion ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: [0.2, 0, 0, 1] }}
    >
      <div className="computerUseStatus__top">
        <span className="computerUseStatus__dot" data-active={isWatching ? "true" : "false"} aria-hidden="true" />
        <div>
          <strong>{isWatching ? "Computer use visible" : "Computer use idle"}</strong>
          <p>{isWatching ? "Recent screen or input action detected." : "No recent screen capture or input action."}</p>
        </div>
      </div>
      <div className="computerUseStatus__details">
        <span>Screen capture</span>
        <strong>{isWatching ? "reported" : "off"}</strong>
        <span>Last action</span>
        <strong>{latest?.title || "none"}</strong>
        <span>Checked</span>
        <strong>{lastChecked ? new Date(lastChecked).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "now"}</strong>
      </div>
    </motion.section>
  );
}
