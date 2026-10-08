export const WORK_AGENT_SELECTION_KEY = "panel.selectedAgents.v1";

const validId = value => typeof value === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(value);

export function parseSelectedAgentIds(serialized) {
  if (typeof serialized !== "string" || serialized.length > 16000) return [];
  try {
    const parsed = JSON.parse(serialized);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter(validId))];
  } catch {
    return [];
  }
}

export function normalizeSelectedAgentIds(ids, agents) {
  const available = new Set((Array.isArray(agents) ? agents : [])
    .filter(agent => agent && validId(agent.id) && !agent.archivedAt)
    .map(agent => agent.id));
  return [...new Set(Array.isArray(ids) ? ids : [])].filter(id => available.has(id));
}

export function workAgentPresence(agent) {
  const run = agent?.activeRun || agent?.lastRun;
  if (agent?.activeRun) {
    if (run.permissionPending) return { label: "Needs your attention", state: "error", active: true };
    if (run.executionCancelRequestedAt) return { label: "Stopping", state: "working", active: true };
    return { label: run.statusLabel || "Working", state: "working", active: true };
  }
  if (!run) return { label: "No active task", state: "idle", active: false };
  if (["error", "failed", "interrupted"].includes(run.state)) return { label: run.state === "interrupted" ? "Last task interrupted" : "Last task needs attention", state: "error", active: false };
  if (["complete", "completed"].includes(run.state)) return { label: "Last task complete", state: "idle", active: false };
  if (["cancelled", "canceled"].includes(run.state)) return { label: "Last task stopped", state: "idle", active: false };
  return { label: "No active task", state: "idle", active: false };
}
