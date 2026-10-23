#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const host = process.argv.includes("--host");
if (host) {
  throw new Error("Installed-Hermes tests are disabled for this release: importing a live Hermes checkout can bootstrap dependencies and replace the global desktop app. Run the portable suite until a fully sandboxed Hermes runtime fixture is available.");
}
const python = process.env.PANEL_TEST_PYTHON || "python3";
const discoveredPanelTests = fs.readdirSync(path.join(root, "tests", "unit"))
  .filter(file => file.startsWith("panel-") && file.endsWith(".test.py"))
  .sort()
  .map(file => `tests/unit/${file}`);
const portableTests = discoveredPanelTests;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "panel-python-tests-"));
const emptyHermesRepo = path.join(temporary, "empty-hermes-repo");
const hermesRepo = emptyHermesRepo;

for (const directory of ["home", "hermes-home", "data"]) fs.mkdirSync(path.join(temporary, directory), { recursive: true });
const env = {
  PATH: process.env.PATH || "",
  HOME: path.join(temporary, "home"),
  TMPDIR: temporary,
  LANG: process.env.LANG || "C.UTF-8",
  LC_ALL: process.env.LC_ALL || process.env.LANG || "C.UTF-8",
  SYSTEMROOT: process.env.SYSTEMROOT || "",
  HERMES_REPO: hermesRepo,
  HERMES_HOME: path.join(temporary, "hermes-home"),
  PANEL_DATA_DIR: path.join(temporary, "data"),
  PANEL_APP_ROOT: root,
  HERMES_DISABLE_LAZY_INSTALLS: "1",
  PYTHONDONTWRITEBYTECODE: "1",
};

let total = 0;
let skipped = 0;
function runCommand(command, label) {
  const result = spawnSync(command[0], command.slice(1), { cwd: root, env, encoding: "utf8", timeout: 120_000, maxBuffer: 10_000_000 });
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with exit ${result.status}.`);
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const executed = output.match(/Ran (\d+) tests?/);
  if (!executed) throw new Error(`${label} did not report executing any tests.`);
  total += Number(executed[1]);
  skipped += Number(output.match(/skipped=(\d+)/)?.[1] || 0);
}

try {
  for (const file of portableTests) runCommand([python, "-I", file], file);
  console.log(`Portable Python tests: ${total - skipped} passed, ${skipped} explicitly skipped.`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
