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

const compactProgress = value => {
  const text = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
  if (text.length <= 96) return text;
  const head = text.slice(0, 93);
  const space = head.lastIndexOf(" ");
  return `${head.slice(0, space > 55 ? space : head.length)}…`;
};
const genericProgress = /^(?:working(?: on your request)?|thinking(?: through (?:your request|the result))?|preparing (?:the requested action|the selected tool)|running the selected action|composing a reply|starting|queued|connecting)[.…!\s]*$/i;
const actionProgress = /^(?:reading|editing|searching|running a command|fetching information)[.…\s]*$/i;

export function workAgentPresence(agent) {
  const run = agent?.activeRun || agent?.lastRun;
  if (agent?.activeRun) {
    if (run.permissionPending) return { label: "Needs your attention", state: "error", active: true };
    if (run.executionCancelRequestedAt) return { label: "Stopping", state: "working", active: true };
    const tool = compactProgress(run.toolLabel);
    const status = compactProgress(run.statusLabel);
    const task = compactProgress(run.taskLabel);
    const label = tool || (task && actionProgress.test(status) ? compactProgress(`${status.replace(/[.…\s]+$/, "")} · ${task}`) : "")
      || (status && !genericProgress.test(status) ? status : "")
      || (task ? compactProgress(`${run.state === "queued" ? "Queued" : "Working on"}: ${task}`) : status || "Working");
    return { label, state: "working", active: true };
  }
  if (!run) return { label: "No active task", state: "idle", active: false };
  if (["error", "failed", "interrupted"].includes(run.state)) return { label: run.state === "interrupted" ? "Last task interrupted" : "Last task needs attention", state: "error", active: false };
  if (["complete", "completed"].includes(run.state)) return { label: "Last task complete", state: "idle", active: false };
  if (["cancelled", "canceled"].includes(run.state)) return { label: "Last task stopped", state: "idle", active: false };
  return { label: "No active task", state: "idle", active: false };
}
