"use client";

// AgentActivityLine — a single line that appears under the Voice Dock and
// shows what Hermes is doing right now ("calling X tool", "wrote memory",
// etc.). Polls /api/mission-control for the most recent activity item.
// Hides itself if the latest item is older than FRESH_MS.

import { useEffect, useState } from "react";

const POLL_MS = 5000;
const FRESH_MS = 30000;

export default function AgentActivityLine() {
  const [latest, setLatest] = useState(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let stopped = false;
    let timer = null;

    const tick = async () => {
      try {
        const res = await fetch("/api/mission-control");
        if (!res.ok) return;
        const data = await res.json();
        const items = Array.isArray(data?.activity) ? data.activity : [];
        const top = items[0] ?? null;
        if (!stopped) setLatest(top);
      } catch {
        /* noop */
      } finally {
        if (!stopped) {
          setNow(Date.now());
          timer = setTimeout(tick, POLL_MS);
        }
      }
    };

    tick();
    const refresh = setInterval(() => setNow(Date.now()), POLL_MS);

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      clearInterval(refresh);
    };
  }, []);

  if (!latest?.title) return null;

  if (latest.updatedAt) {
    const ts = new Date(latest.updatedAt).getTime();
    if (Number.isFinite(ts) && now - ts > FRESH_MS) return null;
  }

  return (
    <p className="agentActivityLine" aria-live="polite">
      <span className="agentActivityLine__dot" aria-hidden="true" />
      <span className="agentActivityLine__text">{latest.title}</span>
    </p>
  );
}
