"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, ArrowUpRight, Folder, MessageSquare, Pencil, Pin, Plus, Search } from "lucide-react";
import { useWorkSessions } from "./WorkSessionProvider.jsx";
import SessionDialog from "./SessionDialog.jsx";
import { sessionRunLabel } from "./AgentsPane.jsx";

export default function SessionsWorkspace() {
  const work = useWorkSessions();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [view, setView] = useState("active");
  const [editing, setEditing] = useState(null);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { work?.refresh().catch(failure => setError(failure.message)); }, [work?.refresh]);
  const list = (work?.sessions || []).filter(s => Boolean(s.archivedAt) === (view === "archived") && `${s.name} ${s.workingDirectory || ""}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  async function act(id, action) {
    setPending(id); setError("");
    try { await action(); } catch (failure) { setError(failure.message); } finally { setPending(""); }
  }
  return <section className="workPage sessionsPage">
    <header className="workPage__heading"><div><h1>Sessions</h1><p>Your conversations, context, and working folders.</p></div><button type="button" className="workButton" disabled={work?.busy || Boolean(pending)} onClick={() => setEditing({})}><Plus size={16} />New session</button></header>
    {work?.busy && <p className="workNotice" role="status">Finish recording or sending before switching sessions. Accepted agent work can continue in the background.</p>}
    {error && <p className="workError" role="alert">{error}</p>}
    <div className="sessionsToolbar"><div className="workTabs" aria-label="Session view"><button type="button" aria-pressed={view === "active"} onClick={() => setView("active")}>Active</button><button type="button" aria-pressed={view === "archived"} onClick={() => setView("archived")}>Archived</button></div><label className="workSearch"><Search size={15} /><input type="search" aria-label="Search sessions" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a session…" /></label></div>
    <ul className="sessionList">{list.map(session => <li className="managedSession" key={session.id}>
      <button type="button" className="sessionRow" onClick={() => act(session.id, async () => { await work.selectSession(session.id); router.push("/chat"); })} disabled={Boolean(pending) || work?.busy || Boolean(session.archivedAt)}>
        <span className="sessionRow__icon">{session.pinned ? <Pin size={17} /> : <MessageSquare size={18} />}</span><span className="sessionRow__body"><strong>{session.name}</strong><span><Folder size={12} />{session.workingDirectory || "Panel workspace"}</span></span><span className="sessionRow__aside"><span className={session.activeRun ? "sessionRunStatus" : "sessionDate"}>{session.activeRun ? sessionRunLabel(session) : work?.activeSession?.id === session.id ? "Current" : new Date(session.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>{!session.archivedAt && <ArrowUpRight size={15} />}</span>
      </button>
      <div className="sessionActions" role="group" aria-label={`Manage ${session.name}`}>
        {session.archivedAt ? <button type="button" className="iconButton" title="Restore session" aria-label={`Restore ${session.name}`} disabled={Boolean(pending)} onClick={() => act(session.id, () => work.restoreSession(session.id))}><ArchiveRestore size={16} /></button> : <><button type="button" className="iconButton" title="Edit details" aria-label={`Edit ${session.name}`} disabled={Boolean(pending)} onClick={() => setEditing(session)}><Pencil size={15} /></button><button type="button" className="iconButton" title={session.pinned ? "Unpin session" : "Pin session"} aria-label={`${session.pinned ? "Unpin" : "Pin"} ${session.name}`} aria-pressed={Boolean(session.pinned)} disabled={Boolean(pending)} onClick={() => act(session.id, () => work.pinSession(session.id, !session.pinned))}><Pin size={15} /></button><button type="button" className="iconButton" title={session.activeRun ? "Stop the agent before archiving" : "Archive session"} aria-label={`Archive ${session.name}`} disabled={Boolean(pending) || Boolean(session.activeRun) || (work?.busy && work.activeSession?.id === session.id)} onClick={() => act(session.id, () => work.archiveSession(session.id))}><Archive size={16} /></button></>}
      </div>
    </li>)}</ul>
    {!list.length && <div className="workEmpty"><h2>{query ? "No matching sessions" : view === "archived" ? "No archived sessions" : "Start your first session"}</h2><p>{query ? "Try another name or folder." : view === "archived" ? "Archived sessions stay saved and can be restored here." : "Create a conversation you can return to."}</p></div>}
    <p className="sessionsFootnote">{list.length} {list.length === 1 ? "session" : "sessions"} · Archive keeps your conversation and context.</p>
    {editing && <SessionDialog session={editing.id ? editing : null} onClose={() => setEditing(null)} onSaved={() => { if (!editing.id) router.push("/chat"); }} />}
  </section>;
}
