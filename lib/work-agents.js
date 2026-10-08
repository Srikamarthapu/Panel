import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { listDelegatedAgents } from "./delegated-agents.js";
import { listAssistantRunsForSessions } from "./assistant-runs.js";
import { publicReplyText } from "./publicReply.js";
import { dataDirectory, inputError, readJson, withFileLock, writeJson } from "./work-store.js";
import { createWorkSession, getWorkSession, listWorkSessions, updateWorkSession, currentWorkSessionRun, workSessionRunIsBusy, validateWorkingDirectory, workSessionRunSummary } from "./work-sessions.js";

const validId = value => typeof value === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(value);
export const WORK_AGENT_COLORS = Object.freeze(["sage", "blue", "peach", "lilac"]);
export const DEFAULT_WORK_AGENT_COLOR = "sage";
const root = () => path.join(dataDirectory(), "agents");
const defaultSoul = name => `# ${name}\n\nYou are ${name}, an AI teammate in Panel. Follow the user's task and report verified results.\n`;
function paths(id) {
  if (!validId(id)) throw inputError("Invalid agent ID.");
  const directory = path.join(root(), id);
  return { directory, config: path.join(directory, "agent.json"), soul: path.join(directory, "SOUL.md"), workspace: path.join(directory, "workspace") };
}
function text(value, label, max, required = false) {
  if (typeof value !== "string" || value.length > max || value.includes("\0") || (required && !value.trim())) throw inputError(`${label} must contain ${required ? "1" : "0"}–${max} characters.`);
  return value.trim();
}
function values(input, current = {}) {
  const next = { ...current };
  if (!current.id || Object.hasOwn(input, "name")) next.name = text(input.name, "Agent name", 120, true);
  if (!current.id || Object.hasOwn(input, "soul")) next.soul = text(input.soul || "", "SOUL.md", 20000);
  if (!current.id || Object.hasOwn(input, "model")) next.model = text(input.model || "", "Model ID", 300);
  if (!current.id || Object.hasOwn(input, "provider")) next.provider = text(input.provider || "", "Provider", 120);
  if (!current.id || Object.hasOwn(input, "color")) {
    next.color = input.color === undefined || input.color === "" ? DEFAULT_WORK_AGENT_COLOR : input.color;
    if (!WORK_AGENT_COLORS.includes(next.color)) throw inputError("Choose a supported agent color.");
  }
  if (Boolean(next.model) !== Boolean(next.provider)) throw inputError("Choose both a provider and model, or use the workspace default.");
  if (Object.hasOwn(input, "workingDirectory")) next.workingDirectory = validateWorkingDirectory(input.workingDirectory);
  return next;
}
function saveSoul(file, soul) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, soul, { mode: 0o600 });
  fs.renameSync(temp, file);
}
function storedProfile(agent) {
  const { soul, storagePath, configPath, soulPath, workspacePath, activeRun, lastRun, lastResult, description, stats, ...profile } = agent;
  return profile;
}
const terminalRunStates = new Set(["complete", "error", "cancelled", "interrupted"]);
function availability(reportedRuns, eligibleRuns) {
  if (!reportedRuns) return "unavailable";
  return reportedRuns === eligibleRuns ? "reported" : "partial";
}
function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000_000 ? value : null;
}
function runRuntimeMs(run) {
  const start = Date.parse(run?.runnerStartedAt || ""), end = Date.parse(run?.executionFinishedAt || "");
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}
function runUsage(run) {
  const inputTokens = nonnegativeInteger(run?.usage?.inputTokens), outputTokens = nonnegativeInteger(run?.usage?.outputTokens);
  if (inputTokens === null || outputTokens === null) return null;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}
function statsForRuns(records) {
  const terminalRecords = records.filter(run => terminalRunStates.has(run.state));
  const runtimes = terminalRecords.map(runRuntimeMs).filter(value => value !== null);
  const usages = terminalRecords.map(runUsage).filter(Boolean);
  const costs = terminalRecords.map(run => Number.isFinite(run?.usage?.costUsd) && run.usage.costUsd >= 0 && run.usage.costUsd <= 1_000_000 ? run.usage.costUsd : null).filter(value => value !== null);
  const latest = records.map(run => run.updatedAt || run.createdAt).filter(value => Number.isFinite(Date.parse(value))).sort().at(-1) || null;
  return {
    runs: {
      total: records.length,
      completed: records.filter(run => run.state === "complete").length,
      failed: records.filter(run => run.state === "error").length,
      cancelled: records.filter(run => run.state === "cancelled").length,
      interrupted: records.filter(run => run.state === "interrupted").length,
    },
    runtime: { totalMs: runtimes.length ? runtimes.reduce((sum, value) => sum + value, 0) : null, reportedRuns: runtimes.length, availability: availability(runtimes.length, terminalRecords.length) },
    usage: {
      inputTokens: usages.length ? usages.reduce((sum, usage) => sum + usage.inputTokens, 0) : null,
      outputTokens: usages.length ? usages.reduce((sum, usage) => sum + usage.outputTokens, 0) : null,
      totalTokens: usages.length ? usages.reduce((sum, usage) => sum + usage.totalTokens, 0) : null,
      reportedRuns: usages.length,
      availability: availability(usages.length, terminalRecords.length),
    },
    cost: { amount: costs.length ? costs.reduce((sum, value) => sum + value, 0) : null, currency: costs.length ? "USD" : null, reportedRuns: costs.length, availability: availability(costs.length, terminalRecords.length) },
    lastRunAt: latest,
  };
}
export function workAgentStats(agentId) {
  const sessionIds = listWorkSessions().filter(session => session.agentId === agentId).map(session => session.id);
  return statsForRuns(listAssistantRunsForSessions(sessionIds));
}
export function getWorkAgent(id) {
  const p = paths(id), config = readJson(p.config);
  if (!config) return null;
  return {
    ...config,
    color: WORK_AGENT_COLORS.includes(config.color) ? config.color : DEFAULT_WORK_AGENT_COLOR,
    soul: fs.readFileSync(p.soul, "utf8").slice(0, 20000).trim() || defaultSoul(config.name),
    storagePath: p.directory,
    configPath: p.config,
    soulPath: p.soul,
    workspacePath: config.workingDirectory || p.workspace,
  };
}
export function publicWorkAgent(agent, { includeSoul = false, stats } = {}) {
  if (!agent) return null;
  const { soul, ...profile } = agent;
  const run = currentWorkSessionRun(agent.sessionId);
  return { ...profile, description: soul.split("\n").find(line => line.trim() && !line.startsWith("#"))?.slice(0, 240) || "Give this agent a role in SOUL.md.", stats: stats || workAgentStats(agent.id),
    activeRun: workSessionRunIsBusy(run) ? { ...workSessionRunSummary(run), taskLabel: typeof run.text === "string" ? run.text.replace(/\s+/g, " ").trim().slice(0, 160) : "" } : null, lastRun: workSessionRunSummary(run), lastResult: publicReplyText(run?.response || "").slice(0, 3000), ...(includeSoul ? { soul } : {}) };
}
export function ensureWorkAgentSession(id) {
  const p = paths(id);
  return withFileLock(p.config, () => {
    const current = getWorkAgent(id);
    if (!current) throw inputError("Agent not found.", 404);
    if (current.archivedAt) throw inputError("Restore this agent profile before starting work.", 409);
    const session = getWorkSession(current.sessionId);
    if (session && !session.archivedAt) return current;
    const replacement = createWorkSession({ name: current.name, workingDirectory: current.workingDirectory, agentId: current.id });
    const next = { ...storedProfile(current), sessionId: replacement.id, updatedAt: new Date().toISOString() };
    writeJson(p.config, next);
    return { ...next, soul: current.soul, storagePath: p.directory, configPath: p.config, soulPath: p.soul, workspacePath: next.workingDirectory };
  });
}
export function listWorkAgents({ includeArchived = false } = {}) {
  let ids;
  try { ids = fs.readdirSync(root()); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const profiles = ids.filter(validId).map(id => getWorkAgent(id)).filter(agent => agent && (includeArchived || !agent.archivedAt));
  if (!profiles.length) return [];
  // Agent history spans replacement conversations. Build the relationship and
  // read run files once for the entire list instead of rescanning history for
  // every profile on each poll.
  const profileIds = new Set(profiles.map(agent => agent.id));
  const sessionAgent = new Map(listWorkSessions().filter(session => profileIds.has(session.agentId)).map(session => [session.id, session.agentId]));
  const runsByAgent = new Map(profiles.map(agent => [agent.id, []]));
  for (const run of listAssistantRunsForSessions([...sessionAgent.keys()])) {
    const agentId = sessionAgent.get(run.sessionId);
    if (agentId) runsByAgent.get(agentId).push(run);
  }
  return profiles.map(agent => publicWorkAgent(agent, { stats: statsForRuns(runsByAgent.get(agent.id)) })).sort((a, b) => a.name.localeCompare(b.name));
}
export function createWorkAgent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw inputError("An agent profile is required.");
  const fields = values(input), id = input.id || crypto.randomUUID(), p = paths(id);
  return withFileLock(p.config, () => {
    const existing = getWorkAgent(id);
    if (existing) return existing; // Retrying an accepted creation keeps its identity.
    fs.mkdirSync(p.workspace, { recursive: true, mode: 0o700 });
    const now = new Date().toISOString();
    const workingDirectory = fields.workingDirectory || p.workspace;
    const session = createWorkSession({ name: fields.name, workingDirectory, agentId: id });
    const soul = fields.soul || defaultSoul(fields.name);
    const profile = { id, name: fields.name, color: fields.color, provider: fields.provider, model: fields.model, workingDirectory, sessionId: session.id, createdAt: now, updatedAt: now, archivedAt: null };
    saveSoul(p.soul, soul); writeJson(p.config, profile);
    return { ...profile, soul, storagePath: p.directory, configPath: p.config, soulPath: p.soul, workspacePath: workingDirectory };
  });
}
export function updateWorkAgent(id, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw inputError("An agent profile is required.");
  const p = paths(id);
  return withFileLock(p.config, () => {
    const current = getWorkAgent(id);
    if (!current) throw inputError("Agent not found.", 404);
    if (workSessionRunIsBusy(currentWorkSessionRun(current.sessionId))) throw inputError("Wait for this agent to finish, or stop its work before editing its profile.", 409);
    if (listDelegatedAgents(current.sessionId).some(agent => ["queued", "running"].includes(agent.status))) throw inputError("Stop this agent's delegated work before editing its profile.", 409);
    const next = values(input, current);
    next.soul ||= defaultSoul(next.name);
    if (Object.hasOwn(input, "archived") && typeof input.archived !== "boolean") throw inputError("Archived must be true or false.");
    const soul = next.soul;
    const profile = storedProfile(next);
    profile.updatedAt = new Date().toISOString();
    profile.workingDirectory ||= p.workspace;
    if (Object.hasOwn(input, "archived")) profile.archivedAt = input.archived ? profile.updatedAt : null;
    updateWorkSession(current.sessionId, { name: profile.name, workingDirectory: profile.workingDirectory, ...(Object.hasOwn(input, "archived") ? { archived: input.archived } : {}) });
    saveSoul(p.soul, soul); writeJson(p.config, profile);
    return { ...profile, soul, storagePath: p.directory, configPath: p.config, soulPath: p.soul, workspacePath: profile.workingDirectory };
  });
}

export function agentForSession(session) {
  if (!session?.agentId) return null;
  const agent = getWorkAgent(session.agentId);
  if (!agent || agent.archivedAt) throw inputError("This agent is unavailable. Restore its profile before starting work.", 409);
  if (agent.sessionId !== session.id) throw inputError("This is an earlier saved conversation for this agent. Open the agent's current conversation to continue; this history remains available here.", 409);
  return agent;
}
