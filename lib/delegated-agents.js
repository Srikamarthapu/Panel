import fs from "node:fs";
import path from "node:path";
import { dataDirectory, processAlive, readJson, withFileLock, writeJson } from "./work-store.js";
import { publicReplyText } from "./publicReply.js";

const validId = value => typeof value === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(value);
const states = new Set(["queued", "running", "complete", "error", "cancelled", "interrupted"]);
const terminal = new Set(["complete", "error", "cancelled", "interrupted"]);
const directory = () => path.join(dataDirectory(), "delegated-agents");
const fileFor = id => path.join(directory(), `${id}.json`);
const clean = (value, max) => typeof value === "string" ? publicReplyText(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, max) : "";

// Events belong to the worker that actually started this parent run. They can
// arrive after its final answer when Hermes delegates background work.
export function recordDelegatedAgent(runId, value, { sessionId, runtimePid } = {}) {
  if (!validId(runId) || !validId(sessionId) || !validId(value?.id) || !states.has(value?.status)) return null;
  const run = readJson(path.join(dataDirectory(), "assistant-runs", `${runId}.json`));
  if (!run || run.sessionId !== sessionId || !runtimePid || run.persistentRuntimePid !== runtimePid) return null;
  fs.mkdirSync(directory(), { recursive: true, mode: 0o700 });
  return withFileLock(fileFor(runId), () => {
    const record = readJson(fileFor(runId), { runId, sessionId, runtimePid, agents: [] });
    const index = record.agents.findIndex(agent => agent.id === value.id);
    const previous = record.agents[index];
    if (previous && terminal.has(previous.status)) return previous;
    if (index < 0 && record.agents.length >= 64) return null;
    const now = new Date().toISOString();
    const agent = {
      ...previous, id: value.id, runId, sessionId,
      name: clean(value.name, 120) || previous?.name || "Hermes agent",
      task: clean(value.task, 1200) || previous?.task || "",
      status: value.status,
      statusLabel: clean(value.statusLabel, 160) || ({ queued: "Preparing", running: "Working", complete: "Complete", error: "Needs attention", cancelled: "Stopped", interrupted: "Interrupted" })[value.status],
      canStop: value.status === "running" && value.canStop === true && !previous?.stopRequested,
      result: clean(value.result, 12000) || previous?.result || "",
      createdAt: previous?.createdAt || now, updatedAt: now,
    };
    if (previous?.stopRequested && !terminal.has(agent.status)) agent.statusLabel = "Stopping…";
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
    const alive = processAlive(record.runtimePid);
    for (const agent of record.agents || []) {
      if (!terminal.has(agent.status) && !alive) agents.push({ ...agent, status: "interrupted", statusLabel: "Runtime ended before completion was confirmed", canStop: false });
      else agents.push({ ...agent, canStop: alive && agent.canStop });
    }
  }
  return agents.sort((a, b) => Number(!terminal.has(b.status)) - Number(!terminal.has(a.status)) || b.updatedAt.localeCompare(a.updatedAt)).slice(0, 100);
}

export function getDelegatedAgent(sessionId, runId, agentId) {
  return listDelegatedAgents(sessionId).find(agent => agent.runId === runId && agent.id === agentId) || null;
}

export function markDelegationStopping(sessionId, runId, agentId) {
  if (!validId(runId) || !validId(agentId) || !validId(sessionId)) return;
  return withFileLock(fileFor(runId), () => {
    const record = readJson(fileFor(runId));
    if (record?.sessionId !== sessionId) return;
    const agent = record.agents.find(item => item.id === agentId);
    if (!agent || terminal.has(agent.status)) return;
    Object.assign(agent, { stopRequested: true, canStop: false, statusLabel: "Stopping…", updatedAt: new Date().toISOString() });
    writeJson(fileFor(runId), record);
  });
}
