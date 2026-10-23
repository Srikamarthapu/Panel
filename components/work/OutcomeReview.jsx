"use client";

import { CircleAlert, Cpu, FileText, ShieldCheck, Wrench } from "lucide-react";
import { normalizeRunOutcome } from "@/lib/run-outcome.js";
import { useState } from "react";

const stateLabels = {
  complete: "Completed",
  error: "Needs attention",
  cancelled: "Stopped",
  interrupted: "Interrupted",
};

function toolBreakdown(tools, executionActive) {
  const counts = new Map();
  for (const tool of tools) counts.set(tool.status, (counts.get(tool.status) || 0) + 1);
  const settled = [["completed", "completed"], ["failed", "failed"]]
    .filter(([status]) => counts.has(status))
    .map(([status, label]) => `${counts.get(status)} ${label}`);
  const unresolved = (counts.get("in_progress") || 0) + (counts.get("pending") || 0);
  if (!executionActive && unresolved) settled.push(`${unresolved} unfinished`);
  else settled.push(...[["in_progress", "in progress"], ["pending", "pending"]]
    .filter(([status]) => counts.has(status))
    .map(([status, label]) => `${counts.get(status)} ${label}`));
  return settled.join(" · ");
}

export default function OutcomeReview({ outcome, compact = false, showSummary = true, onOpenSession }) {
  const [copyStatus, setCopyStatus] = useState("");
  const value = normalizeRunOutcome(outcome);
  if (!value) return null;
  const failed = value.state !== "complete";
  const tools = value.observed.tools;
  const files = value.observed.files;
  const verified = value.verified.items;
  const completedReceipts = verified.filter(item => item.source === "runtime_receipt");
  const postRunChecks = verified.filter(item => item.source === "post_run_check");
  const verifiedPaths = new Set(verified.map(item => `${item.path}:${item.line || ""}`));
  const observedFiles = files.filter(file => !verifiedPaths.has(`${file.path}:${file.line || ""}`));
  const stopping = value.execution.stopping;
  async function copyPath(path) {
    try { await navigator.clipboard.writeText(path); setCopyStatus(path); }
    catch { setCopyStatus("error"); }
  }
  return <details className="outcomeReview" data-state={value.state} data-compact={compact || undefined}>
    <summary>
      {failed ? <CircleAlert size={15} aria-hidden="true" /> : <ShieldCheck size={15} aria-hidden="true" />}
      <span>Review work</span><small>{stopping ? "Stopping" : stateLabels[value.state]}</small>
    </summary>
    <div className="outcomeReview__body">
      {showSummary && value.summary.text && <section>
        <h3>{value.summary.provenance === "agent" ? "Agent summary" : "Run status"}</h3>
        <p className="outcomeReview__summary">{value.summary.text}</p>
        <span className="outcomeReview__provenance">{value.summary.provenance === "agent" ? "Reported by the agent" : "Reported by Panel runtime"}</span>
      </section>}
      <section>
        <h3>Execution evidence</h3>
        {tools.length ? <p className="outcomeReview__fact"><Wrench size={14} aria-hidden="true" /><span><strong>{tools.length} retained tool {tools.length === 1 ? "receipt" : "receipts"}</strong><small>{toolBreakdown(tools, value.execution.active)}</small></span></p> : <p className="outcomeReview__muted">No structured tool receipts were retained for this run.</p>}
        {observedFiles.length > 0 && <div className="outcomeReview__files"><h4>Observed file locations</h4><ul>{observedFiles.map(file => <li key={`${file.path}:${file.line || ""}`}><FileText size={13} aria-hidden="true" /><code>{file.path}{file.line ? `:${file.line}` : ""}</code><span>Runtime reported</span><button type="button" onClick={() => copyPath(file.path)} aria-label={`Copy path ${file.path}`}>{copyStatus === file.path ? "Copied" : "Copy path"}</button></li>)}</ul><p>Observed locations show where a tool reported activity. They do not prove that file contents changed.</p></div>}
        {completedReceipts.length > 0 && <div className="outcomeReview__files"><h4>Completed action receipts</h4><ul>{completedReceipts.map(item => <li key={`${item.kind}:${item.path}:${item.line || ""}`}><Wrench size={13} aria-hidden="true" /><code>{item.path}{item.line ? `:${item.line}` : ""}</code><span>{item.label}</span><button type="button" onClick={() => copyPath(item.path)} aria-label={`Copy path ${item.path}`}>{copyStatus === item.path ? "Copied" : "Copy path"}</button></li>)}</ul></div>}
        {postRunChecks.length > 0 && <div className="outcomeReview__files outcomeReview__files--verified"><h4>Verified post-run checks</h4><ul>{postRunChecks.map(item => <li key={`${item.kind}:${item.path}:${item.line || ""}`}><ShieldCheck size={13} aria-hidden="true" /><code>{item.path}{item.line ? `:${item.line}` : ""}</code><span>{item.label}</span><button type="button" onClick={() => copyPath(item.path)} aria-label={`Copy path ${item.path}`}>{copyStatus === item.path ? "Copied" : "Copy path"}</button></li>)}</ul></div>}
        <span className="srOnly" aria-live="polite">{copyStatus === "error" ? "Could not copy path" : copyStatus ? "Path copied" : ""}</span>
        <p className="outcomeReview__limit" data-available={value.verified.status === "available" || undefined}>{value.verified.note}</p>
      </section>
      {value.runtime && <section><h3>{value.runtime.provenance === "runtime" ? "Runtime reported" : "Requested route"}</h3><p className="outcomeReview__fact"><Cpu size={14} aria-hidden="true" /><span><strong>{[value.runtime.provider, value.runtime.model].filter(Boolean).join(" / ")}</strong><small>{value.runtime.provenance === "runtime" ? "Reported by the connected runtime" : "Requested for this run; runtime confirmation unavailable"}</small></span></p></section>}
      {value.model?.mismatch === true && <section className="outcomeReview__modelWarning" role="alert"><h3>Model route changed at runtime</h3><p>The request targeted <strong>{[value.model.requested?.provider, value.model.requested?.model].filter(Boolean).join(" / ") || "the selected model"}</strong>, but the runtime reported <strong>{[value.model.reported?.provider, value.model.reported?.model].filter(Boolean).join(" / ")}</strong>.</p></section>}
      {failed && <div className="outcomeReview__recovery"><strong>{stopping ? "Waiting for the runtime to confirm the stop." : value.state === "cancelled" ? "Review completed actions before retrying." : "Inspect the session before continuing."}</strong>{onOpenSession && <button type="button" onClick={onOpenSession}>Open session</button>}</div>}
    </div>
  </details>;
}
