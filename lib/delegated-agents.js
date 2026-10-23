import fs from "node:fs";
import path from "node:path";
import { dataDirectory, processMatchesIdentity, readJson, withFileLock, writeJson } from "./work-store.js";
import { publicReplyText } from "./publicReply.js";

const validId = value => typeof value === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(value);
const states = new Set(["queued", "running", "complete", "error", "cancelled", "interrupted"]);
const terminal = new Set(["complete", "error", "cancelled", "interrupted"]);
const stateOrder = Object.freeze({ queued: 0, running: 1, complete: 2, error: 2, cancelled: 2, interrupted: 2 });
const statusLabels = Object.freeze({ queued: "Queued", running: "Running", complete: "Completed", error: "Failed", cancelled: "Stopped", interrupted: "Interrupted" });
const directory = () => path.join(dataDirectory(), "delegated-agents");
const fileFor = id => path.join(directory(), `${id}.json`);
const clean = (value, max) => typeof value === "string" ? publicReplyText(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, max) : "";
const boundedCount = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000 ? value : null;
const boundedDuration = value => Number.isFinite(value) && value >= 0 && value <= 31_536_000 ? value : null;
function timestamp(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
function instanceId(value) {
  const delegationId = validId(value?.delegationId) ? value.delegationId : "";
  return delegationId ? `${value.id}:${delegationId}` : value.id;
}
function lifecycle(agent) {
  if (agent.stopRequested && !terminal.has(agent.status)) return "stopping";
  return ({ queued: "queued", running: "running", complete: "completed", error: "failed", cancelled: "stopped", interrupted: "failed" })[agent.status];
}

// Events belong to the worker that actually started this parent run. They can
// arrive after its final answer when Hermes delegates background work.
export function recordDelegatedAgent(runId, value, { sessionId, runtimePid } = {}) {
  if (!validId(runId) || !validId(sessionId) || !validId(value?.id) || !states.has(value?.status)) return null;
  const run = readJson(path.join(dataDirectory(), "assistant-runs", `${runId}.json`));
  if (!run || run.sessionId !== sessionId || !runtimePid || run.persistentRuntimePid !== runtimePid || !processMatchesIdentity(runtimePid, run.persistentRuntimeIdentity)) return null;
  fs.mkdirSync(directory(), { recursive: true, mode: 0o700 });
  return withFileLock(fileFor(runId), () => {
    const record = readJson(fileFor(runId), { runId, sessionId, runtimePid, runtimeIdentity: run.persistentRuntimeIdentity, agents: [] });
    // A verified event from the owning runtime safely migrates pre-identity
    // records; merely reading an old PID never establishes ownership.
    record.runtimePid = runtimePid;
    record.runtimeIdentity = run.persistentRuntimeIdentity;
    const identity = instanceId(value);
    let index = record.agents.findIndex(agent => (agent.instanceId || agent.id) === identity);
    const sameWorkerActive = record.agents.map((agent, candidate) => ({ agent, candidate }))
      .filter(({ agent }) => agent.id === value.id && !terminal.has(agent.status));
    if (!validId(value.delegationId)) {
      // Hermes may omit the delegation ID on a later progress or terminal tick.
      // Reconcile only when one live generation exists; timestamps below keep a
      // late event from an earlier generation from closing the current worker.
      if (sameWorkerActive.length === 1) index = sameWorkerActive[0].candidate;
      else if (sameWorkerActive.length > 1) return null;
    } else if (index < 0) {
      const legacy = sameWorkerActive.filter(({ agent }) => !agent.delegationId);
      if (legacy.length === 1) index = legacy[0].candidate;
    }
    const previous = record.agents[index];
    if (previous && terminal.has(previous.status)) return previous;
    const eventAt = timestamp(value.updatedAt);
    const previousEventAt = timestamp(previous?.eventAt);
    if (previousEventAt && eventAt && Date.parse(eventAt) < Date.parse(previousEventAt)) return previous;
    if (previous && stateOrder[value.status] < stateOrder[previous.status]) return previous;
    if (index < 0 && record.agents.length >= 64) return null;
    const now = new Date().toISOString();
    const toolCount = boundedCount(value.toolCount);
    const durationSeconds = boundedDuration(value.durationSeconds);
    const resolvedIdentity = validId(value.delegationId) ? identity : previous?.instanceId || identity;
    const agent = {
      ...previous, id: value.id, instanceId: resolvedIdentity, runId, sessionId,
      name: clean(value.name, 120) || previous?.name || "Hermes agent",
      task: clean(value.task, 1200) || previous?.task || "",
      status: value.status,
      statusLabel: clean(value.statusLabel, 160) || statusLabels[value.status],
      canStop: value.status === "running" && value.canStop === true && !previous?.stopRequested,
      result: clean(value.result, 12000) || previous?.result || "",
      ...(validId(value.parentId) ? { parentId: value.parentId } : {}),
      ...(validId(value.delegationId) ? { delegationId: value.delegationId } : {}),
      ...(clean(value.childSessionId, 200) ? { childSessionId: clean(value.childSessionId, 200) } : {}),
      ...(toolCount !== null ? { toolCount } : {}),
      ...(durationSeconds !== null ? { durationSeconds } : {}),
      ...(timestamp(value.startedAt) ? { startedAt: timestamp(value.startedAt) } : {}),
      eventAt: eventAt || previous?.eventAt || now,
      createdAt: previous?.createdAt || now, updatedAt: now,
    };
    if (previous?.stopRequested && !terminal.has(agent.status)) {
      agent.stopRequested = true;
      agent.canStop = false;
      agent.statusLabel = "Stopping…";
    }
    agent.lifecycle = lifecycle(agent);
    if (index < 0) record.agents.push(agent); else record.agents[index] = agent;
    writeJson(fileFor(runId), record);
    return agent;
  });
}

export function listDelegatedAgents(sessionId) {
  let files;
  try { files = fs.readdirSync(directory()); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const agents = [];
  for (const file of files) {
    if (!file.endsWith(".json") || !validId(file.slice(0, -5))) continue;
    const record = readJson(path.join(directory(), file));
    if (!record || (sessionId && record.sessionId !== sessionId)) continue;
    const alive = processMatchesIdentity(record.runtimePid, record.runtimeIdentity);
    for (const agent of record.agents || []) {
      if (!terminal.has(agent.status) && !alive) agents.push({ ...agent, status: "interrupted", lifecycle: "failed", statusLabel: "Runtime ended before completion was confirmed", canStop: false });
      else agents.push({ ...agent, lifecycle: lifecycle(agent), canStop: alive && agent.canStop });
    }
  }
  return agents.sort((a, b) => Number(!terminal.has(b.status)) - Number(!terminal.has(a.status)) || b.updatedAt.localeCompare(a.updatedAt)).slice(0, 100);
}

export function getDelegatedAgent(sessionId, runId, agentId, delegationId = "") {
  const agents = listDelegatedAgents(sessionId);
  const matches = agents.filter(agent => agent.runId === runId && agent.id === agentId);
  if (validId(delegationId)) return matches.find(agent => agent.delegationId === delegationId) || null;
  const active = matches.filter(agent => !terminal.has(agent.status));
  if (active.length > 1) return null;
  return active[0] || matches[0] || null;
}

export function markDelegationStopping(sessionId, runId, agentId, delegationId = "") {
  if (!validId(runId) || !validId(agentId) || !validId(sessionId)) return;
  return withFileLock(fileFor(runId), () => {
    const record = readJson(fileFor(runId));
    if (record?.sessionId !== sessionId) return;
    const active = [...record.agents].reverse().filter(item => item.id === agentId && !terminal.has(item.status));
    const agent = validId(delegationId) ? active.find(item => item.delegationId === delegationId) : active.length === 1 ? active[0] : null;
    if (!agent || terminal.has(agent.status)) return;
    Object.assign(agent, { stopRequested: true, canStop: false, lifecycle: "stopping", statusLabel: "Stopping…", updatedAt: new Date().toISOString() });
    writeJson(fileFor(runId), record);
  });
}
