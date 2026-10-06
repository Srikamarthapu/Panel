#!/usr/bin/env node
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { panelRoot } from "./load-panel-env.mjs";

// Next evaluates its config in several processes. One inherited stamp keeps
// the HTML, client bundle, status API and build manifest on the same version.
const env = { ...process.env, HERMES_BUILD_ID: process.env.HERMES_BUILD_ID || `panel-${crypto.randomUUID()}` };
const child = spawn(process.execPath, [path.join(panelRoot, "node_modules/next/dist/bin/next"), "build", ...process.argv.slice(2)], { cwd: panelRoot, env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
