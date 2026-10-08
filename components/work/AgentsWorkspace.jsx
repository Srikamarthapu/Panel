"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, Check, ChevronDown, Clock3, Coins, MessageCircle, Plus, RotateCcw, Settings2, Square, UsersRound, Zap } from "lucide-react";
import MissionOrb from "@/components/MissionOrb.jsx";
import { workAgentPresence } from "@/lib/work-agent-selection.js";
import AgentProfileDialog from "./AgentProfileDialog.jsx";
import { useWorkSessions } from "./WorkSessionProvider.jsx";
import styles from "./AgentsWorkspace.module.css";

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function agentStats(agent) {
  const stats = agent?.stats || {};
  const runs = stats.runs || {};
  const runtime = stats.runtime || {};
  const usage = stats.usage || {};
  const cost = stats.cost || {};
  return {
    runs: {
      total: finite(runs.total ?? stats.totalRuns),
      completed: finite(runs.completed ?? stats.completedRuns),
    },
    runtime: {
      value: finite(runtime.totalMs ?? stats.totalRuntimeMs),
      availability: runtime.availability,
      reportedRuns: finite(runtime.reportedRuns),
    },
    usage: {
      value: finite(usage.totalTokens ?? stats.totalTokens),
      availability: usage.availability,
      reportedRuns: finite(usage.reportedRuns),
    },
    cost: {
      value: finite(cost.amount ?? cost.amountUsd ?? stats.totalCostUsd),
      currency: cost.currency || (cost.amountUsd != null || stats.totalCostUsd != null ? "USD" : null),
      availability: cost.availability,
      reportedRuns: finite(cost.reportedRuns),
    },
  };
}

function availability(metric) {
  if (metric.value == null || metric.availability === "unavailable") return "Not reported";
  if (metric.availability === "partial") return "Partial";
  return "Reported";
}

function formatRuntime(value) {
  if (value == null) return "—";
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function formatTokens(value) {
  if (value == null) return "—";
  return new Intl.NumberFormat("en", { notation: value >= 10000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

function formatCost(value, currency) {
  if (value == null || !currency) return "—";
  const digits = value === 0 ? 2 : value < 0.01 ? 4 : 2;
  try { return new Intl.NumberFormat("en", { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value); }
  catch { return "—"; }
}

function Metric({ icon: Icon, label, value, metric }) {
  const state = availability(metric);
  const reported = metric.reportedRuns;
  const detail = state === "Partial" && reported != null ? `${reported} runs reported` : state;
  return <div className={styles.metric} title={state === "Not reported" ? `${label} is unavailable because the runtime or provider did not report it.` : undefined}>
    <span><Icon size={14} aria-hidden="true" />{label}</span>
    <strong>{value}</strong>
    <small>{detail}</small>
  </div>;
}

function AgentTask({ agent, onRun, disabled }) {
  const [task, setTask] = useState("");
  const attempt = useRef(null);
  return <form className={styles.task} onSubmit={async event => {
    event.preventDefault();
    if (!task.trim() || disabled) return;
    attempt.current ||= crypto.randomUUID();
    if (await onRun(task.trim(), attempt.current)) { setTask(""); attempt.current = null; }
  }}>
    <label htmlFor={`agent-page-task-${agent.id}`}>Give {agent.name} a task</label>
    <div><textarea id={`agent-page-task-${agent.id}`} aria-label={`Task for ${agent.name}`} rows={2} maxLength={32000} value={task} onChange={event => { setTask(event.target.value); attempt.current = null; }} placeholder="Describe the result you need…" disabled={disabled} /><button type="submit" className="workButton" disabled={disabled || !task.trim()}>Run task</button></div>
  </form>;
}

function AgentCard({ agent, expanded, archived, current, selected, session, pending, onToggle, onAct, onEdit, onOpen, onPresence }) {
  const running = Boolean(agent.activeRun);
  const run = agent.activeRun || agent.lastRun;
  const presence = workAgentPresence(agent);
  const stats = agentStats(agent);
  const detailsId = `agent-details-${agent.id}`;
  const model = agent.model ? `${agent.provider || "Provider"} · ${agent.model}` : "Workspace default";
  const folder = agent.workingDirectory?.split("/").filter(Boolean).at(-1) || "Managed workspace";
  return <article className={styles.card} aria-labelledby={`agent-name-${agent.id}`} data-expanded={expanded || undefined} data-running={running || undefined}>
    <button type="button" className={styles.summary} aria-expanded={expanded} aria-controls={detailsId} aria-label={`${expanded ? "Hide" : "Show"} details for ${agent.name}`} onClick={onToggle}>
      <span className={styles.avatar}><MissionOrb size="inline" avatar="bloub" agentName={agent.name} voiceState="idle" activity={{ state: presence.state, label: presence.label, isStale: false }} color={agent.color || "sage"} pointerFollowing={false} preserveBloubBody /></span>
      <span className={styles.identity}><span className={styles.nameRow}><h2 id={`agent-name-${agent.id}`}>{agent.name}</h2>{current && <span>Current conversation</span>}</span><span className={styles.presence} data-state={presence.state}><i aria-hidden="true" />{presence.label}</span></span>
      <ChevronDown size={18} aria-hidden="true" />
    </button>
    <p className={styles.description}>{agent.description}</p>
    <div className={styles.metrics} aria-label={`${agent.name} reported totals`}>
      <Metric icon={Clock3} label="Runtime" value={formatRuntime(stats.runtime.value)} metric={stats.runtime} />
      <Metric icon={Zap} label="Usage" value={formatTokens(stats.usage.value)} metric={stats.usage} />
      <Metric icon={Coins} label="Est. cost" value={formatCost(stats.cost.value, stats.cost.currency)} metric={stats.cost} />
    </div>
    {expanded && <section className={styles.details} id={detailsId} aria-label={`${agent.name} details`}>
      <dl className={styles.facts}>
        <div><dt>Model</dt><dd>{model}</dd></div>
        <div><dt>Workspace</dt><dd title={agent.workingDirectory}>{folder}</dd></div>
        <div><dt>Runs</dt><dd>{stats.runs.total == null ? "Not reported" : `${stats.runs.total} total${stats.runs.completed == null ? "" : ` · ${stats.runs.completed} complete`}`}</dd></div>
      </dl>
      <p className={styles.telemetryNote}>Runtime and tokens appear only when reported. Cost estimates cover Hermes turn usage, exclude auxiliary calls and retries, and may differ from your provider bill.</p>
      {agent.lastResult && !running && <details className={styles.result}><summary>Latest result</summary><p>{agent.lastResult}</p></details>}
      {!archived && !running && <AgentTask agent={agent} disabled={Boolean(pending)} onRun={(text, actionId) => onAct("run", () => onOpen.run(text, actionId))} />}
    </section>}
    <footer className={styles.actions}>
      {!archived && <button type="button" className={styles.secondary} aria-pressed={selected} onClick={onPresence}>{selected ? <Check size={14} aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}{selected ? "In Talk" : "Add to Talk"}</button>}
      <button type="button" className={styles.secondary} aria-label={`Edit ${agent.name}`} disabled={running || Boolean(pending)} onClick={onEdit}><Settings2 size={14} aria-hidden="true" />Edit profile</button>
      {!archived && <button type="button" className={styles.primary} disabled={Boolean(pending)} onClick={() => onAct("conversation", onOpen.conversation)}><MessageCircle size={15} aria-hidden="true" />{session?.archivedAt ? "Start new conversation" : "Open conversation"}</button>}
      {running ? <button type="button" className={styles.secondary} disabled={Boolean(pending) || Boolean(run.executionCancelRequestedAt)} onClick={() => onAct("stop", () => onOpen.stop(run))}><Square size={12} aria-hidden="true" />Stop</button> : archived ? <button type="button" className={styles.primary} disabled={Boolean(pending)} onClick={() => onAct("restore", onOpen.restore)}><RotateCcw size={14} aria-hidden="true" />Restore agent</button> : <button type="button" className={styles.danger} disabled={Boolean(pending) || (current && onOpen.busy)} onClick={() => onAct("archive", onOpen.archive)}><Archive size={14} aria-hidden="true" />Archive</button>}
    </footer>
  </article>;
}

export default function AgentsWorkspace() {
  const work = useWorkSessions();
  const router = useRouter();
  const pendingRef = useRef(false);
  const [archived, setArchived] = useState(false);
  // null means a view has not chosen its initial card yet; an empty string is
  // an intentional user collapse and must survive background refreshes.
  const [expandedId, setExpandedId] = useState(null);
  const [editor, setEditor] = useState(null);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const profiles = (work?.agents || []).filter(agent => Boolean(agent.archivedAt) === archived);
  const activeProfiles = (work?.agents || []).filter(agent => !agent.archivedAt);
  const delegations = work?.delegations || [];
  const activeCount = activeProfiles.filter(agent => agent.activeRun).length + delegations.filter(agent => ["queued", "running"].includes(agent.status)).length;
  const completedRuns = activeProfiles.reduce((total, agent) => total + (agentStats(agent).runs.completed || 0), 0);
  const hasRunTotals = activeProfiles.some(agent => agentStats(agent).runs.completed != null);

  useEffect(() => {
    if (expandedId === null) {
      if (profiles[0]) setExpandedId(profiles[0].id);
      return;
    }
    if (expandedId && !profiles.some(agent => agent.id === expandedId)) setExpandedId(profiles[0]?.id || null);
  }, [profiles, expandedId]);

  async function act(key, action) {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPending(key);
    setError("");
    try { await action(); return true; }
    catch (failure) { setError(failure.message); return false; }
    finally { pendingRef.current = false; setPending(""); }
  }

  async function openConversation(agent) {
    await work.openAgentConversation(agent.id);
    router.push("/chat");
  }

  return <main className={styles.page}>
    <header className={styles.hero}>
      <div><span className="workEyebrow">PERSISTENT TEAMMATES</span><h1>Agents</h1><p>Give repeat work a clear owner. Each agent keeps its own instructions, workspace, model, and conversation.</p></div>
      <button type="button" className="workButton" onClick={event => { event.currentTarget.focus(); setEditor("new"); }}><Plus size={17} aria-hidden="true" />New agent</button>
    </header>

    <section className={styles.overview} aria-label="Agent overview">
      <div><UsersRound size={17} aria-hidden="true" /><span>Available agents</span><strong>{activeProfiles.length}</strong></div>
      <div><span className={styles.liveDot} aria-hidden="true" /><span>Working now</span><strong>{activeCount}</strong></div>
      <div><Check size={17} aria-hidden="true" /><span>Completed runs</span><strong>{hasRunTotals ? completedRuns : "—"}</strong><small>{hasRunTotals ? "Reported history" : "Not reported"}</small></div>
    </section>

    <div className={styles.toolbar}>
      <div className={styles.views} role="group" aria-label="Agent profile status">
        <button type="button" aria-label={archived ? "Show active" : "Active"} aria-pressed={!archived} onClick={() => { setExpandedId(null); setArchived(false); }}>Active <span>{activeProfiles.length}</span></button>
        <button type="button" aria-label="Archived" aria-pressed={archived} onClick={() => { setExpandedId(null); setArchived(true); }}>Archived <span>{(work?.agents || []).length - activeProfiles.length}</span></button>
      </div>
      <p>Profile archive and conversation history are managed separately.</p>
    </div>

    {(error || work?.agentsError) && <p className="workError" role="alert">{error || work.agentsError}</p>}
    {!profiles.length ? <section className={styles.empty}>
      <span className={styles.emptyAvatar}><MissionOrb size="inline" avatar="bloub" agentName="New agent" voiceState="idle" color="sage" pointerFollowing={false} preserveBloubBody /></span>
      <h2>{archived ? "No archived agents" : "Create your first specialist"}</h2>
      <p>{archived ? "Archived profiles stay here until you restore them." : "Start with a role you repeat: research, implementation, review, or another focused responsibility."}</p>
    </section> : <section className={styles.grid} aria-label={archived ? "Archived agents" : "Active agents"}>{profiles.map(agent => {
      const session = (work?.sessions || []).find(item => item.id === agent.sessionId);
      const current = agent.sessionId === work?.activeSession?.id;
      return <AgentCard key={agent.id} agent={agent} archived={archived} current={current} selected={work?.selectedAgentIds?.includes(agent.id)} session={session} expanded={expandedId === agent.id} pending={pending} onToggle={() => setExpandedId(previous => previous === agent.id ? "" : agent.id)} onEdit={event => { event.currentTarget.focus(); setEditor(agent); }} onPresence={() => work.toggleAgentPresence(agent.id)} onAct={(action, callback) => act(`${agent.id}:${action}`, callback)} onOpen={{
        busy: work?.busy,
        conversation: () => openConversation(agent),
        run: (text, actionId) => work.runAgent(agent.id, text, actionId),
        stop: run => work.stopSessionRun(agent.sessionId, run.id),
        archive: () => work.saveAgent({ archived: true }, agent.id),
        restore: () => work.saveAgent({ archived: false }, agent.id),
      }} />;
    })}</section>}
    {!archived && Boolean(delegations.length) && <section className={styles.delegated} aria-labelledby="delegated-work-title">
      <div className={styles.sectionHeading}><div><span className="workEyebrow">LIVE WORK</span><h2 id="delegated-work-title">Delegated work</h2></div><p>Short-lived helpers started inside a parent conversation.</p></div>
      <div className={styles.delegatedGrid}>{delegations.map(agent => {
        const active = ["queued", "running"].includes(agent.status);
        return <article key={`${agent.runId}:${agent.id}`} className={styles.delegatedCard} aria-label={agent.name}>
          <div><span className={styles.liveDot} aria-hidden="true" data-active={active || undefined} /><div><h3>{agent.name}</h3><p>{agent.statusLabel}</p></div></div>
          <p className={styles.delegatedTask}>{agent.task}</p>
          {agent.result && <details className={styles.result}><summary>Result</summary><p>{agent.result}</p></details>}
          <footer><button type="button" className={styles.secondary} disabled={Boolean(pending) || work?.busy} onClick={() => act(`${agent.id}:parent`, async () => { await work.selectSession(agent.sessionId); router.push("/chat"); })}><MessageCircle size={14} aria-hidden="true" />Parent conversation</button>{agent.canStop && <button type="button" className={styles.danger} disabled={Boolean(pending)} onClick={() => act(`${agent.id}:stop`, () => work.stopDelegation(agent))}><Square size={12} aria-hidden="true" />Stop</button>}</footer>
        </article>;
      })}</div>
    </section>}
    <p className={styles.footnote}>Up to four conversations can work at once. Accepted work continues when you switch views.</p>
    {editor && <AgentProfileDialog agent={editor === "new" ? null : editor} onClose={() => setEditor(null)} />}
  </main>;
}
