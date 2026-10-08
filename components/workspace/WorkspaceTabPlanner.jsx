"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp, X, Square, ArrowUpRight, Archive, RotateCcw } from "lucide-react";
import WorkspaceTabView from "./WorkspaceTabView.jsx";
import styles from "./WorkspaceTabPlanner.module.css";

async function request(url, options = {}) {
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15000), ...options, headers: { "Content-Type": "application/json", ...options.headers } });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "Panel could not save this change.");
  return value;
}
const busyRun = run => run && (["queued", "active"].includes(run.state) || run.executionActive);
export default function WorkspaceTabPlanner({ initialId, savedTabs = [], onClose, onChanged }) {
  const router = useRouter(), dialog = useRef(null), input = useRef(null), transcript = useRef(null);
  const sending = useRef(false), requestId = useRef(null), createId = useRef(null), mounted = useRef(true);
  const [id, setId] = useState(initialId || null), [details, setDetails] = useState(null);
  const [draft, setDraft] = useState(""), [pending, setPending] = useState(false), [error, setError] = useState("");
  const [optimistic, setOptimistic] = useState(null), [showPreview, setShowPreview] = useState(false);
  const [archiveConfirm, setArchiveConfirm] = useState(false);
  const tab = details?.tab, run = details?.run, busy = pending || busyRun(run) || tab?.phase === "building";
  const plan = tab?.suggestedPlan;
  useEffect(() => {
    mounted.current = true;
    const trigger = document.activeElement, modal = dialog.current;
    modal?.showModal(); input.current?.focus();
    return () => { mounted.current = false; modal?.close(); if (trigger?.isConnected) trigger.focus?.(); };
  }, []);
  useEffect(() => {
    if (!id) return;
    let cancelled = false, timer;
    async function poll() {
      try {
        const result = await request(`/api/workspace-tabs/${id}`);
        if (cancelled) return;
        setDetails(result);
        setOptimistic(previous => result.messages.some(item => item.role === "user" && item.runId === previous?.requestId) ? null : previous);
      } catch (failure) { if (!cancelled) setError(failure.message); }
      if (!cancelled) timer = setTimeout(poll, 1500);
    }
    poll(); return () => { cancelled = true; clearTimeout(timer); };
  }, [id]);
  useEffect(() => {
    if (!transcript.current) return;
    const node = transcript.current;
    if (node.scrollHeight - node.scrollTop - node.clientHeight < 180 || pending) node.scrollTop = node.scrollHeight;
  }, [details?.messages?.length, run?.response, pending]);
  async function refresh(target = id) {
    const next = await request(`/api/workspace-tabs/${target}`);
    if (mounted.current) setDetails(next);
    onChanged(); return next;
  }
  async function action(type, extra = {}) {
    if (sending.current) return;
    sending.current = true; setPending(true); setError("");
    try {
      const key = JSON.stringify([type, extra]);
      if (requestId.current?.key !== key) requestId.current = { key, id: crypto.randomUUID() };
      await request(`/api/workspace-tabs/${id}`, { method: "POST", body: JSON.stringify({ action: type, requestId: requestId.current.id, ...extra }) });
      requestId.current = null;
      await refresh();
      if (type === "build") setShowPreview(false);
      if (type === "publish") { onClose(); router.push(`/workspace/${id}`); }
    } catch (failure) { if (mounted.current) setError(failure.message); }
    finally { sending.current = false; if (mounted.current) setPending(false); }
  }
  async function send(event) {
    event.preventDefault();
    if (!draft.trim() || sending.current || busyRun(run)) return;
    sending.current = true; setPending(true); setError("");
    const text = draft.trim();
    try {
      let target = id;
      if (!target) {
        createId.current ||= crypto.randomUUID();
        const result = await request("/api/workspace-tabs", { method: "POST", body: JSON.stringify({ id: createId.current }) });
        target = result.tab.id; setId(target);
      }
      const key = JSON.stringify(["message", text]);
      if (requestId.current?.key !== key) requestId.current = { key, id: crypto.randomUUID() };
      const rid = requestId.current.id;
      setOptimistic({ text, requestId: rid });
      const result = await request(`/api/workspace-tabs/${target}`, { method: "POST", body: JSON.stringify({ action: "message", requestId: rid, text }) });
      requestId.current = null; setDraft("");
      if (mounted.current) setDetails(previous => ({ ...previous, run: result.run }));
      await refresh(target);
    } catch (failure) { if (mounted.current) { setError(failure.message); setOptimistic(null); } }
    finally { sending.current = false; if (mounted.current) { setPending(false); input.current?.focus(); } }
  }
  async function archive(archived) {
    if (sending.current) return;
    sending.current = true; setPending(true); setError("");
    try { await request(`/api/workspace-tabs/${id}`, { method: "PATCH", body: JSON.stringify({ archived }) }); await refresh(); setArchiveConfirm(false); }
    catch (failure) { setError(failure.message); }
    finally { sending.current = false; setPending(false); }
  }
  function openSaved(nextId) { setId(nextId); setDetails(null); setError(""); setOptimistic(null); requestId.current = null; setDraft(""); setShowPreview(false); setArchiveConfirm(false); }
  const displayedMessages = details?.messages || [];
  const liveReply = busyRun(run) && tab?.phase !== "building" ? run.response : "";
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby="tab-planner-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className={styles.header}><div><span className={styles.eyebrow}>Your workspace</span><h2 id="tab-planner-title">{tab?.title && tab.title !== "New tab" ? tab.title : "Make a tab with Hermes"}</h2></div><button type="button" className="iconButton" aria-label="Close tab planner" onClick={onClose}><X size={19} /></button></header>
    {id && !details ? <p className={styles.intro} role="status">Opening your plan…</p> : <>
      {tab?.archivedAt ? <div className={styles.notice}><p>This tab is archived. Its plan and files are still saved.</p><button className="workButton" disabled={pending} onClick={() => archive(false)}><RotateCcw size={14} />Restore tab</button></div> : <>
        <div className={styles.switcher}><span className={styles.step} data-current={!showPreview}>1. Discuss</span><span className={styles.step} data-current={showPreview}>2. Preview</span><span className={styles.step}>3. Add to workspace</span>{tab?.previewVersion && <button onClick={() => setShowPreview(!showPreview)}>{showPreview ? "Back to plan" : "Open preview"}</button>}</div>
        {showPreview && tab?.previewVersion ? <div className={styles.preview}><WorkspaceTabView key={tab.previewVersion} id={id} preview embedded /><div className={styles.publish}><p>Try the controls before adding this tab. You can return to Hermes for changes.</p><button className="workButton" disabled={busy} onClick={() => action("publish", { version: tab.previewVersion })}>Add to workspace<ArrowUpRight size={15} /></button></div></div> : <>
          <div className={styles.transcript} ref={transcript} aria-label="Tab planning conversation" tabIndex={0}>
            {!displayedMessages.length && !optimistic && <div className={styles.intro}><h3>What would make this workspace useful to you?</h3><p>Describe a tool or a view you wish you had. Hermes will work through the details and connections with you before building a preview.</p><small>You review the plan first. Don’t paste API keys or passwords here.</small></div>}
            {displayedMessages.map(item => <article className={styles.message} data-role={item.role} key={item.id}><span>{item.role === "user" ? "You" : "Hermes"}</span><p>{item.text}</p></article>)}
            {optimistic && !displayedMessages.some(item => item.runId === optimistic.requestId && item.role === "user") && <article className={styles.message} data-role="user"><span>You</span><p>{optimistic.text}</p></article>}
            {liveReply && <article className={styles.message}><span>Hermes</span><p>{liveReply.replace(/```panel-plan[\s\S]*/, "")}</p></article>}
            {(busy || ["error", "cancelled", "interrupted"].includes(run?.state)) && <p className={styles.runStatus} role="status">{tab?.phase === "building" ? "Hermes is building your preview… You can close this and return later." : pending ? "Sending to Hermes…" : busyRun(run) ? "Hermes is considering your plan…" : run?.error || (run?.state === "cancelled" ? "Stopped. Continue the conversation whenever you’re ready." : "Hermes couldn’t finish. Your conversation is saved; try again.")}</p>}
            {tab?.error && <p role="alert" className="workError">{tab.error}</p>}
            {plan && !busy && <section className={styles.plan} aria-label="Plan to review"><h3>{plan.title}</h3><p>{plan.outcome}</p>{[["What it will do", plan.features], ["Connections needed", plan.connections], ["Boundaries", plan.boundaries], ["How to check it", plan.checks]].filter(([,items]) => items.length).map(([label,items]) => <div key={label}><h4>{label}</h4><ul>{items.map((text,index) => <li key={index}>{text}</li>)}</ul></div>)}<p className={styles.planNote}>The preview can save local data. Connected work goes through a Hermes task you review before it runs.</p><button className="workButton" onClick={() => action("build", { planDigest: tab.planDigest })}>Build this preview<ArrowUpRight size={15} /></button></section>}
            {!plan && !busy && displayedMessages.filter(item => item.role === "user").length >= 2 && <div className={styles.prepare}><p>Ready to review what this tab should do?</p><button className="workButton" onClick={() => action("plan")}>Prepare plan</button></div>}
          </div>
          <form className={styles.composer} onSubmit={send}><label htmlFor="tab-idea" className={styles.hiddenLabel}>Message Hermes about your tab</label><textarea ref={input} id="tab-idea" value={draft} onChange={event => { setDraft(event.target.value); requestId.current = null; }} maxLength={16000} placeholder={displayedMessages.length ? "Work through the details…" : "I’d like a tab that…"} rows={2} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!busy) event.currentTarget.form.requestSubmit(); } }} /><div><small>Planning only · no tools run</small>{busy ? <button type="button" className="iconButton" disabled={pending || !id} aria-label="Stop planning" onClick={() => action("stop")}><Square size={16} /></button> : <button className="iconButton" disabled={!draft.trim()} aria-label="Send tab idea"><ArrowUp size={19} /></button>}</div></form>
        </>}
      </>}
    </>}
    {error && <div className={styles.error} role="alert">{error}<button onClick={() => { if (id) refresh().then(() => setError("")).catch(failure => setError(failure.message)); }}>Retry loading</button></div>}
    {tab && <footer className={styles.footer}><details><summary>Files on this Mac</summary><code>{tab.storagePath}</code></details>{!tab.archivedAt && (archiveConfirm ? <span>Keep files and archive?<button disabled={busy} onClick={() => archive(true)}>Archive</button><button onClick={() => setArchiveConfirm(false)}>Cancel</button></span> : <button disabled={busy} onClick={() => setArchiveConfirm(true)}><Archive size={13} />Archive tab</button>)}</footer>}
    {!id && savedTabs.length > 0 && <details className={styles.saved}><summary>Continue a saved tab ({savedTabs.length})</summary>{savedTabs.map(saved => <button key={saved.id} onClick={() => openSaved(saved.id)}>{saved.title}<span>{saved.archivedAt ? "Archived" : saved.published ? "Added" : "Draft"}</span></button>)}</details>}
  </dialog>;
}
