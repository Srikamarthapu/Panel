"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Check, CircleAlert, Plus, Square, X, Settings2 } from "lucide-react";
import { useWorkSessions } from "./WorkSessionProvider.jsx";
import AgentProfileDialog from "./AgentProfileDialog.jsx";
import MissionOrb from "@/components/MissionOrb.jsx";
import { workAgentPresence } from "@/lib/work-agent-selection.js";
import { delegatedAgentStatus, formatDelegatedProgress, savedAgentStatus } from "./agentStatus.js";
import OutcomeReview from "./OutcomeReview.jsx";
import { outcomeFromLegacyResult } from "@/lib/run-outcome.js";
import styles from "./AgentsPane.module.css";

export function sessionRunLabel(session) {
  const status = savedAgentStatus(session);
  return status.detail ? `${status.label} · ${status.detail}` : status.label;
}
function AgentTask({ agent, onRun, disabled }) {
  const [task, setTask] = useState("");
  const attempt = useRef(null);
  return <form className="agentTask" onSubmit={async event => {
    event.preventDefault(); if (!task.trim() || disabled) return;
    attempt.current ||= crypto.randomUUID();
    if (await onRun(task.trim(), attempt.current)) { setTask(""); attempt.current = null; }
  }}><label className="srOnly" htmlFor={`task-${agent.id}`}>Task for {agent.name}</label><textarea id={`task-${agent.id}`} rows={2} maxLength={32000} value={task} onChange={event => { setTask(event.target.value); attempt.current = null; }} placeholder={`Give ${agent.name} a task…`} disabled={disabled} /><button className="workButton" disabled={disabled || !task.trim()}>Run task</button></form>;
}
export default function AgentsPane({ onClose, standalone = false }) {
  const work = useWorkSessions(), router = useRouter();
  const container = useRef(null), pendingRef = useRef(false);
  const [compact, setCompact] = useState(false), [editor, setEditor] = useState(null), [archived, setArchived] = useState(false);
  useEffect(() => {
    if (standalone) return;
    const media = window.matchMedia("(max-width:1100px)");
    const update = () => setCompact(media.matches);
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [standalone]);
  useEffect(() => {
    if (!compact) return;
    const trigger = document.activeElement, modal = container.current;
    if (modal && !modal.open) modal.showModal();
    return () => { modal?.close(); if (trigger?.isConnected) trigger.focus?.(); };
  }, [compact]);
  const Container = compact ? "dialog" : "aside";
  const [error, setError] = useState(""), [pending, setPending] = useState("");
  const profiles = (work?.agents || []).filter(agent => Boolean(agent.archivedAt) === archived);
  const sessions = (work?.sessions || []).filter(s => !s.agentId && !s.archivedAt && (s.activeRun || s.lastRun || s.id === work.activeSession?.id));
  const children = work?.delegations || [];
  const activeCount = (work?.activeRuns?.length || 0) + children.filter(item => delegatedAgentStatus(item).active).length;
  async function act(id, action) {
    if (pendingRef.current) return false;
    pendingRef.current = true; setPending(id); setError("");
    try { await action(); return true; } catch (failure) { setError(failure.message); return false; }
    finally { pendingRef.current = false; setPending(""); }
  }
  async function openSession(id) { await work.selectSession(id); router.push("/chat"); }
  async function openAgent(agent) { await work.openAgentConversation(agent.id); router.push("/chat"); }
  function presence(running, failed, hasRun) { return running ? <MissionOrb size="inline" avatar="bloub" voiceState="thinking" pointerFollowing={false} preserveBloubBody /> : failed ? <CircleAlert size={16} /> : hasRun ? <Check size={16} /> : <span className="agentsPaneCard__dot" />; }
  return <><Container ref={container} onCancel={event => { event.preventDefault(); onClose?.(); }} className={`agentsPane${standalone ? " agentsPane--standalone" : ""}`} id="agents-pane" aria-label="Agent sessions">
    <header><div>{standalone ? <h1>Agents</h1> : <h2>Agents</h2>}<p>{activeCount ? `${activeCount} working` : "Saved teammates, ready when you need them"}</p></div>{onClose && <button type="button" className="iconButton" aria-label="Close agents" onClick={onClose}><X size={17} aria-hidden="true" /></button>}</header>
    <div className="agentsPane__actions"><button type="button" className="agentsPane__new" onClick={event => { event.currentTarget.focus(); setEditor("new"); }}><Plus size={16} aria-hidden="true" />New teammate</button><button type="button" className="workTextButton" aria-pressed={archived} onClick={() => setArchived(!archived)}>{archived ? "Show active" : "Archived"}</button></div>
    {(error || work?.agentsError) && <p className="workError" role="alert">{error || work.agentsError}</p>}
    {!profiles.length && <div className="agentsEmpty"><p>{archived ? "No archived teammates." : "Build a small team for the work you repeat."}</p>{!archived && <span>Each saved teammate keeps its role, model choice, folder, and conversation. Send it a task yourself, or let Hermes delegate when its specialty fits.</span>}</div>}
    <div className="agentsPane__profiles">{profiles.map(agent => {
      const running = Boolean(agent.activeRun), run = agent.activeRun || agent.lastRun, current = agent.sessionId === work?.activeSession?.id;
      const selected = work?.selectedAgentIds?.includes(agent.id);
      const profilePresence = workAgentPresence(agent);
      const outcome = !running && run ? run.outcome || outcomeFromLegacyResult({ state: run.state, response: agent.lastResult, error: ["error", "interrupted"].includes(run.state) ? run.statusLabel : "", updatedAt: run.updatedAt }) : null;
      return <article className="agentsPaneCard agentProfileCard" key={agent.id} aria-label={agent.name} data-current={current || undefined} data-running={running || undefined} data-selected={selected || undefined}>
        <div className="agentsPaneCard__top"><MissionOrb size="inline" avatar="bloub" agentName={agent.name} voiceState="idle" activity={{ state: profilePresence.state, label: profilePresence.label, isStale: false }} color={agent.color || "sage"} pointerFollowing={false} preserveBloubBody /><strong>{agent.name}</strong>{current && <span className="agentsPaneCard__current">Current</span>}{!archived && <button type="button" className={styles.presenceButton} aria-label={`${selected ? "Remove" : "Add"} ${agent.name} ${selected ? "from" : "to"} Talk`} aria-pressed={Boolean(selected)} onClick={() => work.toggleAgentPresence(agent.id)}>{selected ? <Check size={12} /> : <Plus size={12} />}<span>{selected ? "Added" : "Add"}</span></button>}<button type="button" className="iconButton" aria-label={`Edit ${agent.name}`} disabled={running || Boolean(pending)} onClick={event => { event.currentTarget.focus(); setEditor(agent); }}><Settings2 size={14} /></button></div>
        <p>{agent.description}</p><small>{agent.model || "Workspace model"}</small><small title={agent.workingDirectory}>{agent.workingDirectory?.split("/").filter(Boolean).at(-1)}</small>
        <p className="agentRunStatus" role={running ? "status" : undefined}>{sessionRunLabel(agent)}</p>
        {outcome && <OutcomeReview outcome={outcome} compact onOpenSession={() => act(`${agent.id}:review`, () => openAgent(agent))} />}
        {!archived && !running && <AgentTask agent={agent} disabled={Boolean(pending)} onRun={(text, actionId) => act(agent.id, () => work.runAgent(agent.id, text, actionId))} />}
        <footer>{archived ? <button type="button" className="workTextButton" disabled={Boolean(pending)} onClick={() => act(agent.id, () => work.saveAgent({ archived: false }, agent.id))}>Restore</button> : <button type="button" className="workTextButton" disabled={work?.busy || Boolean(pending)} onClick={() => act(agent.id, () => openAgent(agent))}>Conversation<ArrowUpRight size={13} /></button>}{running ? <button type="button" className="workTextButton" disabled={Boolean(pending) || Boolean(run.executionCancelRequestedAt)} onClick={() => act(agent.id, () => work.stopSessionRun(agent.sessionId, run.id))}><Square size={11} />Stop</button> : !archived && <button type="button" className="workTextButton" disabled={Boolean(pending) || (current && work?.busy)} onClick={() => act(agent.id, () => work.saveAgent({ archived: true }, agent.id))}>Archive</button>}</footer>
      </article>;
    })}</div>
    {Boolean(children.length) && <section className="agentsPane__section"><h3>Temporary workers</h3><p className={styles.sectionNote}>Created for one delegated subtask. They are not saved teammates.</p><div className="agentsPane__list">{children.map(agent => {
      const status = delegatedAgentStatus(agent), progress = formatDelegatedProgress(agent);
      const outcome = !status.active ? outcomeFromLegacyResult({ state: agent.status, response: agent.status === "complete" ? agent.result : "", error: agent.status === "complete" ? "" : agent.result || agent.statusLabel, updatedAt: agent.updatedAt }) : null;
      return <article className="agentsPaneCard" key={`${agent.runId}:${agent.instanceId || agent.id}`} aria-label={`Temporary worker: ${agent.task || "subtask"}`} data-running={status.active || undefined}>
        <div className="agentsPaneCard__top">{presence(status.active, status.state === "failed", true)}<strong>Temporary worker</strong></div><p>{agent.task}</p><p className={styles.workerStatus} role={status.active ? "status" : undefined}><strong>{status.label}</strong>{status.detail && <span> · {status.detail}</span>}</p>{progress && <p className={styles.progress}>{progress}</p>}{outcome && <OutcomeReview outcome={outcome} compact onOpenSession={() => act(`${agent.instanceId || agent.id}:review`, () => openSession(agent.sessionId))} />}<footer><button type="button" className="workTextButton" disabled={Boolean(pending) || work?.busy} onClick={() => act(agent.instanceId || agent.id, () => openSession(agent.sessionId))}>Parent conversation<ArrowUpRight size={13} aria-hidden="true" /></button>{(agent.canStop || status.state === "stopping") && <button type="button" className="workTextButton" disabled={Boolean(pending) || status.state === "stopping"} onClick={() => act(agent.instanceId || agent.id, () => work.stopDelegation(agent))}><Square size={11} aria-hidden="true" />{status.state === "stopping" ? "Stopping…" : "Stop"}</button>}</footer>
      </article>;
    })}</div></section>}
    {!archived && Boolean(sessions.length) && <section className="agentsPane__section"><h3>Conversations</h3><div className="agentsPane__list">{sessions.map(session => {
      const run = session.activeRun || session.lastRun, running = Boolean(session.activeRun), current = session.id === work.activeSession?.id;
      return <article className="agentsPaneCard" key={session.id} data-current={current || undefined} data-running={running || undefined}><div className="agentsPaneCard__top">{presence(running, ["error", "interrupted"].includes(run?.state), Boolean(run))}<strong>{session.name}</strong>{current && <span className="agentsPaneCard__current">Current</span>}</div><p>{sessionRunLabel(session)}</p><footer><button type="button" className="workTextButton" disabled={current || work?.busy || Boolean(pending)} onClick={() => act(session.id, () => openSession(session.id))}>Open<ArrowUpRight size={13} /></button>{running && <button type="button" className="workTextButton" disabled={Boolean(pending) || Boolean(run.executionCancelRequestedAt)} onClick={() => act(session.id, () => work.stopSessionRun(session.id, run.id))}><Square size={11} />Stop</button>}</footer></article>;
    })}</div></section>}
    <p className="agentsPane__note">Recurring and future work stays separate in <a href="/tasks">Tasks</a>. Accepted work continues when you switch views.</p>
  </Container>{editor && <AgentProfileDialog agent={editor === "new" ? null : editor} onClose={() => setEditor(null)} />}</>;
}
