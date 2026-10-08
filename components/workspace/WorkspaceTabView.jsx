"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Check, ExternalLink, Pencil, Plus, Square, Trash2, X } from "lucide-react";
import { emptyWorkspaceTabState, normalizeWorkspaceTabState, workspaceActionPrompt } from "@/lib/workspace-tab-view-state.js";
import { useWorkSessions } from "@/components/work/WorkSessionProvider.jsx";
import styles from "./WorkspaceTabView.module.css";

const TERMINAL_STATES = new Set(["complete", "error", "cancelled", "interrupted"]);
const MAX_STATE_BYTES = 100000;
const MAX_ASK_LENGTH = 16000;
const stateJournalKey = id => `panel.workspaceTabState.v1.${id}`;

async function requestJson(url, options = {}) {
  const response = await fetch(url, { ...options, cache: "no-store", signal: options.signal || AbortSignal.timeout(15000), headers: { "Content-Type": "application/json", ...options.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "This custom tab could not complete the request.");
  return data;
}

function serializedSize(value) {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
  catch { return Infinity; }
}

function journalValue(id) {
  try { return JSON.parse(localStorage.getItem(stateJournalKey(id)) || "null")?.value; }
  catch { return null; }
}

function writeJournal(id, value) {
  try { localStorage.setItem(stateJournalKey(id), JSON.stringify({ value })); }
  catch { /* The visible save request still reports persistence failures. */ }
}

async function drainSaveQueue(queueRef, setSaveStatus, setSaveFailed) {
  const queue = queueRef.current;
  if (queue.inFlight) return;
  queue.inFlight = true;
  try {
    while (queue.pending.size) {
      const [key, job] = queue.pending.entries().next().value;
      queue.pending.delete(key);
      try {
        await requestJson(job.url, { method: "PUT", body: JSON.stringify({ value: job.value }), keepalive: serializedSize(job.value) < 60000 });
        try { if (localStorage.getItem(stateJournalKey(job.id)) === job.journal) localStorage.removeItem(stateJournalKey(job.id)); } catch { /* Ignore unavailable local storage. */ }
        if (queue.generation === job.generation && queue.revision === job.revision && !queue.pending.has(job.url)) { queue.failed = null; setSaveFailed(false); setSaveStatus("Saved"); }
      } catch (failure) {
        if (queue.generation === job.generation && queue.revision === job.revision && !queue.pending.has(job.url)) { queue.failed = job; setSaveFailed(true); setSaveStatus(failure.message); }
      }
    }
  } finally {
    queue.inFlight = false;
  }
}

function ReviewDialog({ review, onCancel, onRun, onStop, onOpenChat }) {
  const dialogRef = useRef(null), cancelRef = useRef(null);
  useEffect(() => {
    const dialog = dialogRef.current, trigger = document.activeElement;
    if (dialog && !dialog.open) dialog.showModal();
    cancelRef.current?.focus();
    return () => { dialog?.close(); if (trigger?.isConnected) trigger.focus?.(); };
  }, []);
  const running = ["starting", "running", "permission", "stopping"].includes(review.phase);
  return <dialog ref={dialogRef} className={styles.reviewDialog} aria-labelledby="workspace-ask-title" onCancel={event => { event.preventDefault(); if (!running) onCancel(); }}>
    <header><div><span>Custom tab request</span><h2 id="workspace-ask-title">Review before Hermes runs</h2></div>{!running && <button type="button" className={styles.iconButton} aria-label="Close request review" onClick={onCancel}><X size={17} /></button>}</header>
    <p className={styles.reviewHelp}>This is the exact task assembled from your current tab data. Nothing runs until you approve it.</p>
    <pre className={styles.prompt}>{review.text}</pre>
    {review.phase === "permission" && <div className={styles.permission} role="alert"><AlertCircle size={17} /><div><strong>Hermes needs your permission</strong><p>Open the execution conversation to review the requested tool action.</p></div><button type="button" onClick={onOpenChat}>Open in chat <ExternalLink size={13} /></button></div>}
    {running && review.phase !== "permission" && <p className={styles.runStatus} role="status">{review.phase === "stopping" ? "Stopping the request…" : review.statusLabel || "Hermes is working…"}</p>}
    {review.error && <p className={styles.error} role="alert">{review.error}</p>}
    <footer>
      {review.phase === "review" && <><button ref={cancelRef} type="button" className={styles.quietButton} onClick={onCancel}>Cancel</button><button type="button" className={styles.primaryButton} onClick={onRun}>Run with Hermes</button></>}
      {running && <>{review.error && <button type="button" className={styles.quietButton} onClick={onOpenChat}>Open execution chat <ExternalLink size={13} /></button>}<button ref={cancelRef} type="button" className={styles.stopButton} disabled={review.phase === "stopping"} onClick={onStop}><Square size={12} />{review.phase === "stopping" ? "Stopping…" : "Stop request"}</button></>}
      {review.phase === "error" && <><button type="button" className={styles.quietButton} onClick={onOpenChat}>Open execution chat <ExternalLink size={13} /></button><button ref={cancelRef} type="button" className={styles.quietButton} onClick={onCancel}>Close</button></>}
    </footer>
  </dialog>;
}

function FieldBlock({ block, value, onChange }) {
  const label = block.label || block.title || "Field";
  if (block.kind === "textarea") return <label className={styles.field}><span>{label}</span><textarea rows={4} value={value} maxLength={20000} onChange={event => onChange(event.target.value)} /></label>;
  if (block.kind === "select") return <label className={styles.field}><span>{label}</span><select value={value} onChange={event => onChange(event.target.value)}><option value="">Choose…</option>{(block.options || []).map(option => <option key={option} value={option}>{option}</option>)}</select></label>;
  return <label className={styles.field}><span>{label}</span><input type={block.kind || "text"} value={value} maxLength={block.kind === "number" ? undefined : 4000} onChange={event => onChange(event.target.value)} /></label>;
}

function ChecklistBlock({ block, values, onChange }) {
  return <fieldset className={styles.checklist}><legend>{block.title || block.label || "Checklist"}</legend>{(block.items || []).map((item, index) => <label key={`${block.id}:${index}`}><input type="checkbox" checked={Boolean(values[index])} onChange={event => { const next = [...values]; next[index] = event.target.checked; onChange(next); }} /><span>{item}</span></label>)}</fieldset>;
}

function TableBlock({ block, rows, onChange }) {
  const columns = block.columns || [];
  const add = () => onChange([...rows, Object.fromEntries(columns.map(column => [column, ""]))]);
  return <section className={styles.tableBlock}><header><h2>{block.title || "Table"}</h2><button type="button" onClick={add}><Plus size={13} />Add row</button></header>{rows.length ? <div className={styles.tableScroll}><table><thead><tr>{columns.map(column => <th key={column} scope="col">{column}</th>)}<th scope="col"><span className="srOnly">Row actions</span></th></tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={`${block.id}:${rowIndex}`}>{columns.map(column => <td key={column}><label className="srOnly" htmlFor={`${block.id}-${rowIndex}-${column}`}>{column}, row {rowIndex + 1}</label><input id={`${block.id}-${rowIndex}-${column}`} value={row[column] || ""} maxLength={4000} onChange={event => onChange(rows.map((item, index) => index === rowIndex ? { ...item, [column]: event.target.value } : item))} /></td>)}<td><button type="button" className={styles.deleteRow} aria-label={`Delete row ${rowIndex + 1}`} onClick={() => onChange(rows.filter((_, index) => index !== rowIndex))}><Trash2 size={13} /></button></td></tr>)}</tbody></table></div> : <p className={styles.emptyTable}>No rows yet. Add a row to start.</p>}</section>;
}

export default function WorkspaceTabView({ id, preview = false, embedded = false }) {
  const router = useRouter(), work = useWorkSessions();
  const saveQueue = useRef({ generation: 0, revision: 0, inFlight: false, pending: new Map(), failed: null });
  const stateRef = useRef(emptyWorkspaceTabState()), activeAsk = useRef(null), pollTimer = useRef(null), pollController = useRef(null);
  const [details, setDetails] = useState(null), [spec, setSpec] = useState(null);
  const [state, setState] = useState(emptyWorkspaceTabState), [stateReady, setStateReady] = useState(false);
  const [saveStatus, setSaveStatus] = useState(""), [saveFailed, setSaveFailed] = useState(false), [executionRun, setExecutionRun] = useState(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(""), [review, setReview] = useState(null);

  useEffect(() => () => {
    clearTimeout(pollTimer.current); pollController.current?.abort(); saveQueue.current.generation += 1;
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    saveQueue.current.generation += 1;
    const generation = saveQueue.current.generation;
    setLoading(true); setError(""); setDetails(null); setSpec(null); setStateReady(false); setExecutionRun(null);
    clearTimeout(pollTimer.current); pollController.current?.abort(); activeAsk.current = null; setReview(null);
    Promise.all([
      requestJson(`/api/workspace-tabs/${encodeURIComponent(id)}`, { signal: controller.signal }),
      requestJson(`/api/workspace-tabs/${encodeURIComponent(id)}/artifact?preview=${preview ? "true" : "false"}`, { signal: controller.signal }),
      requestJson(`/api/workspace-tabs/${encodeURIComponent(id)}/state`, { signal: controller.signal }),
    ]).then(([nextDetails, artifact, saved]) => {
      if (saveQueue.current.generation !== generation) return;
      const localValue = journalValue(id);
      const nextState = normalizeWorkspaceTabState(artifact.spec, localValue || saved.value);
      stateRef.current = nextState; setDetails(nextDetails); setSpec(artifact.spec); setState(nextState); setStateReady(true);
      if (localValue) {
        const queue = saveQueue.current, url = `/api/workspace-tabs/${encodeURIComponent(id)}/state`;
        queue.revision += 1;
        const job = { id, generation, revision: queue.revision, value: nextState, url, journal: JSON.stringify({ value: nextState }) };
        queue.pending.set(url, job); setSaveStatus("Restoring unsaved changes…"); setSaveFailed(false);
        void drainSaveQueue(saveQueue, setSaveStatus, setSaveFailed);
      }
    }).catch(failure => { if (!controller.signal.aborted) setError(failure.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [id, preview]);

  const updateState = useCallback(updater => {
    if (!stateReady || !spec) return;
    const next = typeof updater === "function" ? updater(stateRef.current) : updater;
    stateRef.current = next; setState(next);
    const queue = saveQueue.current;
    queue.revision += 1;
    const revision = queue.revision, generation = queue.generation;
    const url = `/api/workspace-tabs/${encodeURIComponent(id)}/state`;
    if (serializedSize(next) > MAX_STATE_BYTES) { queue.pending.delete(url); setSaveStatus("Tab data is too large to save."); return; }
    writeJournal(id, next);
    const journal = JSON.stringify({ value: next });
    setSaveStatus("Saving…"); setSaveFailed(false); queue.failed = null;
    queue.pending.set(url, { id, generation, revision, value: next, url, journal });
    void drainSaveQueue(saveQueue, setSaveStatus, setSaveFailed);
  }, [id, spec, stateReady]);

  const retrySave = useCallback(() => {
    const queue = saveQueue.current, job = queue.failed;
    if (!job) return;
    queue.failed = null; queue.pending.set(job.url, job); setSaveFailed(false); setSaveStatus("Saving…");
    void drainSaveQueue(saveQueue, setSaveStatus, setSaveFailed);
  }, []);

  useEffect(() => {
    const sessionId = details?.tab?.executionSessionId;
    if (!sessionId) return;
    let stopped = false, timer;
    const read = async () => {
      try {
        const data = await requestJson(`/api/voice/runs?sessionId=${encodeURIComponent(sessionId)}`);
        if (!stopped) setExecutionRun(data.run || null);
        if (!stopped && data.run && !TERMINAL_STATES.has(data.run.state)) timer = setTimeout(read, 1500);
      } catch { /* Main tab stays usable; reviewed actions report their own errors. */ }
    };
    void read();
    return () => { stopped = true; clearTimeout(timer); };
  }, [details]);

  const closeReview = useCallback(() => { activeAsk.current = null; setReview(null); }, []);
  const finishRun = useCallback(run => { setExecutionRun(run); activeAsk.current = null; setReview(run.state === "complete" ? null : previous => ({ ...previous, phase: "error", error: run.error || "Hermes did not complete this request." })); }, []);
  const pollRun = useCallback((requestId, sessionId) => {
    clearTimeout(pollTimer.current); pollController.current?.abort();
    const controller = new AbortController(); pollController.current = controller;
    const check = async () => {
      if (controller.signal.aborted || activeAsk.current?.requestId !== requestId) return;
      try {
        const data = await requestJson(`/api/voice/runs?sessionId=${encodeURIComponent(sessionId)}&actionId=${encodeURIComponent(requestId)}`, { signal: controller.signal });
        const run = data.run;
        if (run && TERMINAL_STATES.has(run.state)) { finishRun(run); return; }
        setExecutionRun(run || null);
        setReview(previous => previous ? { ...previous, phase: run?.permission ? "permission" : "running", statusLabel: run?.permission ? "Needs permission" : run?.statusLabel || (run?.state === "queued" ? "Waiting to start…" : "Hermes is working…"), error: previous.error?.startsWith("Could not stop") ? previous.error : "" } : previous);
      } catch (failure) {
        if (controller.signal.aborted) return;
        setReview(previous => previous ? { ...previous, phase: "running", error: `Could not refresh this request: ${failure.message}. Monitoring will retry.` } : previous);
        pollTimer.current = setTimeout(check, 1500); return;
      }
      pollTimer.current = setTimeout(check, 1000);
    };
    void check();
  }, [finishRun]);

  const proposeAction = (block, trigger) => {
    const text = workspaceActionPrompt(spec, state, block.prompt);
    if (!text || text.length > MAX_ASK_LENGTH) { setSaveStatus(text ? "The assembled Hermes request is too long." : "Fill in the tab before running this action."); return; }
    trigger?.focus(); activeAsk.current = { text }; setReview({ phase: "review", text, statusLabel: "", error: "" });
  };
  const runReviewedAsk = useCallback(async () => {
    const request = activeAsk.current, sessionId = details?.tab?.executionSessionId;
    if (!request || request.requestId || !sessionId || review?.phase !== "review") return;
    const requestId = crypto.randomUUID(); activeAsk.current = { ...request, requestId };
    setReview(previous => ({ ...previous, phase: "starting", statusLabel: "Starting Hermes…", error: "" }));
    try { const data = await requestJson(`/api/workspace-tabs/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify({ action: "run", requestId, text: request.text }) }); setExecutionRun(data.run || null); pollRun(requestId, sessionId); }
    catch (failure) { activeAsk.current = null; setReview(previous => ({ ...previous, phase: "error", error: failure.message })); }
  }, [details, id, pollRun, review]);
  const stopRun = useCallback(async () => {
    const request = activeAsk.current, sessionId = details?.tab?.executionSessionId;
    if (!request?.requestId || !sessionId) { closeReview(); return; }
    setReview(previous => ({ ...previous, phase: "stopping", error: "" })); clearTimeout(pollTimer.current); pollController.current?.abort();
    try { const data = await requestJson("/api/voice/runs", { method: "DELETE", body: JSON.stringify({ sessionId, actionId: request.requestId }) }); setExecutionRun(data.run || null); closeReview(); }
    catch (failure) { setReview(previous => ({ ...previous, phase: "running", error: `Could not stop this request: ${failure.message}` })); pollRun(request.requestId, sessionId); }
  }, [closeReview, details, pollRun]);
  const openExecutionChat = useCallback(async () => {
    const sessionId = details?.tab?.executionSessionId;
    if (!sessionId) return;
    try { await work.selectSession(sessionId); router.push("/chat"); }
    catch (failure) { setReview(previous => previous ? { ...previous, phase: "error", error: failure.message } : previous); }
  }, [details, router, work]);

  const edit = event => { event.currentTarget.focus(); window.dispatchEvent(new CustomEvent("panel:edit-workspace-tab", { detail: { id } })); };
  const tab = details?.tab;
  return <section className={`${styles.view}${embedded ? ` ${styles.embedded}` : ""}`} aria-label={tab?.title ? `${tab.title} custom tab` : "Custom tab"}>
    {!embedded && <header className={styles.header}><div><span>Custom workspace</span><h1>{tab?.title || "Custom tab"}</h1>{tab?.storagePath && <code tabIndex={0}>{tab.storagePath}</code>}</div><button type="button" className={styles.editButton} onClick={edit}><Pencil size={14} />Edit tab</button></header>}
    {loading && <div className={styles.state} role="status">Loading custom tab…</div>}
    {!loading && error && <div className={styles.state} role="alert"><AlertCircle size={20} /><strong>Custom tab unavailable</strong><p>{error}</p>{!preview && <Link href="/">Return to Talk</Link>}</div>}
    {spec && <div className={styles.surface}><header className={styles.surfaceHeader}><div><h2>{spec.title}</h2>{spec.description && <p>{spec.description}</p>}</div><div className={styles.saveFeedback}><span role={saveFailed || saveStatus.includes("large") || saveStatus.includes("could") ? "alert" : "status"}>{saveStatus}</span>{saveFailed && <button type="button" onClick={retrySave}>Retry save</button>}</div></header>
      {executionRun && <aside className={styles.execution} data-state={executionRun.state}><div><strong>{TERMINAL_STATES.has(executionRun.state) ? "Latest Hermes task" : "Hermes task in progress"}</strong><p>{executionRun.permission ? "Waiting for your permission" : executionRun.statusLabel || ({ complete: "Complete", error: "Needs attention", cancelled: "Stopped", interrupted: "Interrupted" }[executionRun.state] || "Working")}</p></div><button type="button" onClick={openExecutionChat}>Open execution chat <ExternalLink size={13} /></button>{executionRun.state === "complete" && executionRun.response && <details><summary>Latest result</summary><p>{executionRun.response}</p></details>}</aside>}
      <div className={styles.blocks}>{spec.blocks.map(block => {
        if (block.type === "text") return <section className={styles.textBlock} key={block.id}>{block.title && <h2>{block.title}</h2>}<p>{block.text}</p></section>;
        if (block.type === "field") return <FieldBlock key={block.id} block={block} value={state.fields[block.id] || ""} onChange={value => updateState(previous => ({ ...previous, fields: { ...previous.fields, [block.id]: value } }))} />;
        if (block.type === "notes") return <label className={styles.field} key={block.id}><span>{block.label || block.title || "Notes"}</span><textarea rows={6} value={state.notes[block.id] || ""} maxLength={20000} onChange={event => updateState(previous => ({ ...previous, notes: { ...previous.notes, [block.id]: event.target.value } }))} /></label>;
        if (block.type === "checklist") return <ChecklistBlock key={block.id} block={block} values={state.checklists[block.id] || []} onChange={value => updateState(previous => ({ ...previous, checklists: { ...previous.checklists, [block.id]: value } }))} />;
        if (block.type === "table") return <TableBlock key={block.id} block={block} rows={state.tables[block.id] || []} onChange={value => updateState(previous => ({ ...previous, tables: { ...previous.tables, [block.id]: value.slice(0, 100) } }))} />;
        if (block.type === "action") return <section className={styles.actionBlock} key={block.id}>{block.title && <h2>{block.title}</h2>}<button type="button" onClick={event => proposeAction(block, event.currentTarget)}><Check size={14} />{block.label}</button></section>;
        return null;
      })}</div>
    </div>}
    {review && <ReviewDialog review={review} onCancel={closeReview} onRun={runReviewedAsk} onStop={stopRun} onOpenChat={openExecutionChat} />}
  </section>;
}
