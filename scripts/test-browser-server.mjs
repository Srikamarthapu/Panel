#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { browserBuildArguments, browserServerEnvironment, browserStartArguments, stageBrowserProject } from "./test-browser-environment.mjs";

const root = process.cwd();
const port = Number(process.env.PANEL_TEST_PORT || 3012);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("PANEL_TEST_PORT must be a valid unprivileged port.");
const next = process.env.PANEL_TEST_NEXT_BINARY
  ? path.resolve(process.env.PANEL_TEST_NEXT_BINARY)
  : path.join(root, "node_modules", "next", "dist", "bin", "next");
if (!fs.statSync(next).isFile()) throw new Error("The browser test server executable is not a file.");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "panel-browser-"));
let stage;
try {
  stage = stageBrowserProject(root, temporary);
} catch (error) {
  fs.rmSync(temporary, { recursive: true, force: true });
  throw error;
}
const environment = browserServerEnvironment(temporary);
environment.PANEL_APP_ROOT = stage;
let stopping = false;
let child = null;
let phase = "build";
let forceTimer = null;
let finished = false;
function ownedDescendants(rootPid) {
  if (process.platform === "win32") return [rootPid];
  let rows;
  try {
    rows = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
  } catch {
    return [rootPid];
  }
  const children = new Map();
  for (const line of rows.split("\n")) {
    const [pid, parent] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(pid) || !Number.isInteger(parent)) continue;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(pid);
  }
  const owned = [];
  const pending = [rootPid];
  while (pending.length) {
    const pid = pending.shift();
    owned.push(pid);
    pending.push(...(children.get(pid) || []));
  }
  return owned.reverse();
}
function signalChild(signal = "SIGTERM") {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  for (const pid of ownedDescendants(child.pid)) {
    try { process.kill(pid, signal); } catch {}
  }
}
function finish(code = 0) {
  if (finished) return;
  finished = true;
  if (forceTimer) clearTimeout(forceTimer);
  fs.rmSync(temporary, { recursive: true, force: true });
  process.exitCode = code;
}
function launch(args) {
  const launched = spawn(process.execPath, args, {
    cwd: stage,
    env: environment,
    stdio: "inherit",
    // Playwright owns the wrapper's process group. Keeping build and start in
    // it lets Playwright reap every descendant even after a forced shutdown.
    detached: false,
  });
  child = launched;
  launched.on("error", error => {
    if (launched !== child) return;
    console.error(error.message);
    finish(1);
  });
  launched.on("exit", code => {
    if (launched !== child) return;
    child = null;
    if (stopping) return finish(0);
    if (phase === "build" && code === 0) {
      phase = "start";
      launch(browserStartArguments(next, port));
      return;
    }
    finish(code || 1);
  });
}
function stop() {
  if (!stopping) {
    stopping = true;
    signalChild("SIGTERM");
    forceTimer = setTimeout(() => signalChild("SIGKILL"), 5_000);
    forceTimer.unref();
    if (!child) finish(0);
  }
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("exit", () => signalChild("SIGTERM"));
launch(browserBuildArguments(next));
