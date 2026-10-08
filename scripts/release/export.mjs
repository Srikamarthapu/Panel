#!/usr/bin/env node
// Never clone the private workspace history. Export reviewed source categories.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const root = process.cwd();
const destination = process.argv[2] && path.resolve(process.argv[2]);
if (!destination || destination === root || destination.startsWith(root + path.sep) || fs.existsSync(destination)) {
  throw new Error("Pass a new destination directory outside this checkout; existing destinations are never overwritten.");
}
const roots = ["app", "components", "lib", "runtime/hermes-jev", "tests", "public/voice-vad", "scripts/agents", "scripts/models", "scripts/runtime", "scripts/release", ".github/workflows"];
const files = ["package.json", "package-lock.json", "next.config.mjs", "jsconfig.json", "playwright.config.js", "proxy.js", "README.md", "LICENSE", "NOTICE.md", "CONTRIBUTING.md", "SECURITY.md", "RELEASE-CHECKS.md", ".env.example", "scripts/doctor.mjs", "scripts/build-panel.mjs", "scripts/load-panel-env.mjs", "scripts/start-panel.mjs", "scripts/work-queue-worker.mjs", "scripts/start-mission-control.sh", "docs/agents.md", "docs/workspace-tabs.md", "docs/panel-interface-audit.md", "docs/harness-reliability.md", "docs/model-catalog.md", "docs/jev.md"];
const voiceScripts = ["alias-loader.mjs", "fast-path-harness.mjs", "hermes-acp-worker.mjs", "launch-panel-acp.py", "panel-acp.py", "panel_delegation.py", "panel_profile_identity.py", "panel_profile_tools.py", "run-hermes-acp-action.mjs", "run-hermes-action.mjs", "run-hermes-child.mjs", "soak-15-turns.mjs", "install-hermes-early-turn-result.py", "install-jev-runtime.py", "install-jev-discord-route.py", "route-jev-control.py", "jev-control-route.mjs"];
for (const file of voiceScripts) files.push(`scripts/voice/${file}`);
const blocked = new Set(["node_modules", "__pycache__", ".pytest_cache", ".DS_Store", ".git", "target"]);
const excludedDirectories = new Set(["app/dev/voice-endpointing"]);
const excludedFiles = new Set(["tests/unit/desktop-startup.test.js"]);
const allowedExtensions = new Set([".js", ".jsx", ".mjs", ".css", ".json", ".py", ".md", ".txt", ".yaml", ".yml", ".sh", ".onnx", ".wasm"]);
function checkedSourceStat(relative) {
  const absolute = path.resolve(root, relative);
  if (!absolute.startsWith(root + path.sep)) throw new Error(`Refusing path outside checkout: ${relative}`);
  let current = root;
  const parts = relative.split(path.sep);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const info = fs.lstatSync(current);
    if (info.isSymbolicLink()) throw new Error(`Refusing symlink: ${relative}`);
    if (index < parts.length - 1 && !info.isDirectory()) throw new Error(`Refusing non-directory parent: ${relative}`);
    if (index === parts.length - 1) return info;
  }
  throw new Error(`Refusing empty path: ${relative}`);
}
function collect(relative) {
  if (excludedDirectories.has(relative) || excludedFiles.has(relative)) return;
  const absolute = path.join(root, relative);
  const info = checkedSourceStat(relative);
  if (info.isDirectory()) {
    for (const entry of fs.readdirSync(absolute).sort()) if (!blocked.has(entry) && !entry.startsWith(".env")) collect(path.join(relative, entry));
  } else if (info.isFile() && (allowedExtensions.has(path.extname(relative)) || path.basename(relative).startsWith("LICENSE"))) files.push(relative);
}
for (const directory of roots) collect(directory);
const manifest = [...new Set(files)].sort().map(relative => {
  const info = checkedSourceStat(relative);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Refusing non-file: ${relative}`);
  const data = fs.readFileSync(path.join(root, relative));
  return { path: relative, sha256: crypto.createHash("sha256").update(data).digest("hex"), bytes: data.length };
});
// Only create the destination after the entire manifest has validated.
fs.mkdirSync(destination, { recursive: false });
for (const entry of manifest) {
  const target = path.join(destination, entry.path);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, entry.path), target, fs.constants.COPYFILE_EXCL);
}
fs.writeFileSync(path.join(destination, ".gitignore"), "node_modules/\n.next/\n.next-*/\ndata/\n.env\n.env.*\n!.env.example\nartifacts/\nlogs/\n*.log\ntest-results/\nplaywright-report/\n__pycache__/\n*.pyc\n.pytest_cache/\n.DS_Store\ngraphify-out/\n");
fs.writeFileSync(path.join(destination, "SOURCE-MANIFEST.json"), JSON.stringify({ generatedAt: new Date().toISOString(), files: manifest }, null, 2) + "\n");
console.log(`Exported ${manifest.length} source files. No original Git history, local state, credentials, recordings, or native build artifacts were copied.`);
console.log(destination);
