import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readMissionStore, storePath } from "./missionStore.js";
import { getMarketStateSnapshot } from "./market.js";
import { redactedModelOptions } from "./modelControl.js";
import { getVoiceConfig } from "./voice.js";

const home = os.homedir();
const hermesHome = process.env.HERMES_HOME || path.join(home, ".hermes");
const workspaceRoot = process.cwd();
const ledgerRunsPath = path.join(workspaceRoot, "orchestrator", "ledger", "runs.jsonl");

function readText(file, fallback = "") {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return fallback;
  }
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(readText(file));
  } catch {
    return fallback;
  }
}

function exists(file) {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

function stat(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function isoFromMaybeUnix(value) {
  if (!value) return "";
  if (typeof value === "number") {
    const millis = value > 10_000_000_000 ? value : value * 1000;
    return new Date(millis).toISOString();
  }
  return value;
}

function tail(file, count = 80) {
  return readText(file)
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-count);
}

function tailFileLines(file, count = 80, maxBytes = 128 * 1024) {
  try {
    const info = fs.statSync(file);
    if (!info.isFile()) return [];
    const bytesToRead = Math.min(info.size, maxBytes);
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buffer, 0, bytesToRead, info.size - bytesToRead);
      return buffer
        .toString("utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-count);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

function words(text) {
  return (text.match(/\S+/g) || []).length;
}

function nestedYamlValue(text, parent, key) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `${parent}:`);
  if (start === -1) return "";

  for (const line of lines.slice(start + 1)) {
    if (line && !/^\s/.test(line)) break;
    const match = line.match(new RegExp(`^\\s+${key}:\\s*(.+)$`));
    if (match) return match[1].replace(/^["']|["']$/g, "").trim();
  }

  return "";
}

function sqliteJson(db, sql) {
  if (!exists(db)) return [];
  try {
    const out = execFileSync("sqlite3", ["-json", db, sql], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return JSON.parse(out || "[]");
  } catch {
    return [];
  }
}

function safeJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function commandJson(command, args) {
  try {
    const out = execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 8000 });
    return JSON.parse(out || "null");
  } catch {
    return null;
  }
}

function getModel(configText) {
  const model = nestedYamlValue(configText, "model", "default") || "unknown";
  const provider = nestedYamlValue(configText, "model", "provider") || "unknown";
  const baseUrl = nestedYamlValue(configText, "model", "base_url") || "";
  const effort = nestedYamlValue(configText, "agent", "reasoning_effort") || "unknown";
  const legacyFallback = configText.match(/^fallback_model:\n\s+provider:\s*(.+)\n\s+model:\s*(.+)$/m);
  const fallback = legacyFallback
    ? [{ provider: legacyFallback[1].trim(), model: legacyFallback[2].trim() }]
    : [];
  return { model, provider, baseUrl, effort, fallback };
}

function getGatewayState() {
  const gatewayState = readJson(path.join(hermesHome, "gateway_state.json"), {});
  const gatewayPid = readText(path.join(hermesHome, "gateway.pid")).trim();
  const dashboardLog = path.join(hermesHome, "logs", "dashboard.log");
  const platforms = gatewayState.platforms || {};
  const connectedPlatform = Object.values(platforms).some((platform) => platform?.state === "connected");
  return {
    state: gatewayState.state || (connectedPlatform || gatewayPid ? "running" : "unknown"),
    pid: gatewayPid || null,
    platforms,
    dashboardSeen: exists(dashboardLog),
    updatedAt: gatewayState.updated_at || ""
  };
}

function getCronJobs() {
  const cron = readJson(path.join(hermesHome, "cron", "jobs.json"), { jobs: [] });
  return {
    updatedAt: cron.updated_at || "",
    jobs: Array.isArray(cron.jobs) ? cron.jobs : []
  };
}

function getKanban() {
  const db = path.join(hermesHome, "kanban.db");
  const statusRows = sqliteJson(db, "select status, count(*) as count from tasks group by status order by status;");
  const tasks = sqliteJson(
    db,
    "select id,title,status,assignee,priority,created_at,completed_at,last_heartbeat_at,current_run_id,worker_pid,model_override from tasks order by created_at desc limit 80;"
  );
  const events = sqliteJson(
    db,
    "select task_id,kind,created_at,payload from task_events order by created_at desc limit 12;"
  );
  const runs = sqliteJson(
    db,
    "select id,task_id,profile,status,worker_pid,last_heartbeat_at,started_at,ended_at,outcome,summary,error from task_runs order by started_at desc limit 30;"
  );
  return { db, statusRows, tasks, events, runs };
}

export function getMemory() {
  const memoryDir = path.join(hermesHome, "memories");
  const memory = readText(path.join(memoryDir, "MEMORY.md"));
  const user = readText(path.join(memoryDir, "USER.md"));
  const files = fs.existsSync(memoryDir)
    ? fs
        .readdirSync(memoryDir)
        .filter((name) => name.endsWith(".md"))
        .map((name) => {
          const file = path.join(memoryDir, name);
          const text = readText(file);
          return {
            name,
            path: file,
            words: words(text),
            updatedAt: stat(file)?.mtime?.toISOString() || "",
            excerpt: text.split(/\r?\n/).filter(Boolean).slice(0, 5).join("\n"),
            body: text
          };
        })
    : [];
  const timeline = files
    .map((file) => {
      const lines = file.body
        .split(/\r?\n/)
        .map((line) => line.replace(/^[-#*\s]+/, "").trim())
        .filter((line) => line && line !== "§" && !line.startsWith("<!--"))
        .slice(0, 8);
      return {
        name: file.name,
        path: file.path,
        words: file.words,
        updatedAt: file.updatedAt,
        items: lines
      };
    })
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return { memory, user, files, timeline, learningEvents: getLearningEvents(files) };
}

function getLearningEvents(memoryFiles) {
  const db = path.join(hermesHome, "state.db");
  const rows = sqliteJson(
    db,
    `select
      m.id,
      m.session_id,
      s.title,
      s.source,
      s.model,
      m.timestamp,
      m.tool_calls
    from messages m
    left join sessions s on s.id = m.session_id
    where m.role = 'assistant'
      and (
        coalesce(m.tool_calls, '') like '%"name": "memory"%'
        or coalesce(m.tool_calls, '') like '%"name":"memory"%'
        or coalesce(m.tool_calls, '') like '%"name": "skill_manage"%'
        or coalesce(m.tool_calls, '') like '%"name":"skill_manage"%'
      )
    order by m.timestamp desc
    limit 60;`
  );

  const events = [];
  for (const row of rows) {
    const calls = safeJson(row.tool_calls, []);
    for (const call of Array.isArray(calls) ? calls : []) {
      const fn = call?.function || {};
      const args = safeJson(fn.arguments || "{}", {});
      if (fn.name === "memory") {
        if (!["add", "replace", "remove"].includes(args.action)) continue;
        events.push({
          id: `memory-${row.id}-${call.id || events.length}`,
          type: "memory",
          action: args.action,
          target: args.target || "memory",
          title: `${args.action || "update"} ${args.target || "memory"}`,
          summary: args.content || args.new_content || args.substring || "Memory changed.",
          sessionTitle: row.title || row.session_id,
          source: row.source || "session",
          model: row.model || "",
          updatedAt: isoFromMaybeUnix(row.timestamp)
        });
      } else if (fn.name === "skill_manage") {
        events.push({
          id: `skill-${row.id}-${call.id || events.length}`,
          type: "skill",
          action: args.action || "update",
          target: args.name || args.skill || "skill",
          title: `${args.action || "updated"} skill`,
          summary: args.content || args.patch || args.description || "Skill library changed.",
          sessionTitle: row.title || row.session_id,
          source: row.source || "session",
          model: row.model || "",
          updatedAt: isoFromMaybeUnix(row.timestamp)
        });
      }
    }
  }

  if (!events.length) {
    return memoryFiles
      .slice()
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .map((file) => ({
        id: `file-${file.path}`,
        type: "memory-file",
        action: "file update",
        target: file.name,
        title: file.name === "USER.md" ? "User profile file changed" : "Long-term memory file changed",
        summary: file.excerpt || "No readable memory entry yet.",
        sessionTitle: "file mtime",
        source: "filesystem",
        model: "",
        updatedAt: file.updatedAt
      }));
  }

  return events.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 20);
}

// Curated activity feed for the voice-dock ticker and dashboard.
//
// The ticker must show what the user actually cares about: orchestrator mission
// progress (the runs.jsonl ledger) and Hermes activity (memory writes, task
// events, sessions). Runtime log lines are noise. A naive "merge everything then
// sort by updatedAt" starves the real events, because the log signals below
// synthesize `now`-anchored timestamps that always sort newest and crowd the
// substantive events out of the final slice. To honor the contract — real
// mission/activity events must always surface, newest-first — we bucket by
// source priority and guarantee each substantive bucket a reserved quota before
// low-signal log lines are allowed to fill the remainder.
const ACTIVITY_FEED_LIMIT = 24;
// Reserved slots per bucket so high-frequency, low-signal sources cannot starve
// mission progress. Buckets are drained newest-first; leftover capacity is then
// shared. `log` gets no reservation — it only fills slots nothing else claims.
const ACTIVITY_BUCKET_QUOTA = { ledger: 8, memory: 8, task: 4, session: 1 };

function byUpdatedAtDesc(a, b) {
  return String(b.updatedAt).localeCompare(String(a.updatedAt));
}

export function buildActivityFeed({ memory, kanban, logs, sessions, ledger }) {
  const buckets = { ledger: [], memory: [], task: [], session: [], log: [] };
  const collect = (bucket, item) => {
    if (item?.updatedAt) buckets[bucket].push(item);
  };

  for (const event of ledger || []) collect("ledger", event);

  for (const event of (memory.learningEvents || []).slice(0, 12)) {
    collect("memory", {
      id: event.id,
      kind: event.type,
      label: event.type === "memory" ? "Memory" : event.type === "skill" ? "Skill" : "Memory file",
      title: event.title,
      summary: event.summary,
      source: event.sessionTitle || event.source || "memory",
      updatedAt: event.updatedAt
    });
  }

  for (const event of (kanban.events || []).slice(0, 8)) {
    const payload =
      typeof event.payload === "string"
        ? safeJson(event.payload, event.payload)
        : event.payload;
    const summary =
      typeof payload === "string"
        ? payload
        : payload && typeof payload === "object"
          ? JSON.stringify(payload).slice(0, 180)
          : String(event.payload || "");
    collect("task", {
      id: `${event.task_id || "task"}-${event.kind}-${event.created_at}`,
      kind: "task",
      label: "Task",
      title: event.kind || "task event",
      summary: summary || "Task event recorded.",
      source: event.task_id || "kanban",
      updatedAt: isoFromMaybeUnix(event.created_at)
    });
  }

  const now = Date.now();
  [...(logs.recentGateway || []).slice(-6), ...(logs.recentErrors || []).slice(-6)].forEach((line, index) => {
    const isError = line.toLowerCase().includes("error");
    collect("log", {
      id: `log-${index}-${line.slice(0, 24)}`,
      kind: "log",
      label: isError ? "Error" : "Signal",
      title: isError ? "Hermes error signal" : "Hermes runtime signal",
      summary: line,
      source: isError ? "errors.log" : "gateway.log",
      updatedAt: new Date(now - index * 45_000).toISOString()
    });
  });

  const latestSession = sessions.files?.[0];
  if (latestSession) {
    collect("session", {
      id: `session-${latestSession.name}`,
      kind: "session",
      label: "Session",
      title: latestSession.name,
      summary: [latestSession.provider, latestSession.model].filter(Boolean).join(" / ") || "Recent session snapshot.",
      source: "sessions",
      updatedAt: latestSession.updatedAt || new Date().toISOString()
    });
  }

  for (const bucket of Object.values(buckets)) bucket.sort(byUpdatedAtDesc);

  return curateActivityFeed(buckets, ACTIVITY_FEED_LIMIT);
}

// Assemble the final feed from prioritised buckets. Pass 1 hands each
// substantive bucket its reserved quota (newest-first). Pass 2 shares any
// remaining capacity across every bucket, including logs, again newest-first.
// The result is sorted globally so the ticker still reads strictly newest-first,
// but the reservation in pass 1 guarantees mission/activity events survive even
// when synthetic log timestamps would otherwise dominate.
export function curateActivityFeed(buckets, limit = ACTIVITY_FEED_LIMIT) {
  const cursors = {};
  const picked = [];
  const seen = new Set();
  const take = (name, count) => {
    const list = buckets[name] || [];
    let start = cursors[name] || 0;
    let n = 0;
    while (start < list.length && n < count && picked.length < limit) {
      const item = list[start];
      start += 1;
      const key = item.id ?? `${item.source}-${item.updatedAt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push(item);
      n += 1;
    }
    cursors[name] = start;
  };

  for (const [name, quota] of Object.entries(ACTIVITY_BUCKET_QUOTA)) {
    take(name, quota);
  }

  // Fill remaining slots from any bucket that still has events, mission-first.
  const fillOrder = ["ledger", "memory", "task", "session", "log"];
  let progressed = true;
  while (picked.length < limit && progressed) {
    progressed = false;
    for (const name of fillOrder) {
      const before = picked.length;
      take(name, 1);
      if (picked.length > before) progressed = true;
      if (picked.length >= limit) break;
    }
  }

  return picked.sort(byUpdatedAtDesc);
}

function compactList(items, fallback = "") {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  return list.length ? list.join(" · ") : fallback;
}

export function normalizeLedgerRunEvent(entry, index = 0) {
  if (!entry || typeof entry !== "object" || !entry.ts) return null;
  const task = String(entry.task || "task").trim();
  const attempt = entry.attempt ? `attempt ${entry.attempt}` : "";
  const model = String(entry.model || "").trim();
  const profile = String(entry.profile || entry.profileId || "").trim();
  const cost =
    entry.cost && typeof entry.cost === "object"
      ? compactList([
          entry.cost.total != null ? `$${entry.cost.total}` : "",
          entry.cost.input_tokens != null ? `${entry.cost.input_tokens} in` : "",
          entry.cost.output_tokens != null ? `${entry.cost.output_tokens} out` : "",
        ])
      : "";
  const base = {
    id: `ledger-${entry.kind || "event"}-${task}-${entry.attempt || ""}-${entry.ts}-${index}`,
    kind: "task",
    label: "Orchestrator",
    source: "orchestrator/ledger",
    updatedAt: entry.ts,
  };

  if (entry.kind === "worker") {
    return {
      ...base,
      title: `Task ${task} routed to ${profile || model || "worker"}`,
      summary: compactList([attempt, model, entry.status ? `status ${entry.status}` : "", cost], "Worker run recorded."),
    };
  }

  if (entry.kind === "gate1") {
    const ok = entry.ok === true;
    const failures = Array.isArray(entry.failures) ? entry.failures.length : 0;
    const files = Array.isArray(entry.files) ? entry.files.length : 0;
    return {
      ...base,
      title: ok ? `Gate passed for ${task}` : `Gate blocked ${task}`,
      summary: ok
        ? compactList([attempt, files ? `${files} file${files === 1 ? "" : "s"} checked` : ""], "Scope gate passed.")
        : compactList([attempt, failures ? `${failures} failure${failures === 1 ? "" : "s"}` : ""], "Scope gate failed."),
    };
  }

  if (entry.kind === "judge") {
    const report = entry.report && typeof entry.report === "object" ? entry.report : {};
    const weighted = report.weighted ?? entry.score;
    const verdict = report.verdict || entry.verdict || "";
    return {
      ...base,
      title: weighted != null ? `Judge scored ${task}: ${weighted}` : `Judge reviewed ${task}`,
      summary: compactList([attempt, verdict ? `verdict ${verdict}` : "", cost], "Judge report recorded."),
    };
  }

  if (entry.kind === "outcome") {
    return {
      ...base,
      title: entry.result === "merged" ? `Task ${task} merged` : `Task ${task} ${entry.result || "completed"}`,
      summary: compactList([
        entry.attempts ? `${entry.attempts} attempt${entry.attempts === 1 ? "" : "s"}` : "",
        entry.score != null ? `score ${entry.score}` : "",
        entry.reason ? String(entry.reason).slice(0, 180) : "",
      ], "Outcome recorded."),
    };
  }

  if (entry.kind === "qa") {
    const evidence = entry.evidence && typeof entry.evidence === "object" ? entry.evidence : {};
    return {
      ...base,
      title: `QA checked ${task}`,
      summary: compactList([
        attempt,
        evidence.passing != null ? `${evidence.passing} passing` : "",
        evidence.failing != null ? `${evidence.failing} failing` : "",
      ], "QA evidence recorded."),
    };
  }

  if (entry.kind === "failover") {
    return {
      ...base,
      title: `Task ${task} failed over`,
      summary: compactList([attempt, entry.from ? `from ${entry.from}` : "", entry.reason || ""], "Worker failover recorded."),
    };
  }

  return {
    ...base,
    title: `Orchestrator ${entry.kind || "event"} for ${task}`,
    summary: compactList([attempt, model, entry.status || entry.result || ""], "Ledger event recorded."),
  };
}

function getLedgerRunEvents() {
  return tailFileLines(ledgerRunsPath, 40)
    .map((line, index) => normalizeLedgerRunEvent(safeJson(line, null), index))
    .filter(Boolean);
}

function getSessions() {
  const sessionsDir = path.join(hermesHome, "sessions");
  const index = readJson(path.join(sessionsDir, "sessions.json"), {});
  const list = Object.values(index || {});
  const files = (exists(sessionsDir) ? fs.readdirSync(sessionsDir, { withFileTypes: true }) : [])
    .filter((entry) => entry.isFile() && entry.name.startsWith("session_") && entry.name.endsWith(".json"))
    .map((entry) => {
      const file = path.join(sessionsDir, entry.name);
      const data = readJson(file, {});
      return {
        file,
        name: entry.name,
        model: data.model || "",
        provider: data.provider || "",
        baseUrl: data.base_url || "",
        updatedAt: stat(file)?.mtime?.toISOString() || ""
      };
    })
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return { list, files };
}

function getAssignees() {
  if (assigneesCache && Date.now() - assigneesCache.readAt < 30_000) return assigneesCache.names;
  const rows = commandJson("hermes", ["kanban", "assignees", "--json"]);
  const names = Array.isArray(rows) ? rows.map((row) => row.name).filter(Boolean) : ["default"];
  const unique = Array.from(new Set(names));
  assigneesCache = { names: unique, readAt: Date.now() };
  return unique;
}

let assigneesCache = null;

function getLogSignals() {
  const gateway = tailFileLines(path.join(hermesHome, "logs", "gateway.log"), 160);
  const errors = tailFileLines(path.join(hermesHome, "logs", "errors.log"), 100);
  const joined = [...gateway, ...errors].join("\n");
  return {
    recentGateway: gateway.slice(-16),
    recentErrors: errors.slice(-16),
    recentModelFailures: [...gateway, ...errors]
      .filter((line) => /429|RateLimitError|Too Many Requests|fallback|APITimeoutError|timed out|provider=nvidia/i.test(line))
      .slice(-20),
    nvidia429: (joined.match(/provider=nvidia|Provider: nvidia/g) || []).length
      ? (joined.match(/429|RateLimitError|Too Many Requests/g) || []).length
      : 0,
    fallbackMentions: (joined.match(/switching to fallback|fallback:/gi) || []).length,
    timeoutMentions: (joined.match(/APITimeoutError|timed out/gi) || []).length
  };
}

function getDocs() {
  const candidates = [
    path.join(workspaceRoot, "HERMES_AUTONOMY_MISSION_CONTROL_PLAN.md"),
    path.join(hermesHome, "SOUL.md"),
    path.join(hermesHome, "memories", "MEMORY.md"),
    path.join(hermesHome, "memories", "USER.md")
  ];
  return candidates
    .filter(exists)
    .map((file) => {
      const text = readText(file);
      return {
        name: path.basename(file),
        path: file,
        words: words(text),
        updatedAt: stat(file)?.mtime?.toISOString() || "",
        excerpt: text.split(/\r?\n/).filter(Boolean).slice(0, 4).join("\n"),
        body: text
      };
    });
}

function workspaceFileCount() {
  try {
    return fs
      .readdirSync(/* turbopackIgnore: true */ workspaceRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() || entry.isDirectory())
      .length;
  } catch {
    return 0;
  }
}

function getAgentState(model, gateway, kanban, sessions) {
  const runningTasks = kanban.tasks.filter((task) => task.status === "running" || task.status === "in_progress");
  const activeRuns = kanban.runs.filter((run) => run.status === "running");
  const latestSession = sessions.files[0] || null;
  const hermesActive = gateway.state === "running" || runningTasks.length > 0;
  return [
    {
      id: "hermes",
      name: "Hermes",
      role: "Primary local agent",
      status: hermesActive ? "active" : "idle",
      online: hermesActive,
      location: gateway.platforms?.discord?.state === "connected" ? "Discord home channel" : "Local gateway",
      model: `${model.provider}/${model.model}`,
      provider: model.provider,
      subagents: activeRuns.length,
      runningTasks: runningTasks.length,
      lastSeen: latestSession?.updatedAt || gateway.updatedAt || "",
      note: "Coordinates memory, Discord, tasks, schedules, and local tools."
    }
  ];
}

let missionCache = null;

function missionRevision() {
  // A router refresh immediately after a mutation must see that mutation, even
  // inside the short cache window. SQLite may commit into its WAL first.
  return [
    path.join(hermesHome, "kanban.db"),
    path.join(hermesHome, "kanban.db-wal"),
    path.join(hermesHome, "config.yaml"),
    path.join(hermesHome, ".env"),
    path.join(hermesHome, "cron", "jobs.json"),
    path.join(workspaceRoot, "data", "mission-control.json"),
    path.join(workspaceRoot, "data", "voice-config.json"),
  ].map((file) => {
    const info = stat(file);
    return info ? `${info.mtimeMs}:${info.size}` : "missing";
  }).join("|");
}

export function getMissionData() {
  const revision = missionRevision();
  if (missionCache && missionCache.revision === revision && Date.now() - missionCache.readAt < 2_000) return missionCache.data;
  const configPath = path.join(hermesHome, "config.yaml");
  const envPath = path.join(hermesHome, ".env");
  const configText = readText(configPath);
  const model = getModel(configText);
  const gateway = getGatewayState();
  const cron = getCronJobs();
  const kanban = getKanban();
  const memory = getMemory();
  const sessions = getSessions();
  const assignees = getAssignees();
  const logs = getLogSignals();
  const docs = getDocs();
  const store = readMissionStore();
  const modelOptions = redactedModelOptions(model);
  const agents = getAgentState(model, gateway, kanban, sessions);
  const market = getMarketStateSnapshot();
  const voice = getVoiceConfig();
  const ledger = getLedgerRunEvents();
  const activity = buildActivityFeed({ memory, kanban, logs, sessions, ledger });

  const data = {
    paths: { hermesHome, configPath, envPath, workspaceRoot },
    dashboard: {
      url: process.env.MISSION_CONTROL_URL || "http://localhost:3000",
      apiUrl: `${process.env.MISSION_CONTROL_URL || "http://localhost:3000"}/api/mission-control`,
      readableByHermes: true
    },
    model,
    gateway,
    cron,
    kanban,
    assignees,
    memory,
    sessions,
    logs,
    docs,
    market,
    modelOptions,
    agents,
    voice,
    activity,
    storePath,
    projects: [
      {
        id: "mission-control-core",
        name: "Hermes Mission Control",
        path: workspaceRoot,
        status: "active local build",
        summary: "Local dashboard wired to real Hermes files, memory, cron state, logs, and Kanban SQLite.",
        facts: [`${workspaceFileCount()} workspace entries`, `${docs.length} indexed docs`, `${memory.files.length} memory files`]
      },
      ...(store.projects || []).map((project) => ({
        ...project,
        path: storePath,
        facts: [project.owner || "Hermes", project.status || "active", `created ${project.createdAt?.slice(0, 10) || "locally"}`]
      }))
    ]
  };
  missionCache = { data, revision: missionRevision(), readAt: Date.now() };
  return data;
}
