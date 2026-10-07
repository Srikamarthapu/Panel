"use client";
import { useEffect, useRef, useState } from "react";
import { useWorkSessions } from "./WorkSessionProvider.jsx";
export default function useAgentsPane() {
  const work = useWorkSessions();
  const [open, setOpen] = useState(false), seen = useRef(new Set());
  useEffect(() => { try { setOpen(sessionStorage.getItem("panel.agents.open") === "true"); } catch {} }, []);
  function show(value) { setOpen(value); try { sessionStorage.setItem("panel.agents.open", String(value)); } catch {} }
  const keys = [...(work?.agents || []).filter(a => a.activeRun && a.sessionId !== work?.activeSession?.id).map(a => a.activeRun.id), ...(work?.delegations || []).filter(a => ["queued", "running"].includes(a.status)).map(a => `${a.runId}:${a.id}`)];
  const signature = keys.join("|");
  useEffect(() => {
    if (keys.some(key => !seen.current.has(key))) show(true);
    keys.forEach(key => seen.current.add(key));
  }, [signature]);
  return [open, show];
}
