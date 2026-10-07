import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { listDelegatedAgents } from "./delegated-agents.js";
import { publicReplyText } from "./publicReply.js";
import { dataDirectory, inputError, readJson, withFileLock, writeJson } from "./work-store.js";
import { createWorkSession, updateWorkSession, currentWorkSessionRun, workSessionRunIsBusy, validateWorkingDirectory, workSessionRunSummary } from "./work-sessions.js";

const validId = value => typeof value === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(value);
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
  if (Boolean(next.model) !== Boolean(next.provider)) throw inputError("Choose both a provider and model, or use the workspace default.");
  if (Object.hasOwn(input, "workingDirectory")) next.workingDirectory = validateWorkingDirectory(input.workingDirectory);
  return next;
}
function saveSoul(file, soul) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, soul, { mode: 0o600 });
  fs.renameSync(temp, file);
}
export function getWorkAgent(id) {
  const p = paths(id), config = readJson(p.config);
  if (!config) return null;
  return { ...config, soul: fs.readFileSync(p.soul, "utf8").slice(0, 20000).trim() || defaultSoul(config.name), soulPath: p.soul };
}
export function publicWorkAgent(agent, { includeSoul = false } = {}) {
  if (!agent) return null;
  const { soul, ...profile } = agent;
  const run = currentWorkSessionRun(agent.sessionId);
  return { ...profile, description: soul.split("\n").find(line => line.trim() && !line.startsWith("#"))?.slice(0, 240) || "Give this agent a role in SOUL.md.",
    activeRun: workSessionRunIsBusy(run) ? workSessionRunSummary(run) : null, lastRun: workSessionRunSummary(run), lastResult: publicReplyText(run?.response || "").slice(0, 3000), ...(includeSoul ? { soul } : {}) };
}
export function listWorkAgents({ includeArchived = false } = {}) {
  let ids;
  try { ids = fs.readdirSync(root()); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return ids.filter(validId).map(id => getWorkAgent(id)).filter(agent => agent && (includeArchived || !agent.archivedAt)).map(agent => publicWorkAgent(agent)).sort((a, b) => a.name.localeCompare(b.name));
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
    const profile = { id, name: fields.name, provider: fields.provider, model: fields.model, workingDirectory, sessionId: session.id, createdAt: now, updatedAt: now, archivedAt: null };
    saveSoul(p.soul, soul); writeJson(p.config, profile);
    return { ...profile, soul, soulPath: p.soul };
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
    const { soul, soulPath, activeRun, lastRun, ...profile } = next;
    profile.updatedAt = new Date().toISOString();
    profile.workingDirectory ||= p.workspace;
    if (Object.hasOwn(input, "archived")) profile.archivedAt = input.archived ? profile.updatedAt : null;
    updateWorkSession(current.sessionId, { name: profile.name, workingDirectory: profile.workingDirectory, ...(Object.hasOwn(input, "archived") ? { archived: input.archived } : {}) });
    saveSoul(p.soul, soul); writeJson(p.config, profile);
    return { ...profile, soul, soulPath: p.soul };
  });
}

export function agentForSession(session) {
  if (!session?.agentId) return null;
  const agent = getWorkAgent(session.agentId);
  if (!agent || agent.sessionId !== session.id || agent.archivedAt) throw inputError("This agent is unavailable. Restore its profile before starting work.", 409);
  return agent;
}
