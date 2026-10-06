#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { loadPanelEnvironment } from "../load-panel-env.mjs";
loadPanelEnvironment();
const home = process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");
const repo = process.env.HERMES_REPO || path.join(home, "hermes-agent");
const python = path.join(repo, "venv/bin/python");
if (!fs.existsSync(python)) { console.error("Hermes Python environment is missing. Run npm run doctor."); process.exit(1); }
for (const script of ["runtime/hermes-jev/tests/test_loop.py", "runtime/hermes-jev/test_context_engine.py", "runtime/hermes-jev/tests/test_model_router.py"]) {
  const result = spawnSync(python, [script], { stdio: "inherit", env: { ...process.env, PYTHONPATH: [repo, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) } });
  if (result.status !== 0) process.exit(result.status || 1);
}
