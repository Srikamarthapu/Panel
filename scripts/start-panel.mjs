#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { loadPanelEnvironment, panelRoot as root } from "./load-panel-env.mjs";
const mode = process.argv[2] === "start" ? "start" : "dev";
loadPanelEnvironment(mode === "dev");
const env = { ...process.env, HERMES_VOICE_TRANSPORT: process.env.HERMES_VOICE_TRANSPORT || "acp", NODE_ENV: mode === "dev" ? "development" : "production", PANEL_APP_ROOT: root, PANEL_PARENT_PID: String(process.pid) };
const next = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), mode, "--hostname", "127.0.0.1", ...process.argv.slice(3)], { cwd: root, env, stdio: "inherit" });
const worker = spawn(process.execPath, [path.join(root, "scripts/work-queue-worker.mjs")], { cwd: root, env, stdio: "inherit" });
let stopping = false;
function stop(signal = "SIGTERM") {
  if (stopping) return; stopping = true;
  next.kill(signal); worker.kill(signal);
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(signal));
next.on("error", error => { console.error(error.message); process.exitCode = 1; stop(); });
worker.on("error", error => console.error(`Panel queue did not start: ${error.message}`));
next.on("exit", code => { process.exitCode = code || 0; stop(); });
