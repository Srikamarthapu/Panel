const TERMINAL = new Set(["completed", "failed", "stopped"]);

const clean = value => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";

export const AGENT_STATE_LABELS = Object.freeze({
  idle: "Ready",
  queued: "Queued",
  running: "Running",
  approval: "Approval needed",
  stopping: "Stopping",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
});

export function savedAgentStatus(agent) {
  const run = agent?.activeRun || agent?.lastRun;
  if (!run) return { state: "idle", label: AGENT_STATE_LABELS.idle, detail: "Ready for a task", active: false };
  let state;
  if (agent.activeRun) {
    state = run.executionCancelRequestedAt ? "stopping" : run.permissionPending ? "approval" : run.state === "queued" ? "queued" : "running";
  } else {
    state = ({ complete: "completed", completed: "completed", error: "failed", failed: "failed", interrupted: "failed", cancelled: "stopped", canceled: "stopped" })[run.state] || "idle";
  }
  // tool/status text describes the active phase that produced it. A terminal
  // run can retain that last string (for example, "Waiting for your
  // permission…") even though its state has authoritatively moved on.
  const runtimeDetail = TERMINAL.has(state) ? "" : clean(run.toolLabel) || clean(run.statusLabel);
  const task = agent.activeRun ? clean(run.taskLabel) : "";
  return {
    state,
    label: AGENT_STATE_LABELS[state],
    detail: runtimeDetail && runtimeDetail.toLowerCase() !== AGENT_STATE_LABELS[state].toLowerCase() ? runtimeDetail : "",
    task,
    active: !TERMINAL.has(state) && state !== "idle",
  };
}

export function delegatedAgentStatus(agent) {
  const state = agent?.lifecycle || ({ queued: "queued", running: agent?.stopRequested ? "stopping" : "running", complete: "completed", error: "failed", interrupted: "failed", cancelled: "stopped" })[agent?.status] || "failed";
  const runtimeDetail = clean(agent?.statusLabel);
  return {
    state,
    label: AGENT_STATE_LABELS[state] || "Status unavailable",
    detail: runtimeDetail && runtimeDetail.toLowerCase() !== (AGENT_STATE_LABELS[state] || "").toLowerCase() ? runtimeDetail : "",
    active: !TERMINAL.has(state),
  };
}

export function formatDelegatedProgress(agent) {
  const parts = [];
  if (Number.isSafeInteger(agent?.toolCount) && agent.toolCount >= 0) parts.push(`${agent.toolCount} tool ${agent.toolCount === 1 ? "step" : "steps"}`);
  if (Number.isFinite(agent?.durationSeconds) && agent.durationSeconds >= 0) {
    const seconds = Math.round(agent.durationSeconds);
    parts.push(seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`);
  }
  return parts.join(" · ");
}
