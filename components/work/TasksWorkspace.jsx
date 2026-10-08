"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Clock3, Plus, Square } from "lucide-react";
import { useWorkSessions, workRequest } from "./WorkSessionProvider.jsx";
import { MAX_USER_TEXT } from "@/lib/conversation-limits.js";

const labels = { queued: "Queued", running: "Working", complete: "Completed", error: "Needs attention", cancelled: "Stopped", interrupted: "Interrupted" };
export default function TasksWorkspace() {
  const work = useWorkSessions();
  const router = useRouter();
  const [data, setData] = useState({ tasks: [], worker: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [sessionId, setSessionId] = useState(work?.activeSession?.id || "");
  const [runAt, setRunAt] = useState("");
  const [pending, setPending] = useState(false);
  const [filter, setFilter] = useState("upcoming");
  const submission = useRef(null);
  const availableSessions = (work?.sessions || []).filter(session => !session.archivedAt);
  const refresh = async () => { const next = await workRequest("/api/tasks"); setData(next); setError(""); setLoading(false); };
  useEffect(() => {
    setSessionId(current => availableSessions.some(session => session.id === current)
      ? current
      : availableSessions.find(session => session.id === work?.activeSession?.id)?.id || availableSessions[0]?.id || "");
  }, [work?.activeSession?.id, work?.sessions]);
  useEffect(() => {
    let stopped = false, timer;
    async function poll() {
      try { const next = await workRequest("/api/tasks"); if (!stopped) { setData(next); setError(""); } }
      catch (failure) { if (!stopped) setError(failure.message); }
      finally { if (!stopped) { setLoading(false); timer = setTimeout(poll, 3000); } }
    }
    void poll(); void work?.refresh();
    return () => { stopped = true; clearTimeout(timer); };
  }, [work?.refresh]);
  async function enqueue(event) {
    event.preventDefault(); setPending(true); setError("");
    try {
      const input = { prompt: prompt.trim(), sessionId, ...(runAt ? { runAt: new Date(runAt).toISOString() } : {}) };
      const signature = JSON.stringify(input);
      if (submission.current?.signature !== signature) submission.current = { signature, requestId: crypto.randomUUID() };
      await workRequest("/api/tasks", { method: "POST", body: JSON.stringify({ ...input, requestId: submission.current.requestId }) });
      submission.current = null;
      setPrompt(""); setRunAt(""); setCreating(false); setFilter("upcoming"); await refresh();
    } catch (failure) { setError(failure.message); } finally { setPending(false); }
  }
  async function cancel(id) {
    setPending(true);
    try { await workRequest("/api/tasks", { method: "PATCH", body: JSON.stringify({ id, action: "cancel" }) }); await refresh(); }
    catch (failure) { setError(failure.message); } finally { setPending(false); }
  }
  async function open(id) {
    try { await work.selectSession(id); router.push("/chat"); } catch (failure) { setError(failure.message); }
  }
  const upcoming = data.tasks.filter(task => ["queued", "running"].includes(task.state));
  const list = filter === "upcoming" ? upcoming : data.tasks.filter(task => !["queued", "running"].includes(task.state));
  return <section className="workPage">
    <header className="workPage__heading"><div><span className="workEyebrow">LET YOUR AGENT WORK</span><h1>Good work takes time.</h1><p>Queue a clear request for now or later. Come back to the result in its session.</p></div><button className="workButton" onClick={() => setCreating(!creating)} aria-expanded={creating}><Plus size={16} />Queue a task</button></header>
    <div className="queueHealth"><span className="statusDot" data-tone={data.worker?.running ? "online" : "warning"} /><strong>{loading ? "Checking the worker…" : data.worker?.running ? "Worker ready" : "Worker offline"}</strong><span>{!loading && !data.worker?.running ? "Start Panel with npm start or npm run dev to process queued work." : "Keep Panel and your Mac running. You can close this browser."}</span></div>
    {error && <p className="workError" role="alert">{error}</p>}
    {creating && <form className="workForm" onSubmit={enqueue}>
      <label>What should your agent do?<textarea autoFocus required value={prompt} onChange={event => setPrompt(event.target.value)} maxLength={MAX_USER_TEXT} rows={4} placeholder="Describe the outcome, relevant files, and how to check the result." /></label>
      <div className="workForm__pair"><label>Session<select value={sessionId} onChange={event => setSessionId(event.target.value)} required>{availableSessions.map(session => <option key={session.id} value={session.id}>{session.name}</option>)}</select></label><label>Start after <span className="workOptional">Optional · local time</span><input type="datetime-local" value={runAt} onChange={event => setRunAt(event.target.value)} /></label></div>
      <p className="workHelp">Blank means as soon as the worker and session are free. Tasks use the session’s folder and model settings when they start. They run unattended; if one stops, review it in History and continue from its session.</p>
      <div className="workForm__actions"><button type="button" className="workButton workButton--quiet" onClick={() => setCreating(false)}>Cancel</button><button className="workButton" disabled={pending || !prompt.trim() || !sessionId}>{pending ? "Adding…" : "Add to queue"}</button></div>
    </form>}
    <div className="workTabs" aria-label="Task views"><button aria-pressed={filter === "upcoming"} onClick={() => setFilter("upcoming")}>Upcoming <span>{upcoming.length}</span></button><button aria-pressed={filter === "history"} onClick={() => setFilter("history")}>History <span>{data.tasks.length - upcoming.length}</span></button></div>
    <div className="taskList">{list.map(task => <article key={task.id} className="taskRow"><div className="taskRow__top"><span className={`workTag workTag--${task.state}`}>{labels[task.state] || task.state}</span><time dateTime={task.runAt}><Clock3 size={13} />{new Date(task.runAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time></div><h2>{task.prompt}</h2><div className="taskRow__bottom"><button className="workTextButton" disabled={work?.busy} onClick={() => open(task.sessionId)}>{work?.sessions.find(session => session.id === task.sessionId)?.name || "Open session"}<ArrowUpRight size={14} /></button>{["queued", "running"].includes(task.state) && <button className="workTextButton" disabled={pending} onClick={() => cancel(task.id)}><Square size={12} />{task.state === "running" ? "Stop" : "Cancel"}</button>}</div>{task.error && <p className="workError">{task.error}</p>}{task.response && <details className="taskResult"><summary>Read result</summary><p>{task.response}</p></details>}</article>)}{!loading && !list.length && <div className="workEmpty"><Clock3 size={25} strokeWidth={1.2} /><h2>{filter === "upcoming" ? "Nothing waiting on you." : "Results will gather here."}</h2><p>{filter === "upcoming" ? "Give your agent a task, then get on with your day." : "Completed, stopped, and interrupted tasks stay here for review."}</p></div>}</div>
  </section>;
}
