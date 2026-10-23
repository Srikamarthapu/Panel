import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const REVIEWED_MANIFEST = "scripts/release/source-files.json";
const ROOTS = ["app", "components", "lib", "runtime/hermes-jev", "tests", "public/voice-vad", "scripts/agents", "scripts/models", "scripts/runtime", "scripts/release", ".github/workflows"];
const ROOT_FILES = ["package.json", "package-lock.json", "requirements-test.txt", "next.config.mjs", "jsconfig.json", "playwright.config.js", "proxy.js", "README.md", "LICENSE", "NOTICE.md", "CONTRIBUTING.md", "SECURITY.md", "RELEASE-CHECKS.md", ".env.example", "scripts/doctor.mjs", "scripts/build-panel.mjs", "scripts/load-panel-env.mjs", "scripts/start-panel.mjs", "scripts/work-queue-worker.mjs", "scripts/start-mission-control.sh", "scripts/test-python.mjs", "scripts/test-host-functions.py", "scripts/test-browser-environment.mjs", "scripts/test-browser-server.mjs", "docs/agents.md", "docs/workspace-tabs.md", "docs/panel-interface-audit.md", "docs/harness-reliability.md", "docs/model-catalog.md", "docs/jev.md", "docs/release-0.5.3.md"];
const VOICE_SCRIPTS = ["alias-loader.mjs", "fast-path-harness.mjs", "hermes-acp-worker.mjs", "launch-panel-acp.py", "panel-acp.py", "panel_agent_policy.py", "panel_delegation.py", "panel_profile_identity.py", "panel_profile_tools.py", "panel_tool_results.py", "run-direct-action.mjs", "run-hermes-acp-action.mjs", "run-hermes-action.mjs", "run-hermes-child.mjs", "soak-15-turns.mjs", "install-hermes-early-turn-result.py", "install-jev-runtime.py", "install-jev-discord-route.py", "route-jev-control.py", "jev-control-route.mjs"];
const BLOCKED = new Set(["node_modules", "__pycache__", ".pytest_cache", ".DS_Store", ".git", "target"]);
// Local development routes are intentionally absent from the source release.
// voice-live can call configured providers, while voice-endpointing depends on
// unshipped recording fixtures whose provenance is not part of this release.
const EXCLUDED_DIRECTORIES = new Set(["app/dev/voice-live", "app/dev/voice-endpointing"]);
const EXCLUDED_FILES = new Set(["tests/unit/desktop-startup.test.js", REVIEWED_MANIFEST]);
const ALLOWED_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".css", ".json", ".py", ".md", ".txt", ".yaml", ".yml", ".sh", ".onnx", ".wasm"]);

function absolutePath(root, relative) {
  const absolute = path.resolve(root, ...relative.split("/"));
  if (!absolute.startsWith(`${root}${path.sep}`)) throw new Error(`Refusing path outside checkout: ${relative}`);
  return absolute;
}

export function checkedSourceStat(root, relative) {
  let current = root;
  const parts = relative.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const info = fs.lstatSync(current);
    if (info.isSymbolicLink()) throw new Error(`Refusing symlink: ${relative}`);
    if (index < parts.length - 1 && !info.isDirectory()) throw new Error(`Refusing non-directory parent: ${relative}`);
    if (index === parts.length - 1) return info;
  }
  throw new Error(`Refusing empty path: ${relative}`);
}

export function discoverReleaseFiles(root) {
  root = path.resolve(root);
  const files = [...ROOT_FILES, "docs/release-0.6.0-preview.1.md", "docs/release-0.6.0-preview.2.md", "docs/release-0.6.0-preview.3.md", ...VOICE_SCRIPTS.map(file => `scripts/voice/${file}`)];
  function collect(relative) {
    if (EXCLUDED_DIRECTORIES.has(relative) || EXCLUDED_FILES.has(relative)) return;
    const absolute = absolutePath(root, relative);
    const info = checkedSourceStat(root, relative);
    if (info.isDirectory()) {
      for (const entry of fs.readdirSync(absolute).sort()) {
        if (!BLOCKED.has(entry) && !entry.startsWith(".env")) collect(`${relative}/${entry}`);
      }
    } else if (info.isFile() && (ALLOWED_EXTENSIONS.has(path.extname(relative)) || path.basename(relative).startsWith("LICENSE"))) {
      files.push(relative);
    }
  }
  for (const directory of ROOTS) collect(directory);
  return [...new Set(files)].sort();
}

export function buildSourceManifest(root) {
  root = path.resolve(root);
  return {
    version: 1,
    files: discoverReleaseFiles(root).map(relative => {
      const info = checkedSourceStat(root, relative);
      if (!info.isFile()) throw new Error(`Refusing non-file: ${relative}`);
      const data = fs.readFileSync(absolutePath(root, relative));
      return { path: relative, sha256: crypto.createHash("sha256").update(data).digest("hex"), bytes: data.length };
    }),
  };
}

export function readReviewedManifest(root) {
  const value = JSON.parse(fs.readFileSync(absolutePath(path.resolve(root), REVIEWED_MANIFEST), "utf8"));
  if (value?.version !== 1 || !Array.isArray(value.files) || value.files.some(entry => !entry || typeof entry.path !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0)) {
    throw new Error("The reviewed source manifest is invalid.");
  }
  if (new Set(value.files.map(entry => entry.path)).size !== value.files.length) throw new Error("The reviewed source manifest contains duplicate paths.");
  return value;
}

export function compareManifest(expected, actual) {
  const before = new Map(expected.files.map(entry => [entry.path, entry]));
  const after = new Map(actual.files.map(entry => [entry.path, entry]));
  return {
    added: [...after.keys()].filter(file => !before.has(file)),
    removed: [...before.keys()].filter(file => !after.has(file)),
    changed: [...after.keys()].filter(file => before.has(file) && (before.get(file).sha256 !== after.get(file).sha256 || before.get(file).bytes !== after.get(file).bytes)),
  };
}

export function verifyReviewedManifest(root, reviewed = readReviewedManifest(root)) {
  const actual = buildSourceManifest(root);
  const changes = compareManifest(reviewed, actual);
  if (changes.added.length || changes.removed.length || changes.changed.length) {
    const summary = Object.entries(changes).filter(([, files]) => files.length).map(([kind, files]) => `${kind}: ${files.join(", ")}`).join("\n");
    throw new Error(`Source differs from the reviewed release manifest. Prepare and review a new candidate.\n${summary}`);
  }
  return reviewed;
}

export function validateLocalPythonImports(root, manifest) {
  const selected = new Set(manifest.files.map(entry => entry.path));
  for (const relative of selected) {
    if (path.extname(relative) !== ".py") continue;
    const source = fs.readFileSync(absolutePath(path.resolve(root), relative), "utf8");
    for (const match of source.matchAll(/^(?:from\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s+import|import\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*))/gm)) {
      const moduleName = match[1] || match[2];
      const dependency = path.posix.join(path.posix.dirname(relative), `${moduleName.replaceAll(".", "/")}.py`);
      if (fs.existsSync(absolutePath(path.resolve(root), dependency)) && !selected.has(dependency)) throw new Error(`Missing local Python import from source export: ${relative} -> ${dependency}`);
    }
  }
}
