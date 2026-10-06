import { execFile } from "node:child_process";
import path from "node:path";
import os from "node:os";

let cached;
let pending;
export function readCapabilities() {
  if (cached && Date.now() - cached.at < 15000) return Promise.resolve(cached.value);
  if (pending) return pending;
  const home = process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");
  const repo = process.env.HERMES_REPO || path.join(home, "hermes-agent");
  pending = new Promise((resolve, reject) => {
    execFile(path.join(repo, "venv/bin/python"), [path.join(process.cwd(), "scripts/runtime/inventory.py")], { timeout: 8000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, HERMES_HOME: home, HERMES_REPO: repo } }, (error, stdout) => {
      if (error) return reject(new Error("The Hermes inventory could not be read. Run npm run doctor to check HERMES_REPO and its Python environment."));
      try { const value = { ...JSON.parse(stdout), generatedAt: new Date().toISOString() }; cached = { at: Date.now(), value }; resolve(value); }
      catch { reject(new Error("The Hermes inventory returned an unreadable response. Run npm run doctor.")); }
    });
  }).finally(() => { pending = null; });
  return pending;
}
