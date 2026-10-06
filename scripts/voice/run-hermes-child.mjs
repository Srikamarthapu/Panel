#!/usr/bin/env node
// A durable process-group gate. The owning group is recorded before Hermes may
// execute; the actual CLI inherits this group and its existing permissions.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { claimHermesProcessGroup, getAssistantRun, recordHermesCliPid, requestFileForRun } from "../../lib/assistant-runs.js";
import { processAlive } from "../../lib/work-store.js";

const id = process.argv[2];
const specFile = `${requestFileForRun(id)}.child.json`;
let child;
let forceTimer;
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  try { child?.kill("SIGTERM"); } catch {}
  forceTimer = setTimeout(() => {
    try { process.kill(process.platform === "win32" ? child?.pid : -process.pid, "SIGKILL"); } catch {}
  }, 4000);
  forceTimer.unref();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

try {
  const run = claimHermesProcessGroup(id);
  if (!run) process.exit(0);
  const spec = JSON.parse(fs.readFileSync(specFile, "utf8"));
  fs.unlinkSync(specFile);
  if (typeof spec.command !== "string" || !Array.isArray(spec.args) || !spec.args.every(value => typeof value === "string")) throw new Error("Invalid child execution specification.");
  const current = getAssistantRun(id);
  if (stopping || !processAlive(run.pid) || current?.executionCancelRequestedAt || current?.executionStopRequestedAt) process.exit(0);
  child = spawn(spec.command, spec.args, { cwd: process.cwd(), env: process.env, stdio: ["ignore", "inherit", "inherit"], detached: false });
  child.once("spawn", () => { try { recordHermesCliPid(id, child.pid); } catch { stop(); } });
  const monitor = setInterval(() => {
    if (processAlive(run.pid)) return;
    // Reconciliation persists the interruption and signals this saved group.
    // The gate also keeps its own escalation alive without a browser poll.
    try { getAssistantRun(id); } catch {}
    stop();
  }, 250);
  child.once("error", () => { clearInterval(monitor); clearTimeout(forceTimer); process.exitCode = 1; });
  child.once("close", code => { clearInterval(monitor); clearTimeout(forceTimer); process.exitCode = Number.isInteger(code) && code >= 0 ? code : (stopping ? 0 : 1); });
} catch {
  process.exitCode = 1;
}
