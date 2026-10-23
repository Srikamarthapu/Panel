"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Brain, CircleAlert, RefreshCw, UserRound } from "lucide-react";
import { useWorkSessions, workRequest } from "./WorkSessionProvider.jsx";
import styles from "./MemoryWorkspace.module.css";

const date = value => value ? new Date(value).toLocaleString() : "No activity yet";

function MemoryText({ value, empty }) {
  const content = value || empty;
  if (content.length <= 900) return <p className={styles.prose}>{content}</p>;
  const preview = `${content.slice(0, 700).trimEnd()}…`;
  return <div className={styles.memoryText}><p className={styles.prose}>{preview}</p><details><summary>Show full content</summary><p className={styles.prose}>{content}</p></details></div>;
}

export default function MemoryWorkspace() {
  const work = useWorkSessions();
  const observedRoster = useRef(null);
  const [data, setData] = useState(null), [selected, setSelected] = useState("main"), [error, setError] = useState(""), [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const next = await workRequest("/api/memory");
      setData(next);
      setSelected(current => next.people.some(person => person.id === current) ? current : "main");
    } catch (failure) { setError(failure.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const rosterSignature = useMemo(() => work.agents.map(agent => `${agent.id}:${agent.updatedAt || ""}`).sort().join("|"), [work.agents]);
  useEffect(() => {
    if (observedRoster.current === null) { observedRoster.current = rosterSignature; return; }
    if (observedRoster.current === rosterSignature) return;
    observedRoster.current = rosterSignature;
    void load();
  }, [load, rosterSignature]);
  const people = useMemo(() => (data?.people || []).map(stored => {
    if (stored.kind === "saved") {
      const live = work.agents.find(item => item.id === stored.id);
      if (!live) return stored;
      const policy = live.capabilityPolicy;
      const activity = live.activeRun ? { ...live.activeRun, task: live.activeRun.task || live.activeRun.taskLabel || "" } : null;
      return { ...stored, archivedAt: live.archivedAt || null, activity, capabilitySummary: policy ? `${policy.tools.ids.length} tools · ${policy.skills.ids.length} skills` : "Legacy inherited access" };
    }
    const rawActive = work.sessions.find(session => !session.agentId && !session.workspaceRole && session.activeRun)?.activeRun || null;
    const active = rawActive ? { ...rawActive, task: rawActive.task || rawActive.taskLabel || "" } : null;
    return { ...stored, activity: active };
  }), [data, work.agents, work.sessions]);
  const person = useMemo(() => people.find(item => item.id === selected) || people[0], [people, selected]);

  if (loading && !data) return <div className={styles.state} role="status" aria-live="polite"><Brain aria-hidden="true" /><p>Reading shared memory and teammate histories…</p></div>;
  if (error && !data) return <div className={styles.state} role="alert"><CircleAlert aria-hidden="true" /><p>{error}</p><button type="button" onClick={load}><RefreshCw size={14} aria-hidden="true" />Retry</button></div>;
  if (!data || !person) return <div className={styles.state}><p>No assistant context is available yet.</p></div>;

  const directMode = work.directConfig?.executionMode === "direct";
  return <div className={styles.workspace} aria-busy={loading}>
    <aside className={styles.people} aria-label="Assistants"><div className={styles.peopleHead}><span>Assistants</span><small>{people.length}</small></div>{people.map(item => <button type="button" key={item.id} className={item.id === person.id ? styles.selected : ""} aria-pressed={item.id === person.id} onClick={() => setSelected(item.id)}><UserRound size={16} aria-hidden="true" /><span><strong>{item.name}</strong><small>{item.activity ? item.activity.statusLabel || "Working" : item.capabilitySummary}</small></span></button>)}</aside>
    <section className={styles.detail} aria-label={`${person.name} memory and history`}>
      {error && <div className={styles.inlineError} role="alert"><span>{error}</span><button type="button" onClick={load}>Retry</button></div>}
      <header className={styles.profileHead}><div><span>{person.kind === "main" ? "Primary assistant" : "Saved teammate"}</span><h2>{person.name}</h2><p>{person.capabilitySummary}{directMode ? " · Direct runtime has no tools, skill loader, or Hermes memory" : " · Hermes runtime"}</p></div><div className={styles.headerActions}><div className={person.activity ? styles.active : styles.idle}>{person.activity ? "Working now" : person.archivedAt ? "Archived" : "Idle"}</div><button type="button" onClick={load} disabled={loading}><RefreshCw size={13} aria-hidden="true" />{loading ? "Refreshing…" : "Refresh"}</button><small>Stored content as of {date(data.generatedAt)}</small></div></header>
      {person.activity && <section className={styles.activity} aria-labelledby="memory-current-activity"><h3 id="memory-current-activity">Current activity</h3><strong>{person.activity.statusLabel || "Working"}</strong>{person.activity.task && <p>{person.activity.task}</p>}<time>{date(person.activity.updatedAt)}</time></section>}
      <section className={styles.section} aria-labelledby="memory-role"><h3 id="memory-role">Role and instructions</h3><p className={styles.prose}>{person.role}</p><small>{person.storage.role}</small></section>
      <section className={styles.section} aria-labelledby="memory-conversations"><h3 id="memory-conversations">Recent conversations</h3><p className={styles.ownership}>{person.storage.conversations}</p>{person.conversations.length ? <div className={styles.conversations}>{person.conversations.map(conversation => <details key={conversation.id}><summary><span>{conversation.name}</span><time>{date(conversation.updatedAt)}</time></summary>{conversation.messages.length ? conversation.messages.map(message => <div key={message.id} className={styles.message} data-role={message.role}><strong>{message.role === "user" ? "You" : person.name}</strong><p>{message.text}</p></div>) : <p className={styles.muted}>No messages in this conversation.</p>}</details>)}</div> : <p className={styles.muted}>No conversations for this assistant yet.</p>}</section>
      <section className={styles.section} aria-labelledby="memory-shared"><div className={styles.sharedHead}><div><h3 id="memory-shared">{data.scope.title}</h3><p>{data.scope.description}</p></div><Brain aria-hidden="true" /></div><p className={styles.ownership}>{directMode ? "This shared Hermes memory is stored here, but it is not sent to direct-runtime conversations." : person.storage.memory}</p><div className={styles.memoryGrid}><article><h4>User profile</h4><MemoryText value={data.sharedMemory.user} empty="No saved user profile content yet." /></article><article><h4>Long-term memory</h4><MemoryText value={data.sharedMemory.memory} empty="No saved long-term memory content yet." /></article></div><details className={styles.files}><summary>{data.sharedMemory.files.length} shared memory files</summary><ul>{data.sharedMemory.files.map(file => <li key={file.path}><span>{file.name}</span><small>{file.words} words · {date(file.updatedAt)}</small></li>)}</ul></details></section>
    </section>
  </div>;
}
