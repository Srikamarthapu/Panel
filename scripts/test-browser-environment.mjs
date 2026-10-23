import fs from "node:fs";
import path from "node:path";

const SOURCE_DIRECTORIES = ["app", "components", "lib", "public", "runtime", "scripts"];
const ROOT_FILES = ["jsconfig.json", "next.config.mjs", "package.json", "package-lock.json", "proxy.js"];
const EXCLUDED_NAMES = new Set(["node_modules", ".git", "graphify-out", "artifacts", "data", "logs", "test-results", "playwright-report", "__pycache__", ".pytest_cache"]);

function excluded(name) {
  return EXCLUDED_NAMES.has(name) || name === ".DS_Store" || name.startsWith(".env") || name === ".next" || name.startsWith(".next-");
}

function copyTree(source, target) {
  const info = fs.lstatSync(source);
  if (info.isSymbolicLink()) throw new Error(`Refusing source symlink while staging browser tests: ${source}`);
  if (info.isDirectory()) {
    fs.mkdirSync(target, { recursive: true, mode: info.mode & 0o777 });
    for (const name of fs.readdirSync(source).sort()) {
      if (!excluded(name)) copyTree(path.join(source, name), path.join(target, name));
    }
    return;
  }
  if (!info.isFile()) throw new Error(`Refusing non-file browser test source: ${source}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(target, info.mode & 0o777);
}

export function stageBrowserProject(sourceRoot, temporaryRoot) {
  const stage = path.join(temporaryRoot, "source");
  fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
  for (const relative of ROOT_FILES) copyTree(path.join(sourceRoot, relative), path.join(stage, relative));
  for (const relative of SOURCE_DIRECTORIES) copyTree(path.join(sourceRoot, relative), path.join(stage, relative));
  const modules = path.join(sourceRoot, "node_modules");
  if (!fs.statSync(modules).isDirectory()) throw new Error("Run npm ci before browser tests.");
  fs.symlinkSync(modules, path.join(stage, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  return stage;
}

export function browserServerEnvironment(temporaryRoot, parent = process.env) {
  const environment = {
    PATH: parent.PATH || "",
    HOME: path.join(temporaryRoot, "home"),
    TMPDIR: temporaryRoot,
    LANG: parent.LANG || "C.UTF-8",
    LC_ALL: parent.LC_ALL || parent.LANG || "C.UTF-8",
    SYSTEMROOT: parent.SYSTEMROOT || "",
    CI: parent.CI || "",
    NODE_ENV: "production",
    HERMES_NEXT_DIST_DIR: ".next-test",
    HERMES_BUILD_ID: "panel-browser-test",
    HERMES_VOICE_FIXTURE: "1",
    HERMES_HOME: path.join(temporaryRoot, "hermes-home"),
    HERMES_REPO: path.join(temporaryRoot, "hermes-repo"),
    HERMES_CLI: path.join(temporaryRoot, "missing-hermes-cli"),
    PANEL_DATA_DIR: path.join(temporaryRoot, "data"),
  };
  for (const directory of ["home", "hermes-home", "hermes-repo", "data"]) fs.mkdirSync(path.join(temporaryRoot, directory), { recursive: true, mode: 0o700 });
  return environment;
}

export function browserBuildArguments(next) {
  return [next, "build", "--webpack"];
}

export function browserStartArguments(next, port = 3012) {
  return [next, "start", "-H", "127.0.0.1", "-p", String(port)];
}
