"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, CircleAlert, Plus, Square, X } from "lucide-react";
import { useWorkSessions } from "./WorkSessionProvider.jsx";
import MissionOrb from "@/components/MissionOrb.jsx";
import { useInterfacePreferences } from "@/components/preferences/InterfacePreferencesProvider.jsx";

export function sessionRunLabel(session) {
  const run = session.activeRun || session.lastRun;
  if (!run) return "Ready for a task";
  if (session.activeRun) return run.executionCancelRequestedAt ? "Stopping…" : run.permissionPending ? "Needs your attention" : run.statusLabel || "Working";
  return { complete: "Complete", completed: "Complete", error: "Needs attention", failed: "Needs attention", cancelled: "Stopped", interrupted: "Interrupted" }[run.state] || "Ready";
}
export default function AgentsPane({ onClose, onNew }) {
  const work = useWorkSessions();
  const container = useRef(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width:1100px)");
    const update = () => setCompact(media.matches);
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => { if (compact && container.current && !container.current.open) container.current.showModal(); }, [compact]);
  const Container = compact ? "dialog" : "aside";
  const { avatar } = useInterfacePreferences();
  const [error, setError] = useState("");
  const [pending, setPending] = useState("");
  const sessions = (work?.sessions || []).filter(s => !s.archivedAt && (s.activeRun || s.lastRun || s.id === work.activeSession?.id));
  sessions.sort((a, b) => Number(Boolean(b.activeRun)) - Number(Boolean(a.activeRun)) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  async function act(id, action) {
    setPending(id); setError("");
    try { await action(); } catch (failure) { setError(failure.message); } finally { setPending(""); }
  }
  return <Container ref={container} onCancel={event => { event.preventDefault(); onClose(); }} className="agentsPane" id="agents-pane" aria-label="Agent sessions">
    <header><div><h2>Agents</h2><p>{work?.activeRuns?.length || 0} working · up to 4 at once</p></div><button type="button" className="iconButton" aria-label="Close agents" onClick={onClose}><X size={17} /></button></header>
    <button type="button" className="agentsPane__new" onClick={onNew} disabled={work?.busy}><Plus size={16} />New agent</button>
    {work?.busy && <p className="fieldHelp">Finish the voice interaction or wait for this request to be accepted before switching.</p>}
    {error && <p className="workError" role="alert">{error}</p>}
    <div className="agentsPane__list">{sessions.map(session => {
      const run = session.activeRun || session.lastRun;
      const running = Boolean(session.activeRun);
      const failed = ["error", "failed", "interrupted"].includes(run?.state);
      const current = session.id === work.activeSession?.id;
      return <article className="agentsPaneCard" key={session.id} data-current={current || undefined} data-running={running || undefined}>
        <div className="agentsPaneCard__top">{running ? <MissionOrb size="inline" avatar={avatar} voiceState="thinking" /> : failed ? <CircleAlert size={16} /> : run ? <Check size={16} /> : <span className="agentsPaneCard__dot" />}<strong>{session.name}</strong>{current && <span className="agentsPaneCard__current">Current</span>}</div>
        <p role={running ? "status" : undefined}>{sessionRunLabel(session)}</p>
        {session.workingDirectory && <small title={session.workingDirectory}>{session.workingDirectory.split("/").filter(Boolean).at(-1)}</small>}
        <footer><button type="button" className="workTextButton" disabled={current || work?.busy || pending === session.id} onClick={() => act(session.id, () => work.selectSession(session.id))}>Open<ArrowUpRight size={13} /></button>{running && <button type="button" className="workTextButton" disabled={pending === session.id || Boolean(run.executionCancelRequestedAt)} onClick={() => act(session.id, () => work.stopSessionRun(session.id, run.id))}><Square size={11} />Stop</button>}</footer>
      </article>;
    })}</div>
    <p className="agentsPane__note">Give each agent a task in its conversation. Switch sessions while accepted work continues.</p>
  </Container>;
}
