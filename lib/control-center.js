import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeLedgerRunEvent } from "./hermes.js";
import { deriveOrbActivity } from "./control-center-status.js";
import { dataDirectory } from "./work-store.js";

const execFileAsync = promisify(execFile);
const SNAPSHOT_TTL_MS = 1_000;
let cached = null;
let pending = null;

async function readText(file) {
  try { return await fs.readFile(file, "utf8"); } catch { return ""; }
}
async function readJson(file, fallback = {}) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return fallback; }
}

export async function readBoundedLines(file, limit = 80, maxBytes = 128 * 1024) {
  let handle;
  try {
    handle = await fs.open(file, "r");
    const { size } = await handle.stat();
    const offset = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(Math.min(size, maxBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/);
    if (offset > 0) lines.shift();
    return lines.filter(Boolean).slice(-limit);
  } catch { return []; } finally { await handle?.close(); }
}

export function isProcessAlive(pid) {
  const number = Number(pid);
  if (!Number.isSafeInteger(number) || number <= 0) return false;
  try { process.kill(number, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

export function normalizeGateway(state, pidText, { now = Date.now(), processAlive = isProcessAlive } = {}) {
  const pid = Number(state.pid || String(pidText || "").trim()) || null;
  const online = pid ? processAlive(pid) : false;
  const timestamp = Date.parse(state.updated_at || "");
  const reportedState = state.gateway_state || state.state || "unknown";
  // Hermes writes this file on state transitions, not on a heartbeat. Its
  // gateway/status.py derive_gateway_busy explicitly forbids timestamp-based
  // liveness: an idle gateway may leave updated_at unchanged for hours.
  const isStale = online && reportedState === "unknown";
  return {
    state: !online ? "offline" : isStale ? "unknown" : reportedState,
    online,
    running: online && !isStale && reportedState === "running",
    isStale,
    pid,
    updatedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
    activeAgents: online && !isStale ? Math.max(0, Number(state.active_agents) || 0) : 0,
    platforms: Object.fromEntries(Object.entries(state.platforms || {}).map(([name, platform]) => [name, { state: online && !isStale ? platform?.state || "unknown" : "unknown" }])),
  };
}

function modelFromConfig(text) {
  const block = text.match(/^model:\s*\n((?:[ \t]+.*\n?)*)/m)?.[1] || "";
  const value = (key) => block.match(new RegExp(`^\\s+${key}:\\s*(.+)$`, "m"))?.[1]?.trim().replace(/^["']|["']$/g, "") || "unknown";
  return { provider: value("provider"), model: value("default") };
}

async function readTasks(hermesHome) {
  try {
    const db = path.join(hermesHome, "kanban.db");
    await fs.access(db);
    const sql = `SELECT json_object('total', count(*), 'active', coalesce(sum(status IN ('running','in_progress')),0), 'queued', coalesce(sum(status IN ('queued','todo','pending','ready')),0), 'done', coalesce(sum(status IN ('done','completed')),0)) AS counts FROM tasks;
      SELECT id,title,status,last_heartbeat_at,worker_pid FROM tasks ORDER BY status IN ('running','in_progress') DESC, created_at DESC LIMIT 8;`;
    const { stdout } = await execFileAsync("sqlite3", ["-json", "-readonly", db, sql], { timeout: 1_000, maxBuffer: 64 * 1024 });
    // sqlite3 prints one JSON array per statement, each on its own line.
    const [countJson, ...rowLines] = stdout.trim().split("\n");
    const counts = JSON.parse(JSON.parse(countJson)[0].counts);
    const recent = rowLines.length ? JSON.parse(rowLines.join("\n")) : [];
    return { ...counts, recent, available: true };
  } catch { return { total: null, active: null, queued: null, done: null, recent: [], available: false }; }
}

export async function readControlCenterSnapshot({ workspaceRoot = process.cwd(), hermesHome = process.env.HERMES_HOME || path.join(os.homedir(), ".hermes"), now = Date.now(), processAlive = isProcessAlive } = {}) {
  const [gatewayState, pidText, config, voiceStore, ledgerLines, tasks] = await Promise.all([
    readJson(path.join(hermesHome, "gateway_state.json")),
    readText(path.join(hermesHome, "gateway.pid")),
    readText(path.join(hermesHome, "config.yaml")),
    readJson(path.join(process.env.PANEL_DATA_DIR ? dataDirectory() : path.join(workspaceRoot, "data"), "voice-activity.json"), { events: [] }),
    readBoundedLines(path.join(workspaceRoot, "orchestrator", "ledger", "runs.jsonl"), 40),
    readTasks(hermesHome),
  ]);
  const gateway = normalizeGateway(gatewayState, pidText, { now, processAlive });
  const ledger = ledgerLines.map((line, index) => {
    try { return normalizeLedgerRunEvent(JSON.parse(line), index); } catch { return null; }
  }).filter(Boolean);
  const voiceEvents = Array.isArray(voiceStore.events) ? voiceStore.events.slice(0, 120) : [];
  const taskEvents = tasks.recent.filter((task) => ["running", "in_progress"].includes(task.status) && processAlive(task.worker_pid)).map((task) => ({
    id: `task-${task.id}`, kind: "task", state: "active", title: task.title,
    source: "hermes/task", updatedAt: task.last_heartbeat_at,
  }));
  const activity = [...voiceEvents, ...taskEvents, ...ledger]
    .filter((event) => event && event.id && event.updatedAt)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, 120);
  const generatedAt = new Date(now).toISOString();
  const repo = process.env.HERMES_REPO || path.join(hermesHome, "hermes-agent");
  const environmentFound = await fs.access(path.join(repo, "venv/bin/python")).then(() => true, () => false);
  const runtime = { available: environmentFound && !!config };
  // The local CLI runs Panel turns independently of the optional messaging gateway.
  return { ok: true, generatedAt, gateway, runtime, model: modelFromConfig(config), tasks, activity, status: deriveOrbActivity({ activity, gateway, runtimeReady: runtime.available, fetchedAt: generatedAt, now }) };
}

export function getControlCenterSnapshot() {
  if (cached && Date.now() - Date.parse(cached.generatedAt) < SNAPSHOT_TTL_MS) return Promise.resolve(cached);
  if (!pending) pending = readControlCenterSnapshot().then((snapshot) => { cached = snapshot; return snapshot; }).finally(() => { pending = null; });
  return pending;
}
