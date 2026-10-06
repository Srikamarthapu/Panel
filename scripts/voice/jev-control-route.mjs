import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const workspace = process.cwd();
const home = () => process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");
const repository = () => process.env.HERMES_REPO || path.join(home(), "hermes-agent");

function savedRoutingEnabled() {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(home(), "control-center", "jev.json"), "utf8"));
    return config.enabled === true && config.modelRouting === true;
  } catch { return false; }
}

function hermesPython(repo) {
  const candidates = process.platform === "win32"
    ? [path.join(repo, "venv", "Scripts", "python.exe")]
    : [path.join(repo, "venv", "bin", "python")];
  return candidates.find(candidate => fs.existsSync(candidate)) || "";
}

function unavailable() { return { selected: false }; }

/**
 * Route a default Talk/Chat turn using configured same-provider fallbacks.
 * Explicit voice provider/model selections remain authoritative. Failures always
 * return selected:false so the caller can start the normal Hermes request.
 */
export async function routeControlModel(input = {}, { spawnProcess = spawn, timeoutMs: timeoutOverride } = {}) {
  if (input.provider || input.model || typeof input.text !== "string" || !input.text.trim() || !savedRoutingEnabled()) {
    return unavailable();
  }
  const repo = repository();
  const python = hermesPython(repo);
  const helper = path.join(workspace, "scripts", "voice", "route-jev-control.py");
  if (!python || !fs.existsSync(helper)) return unavailable();

  let configuredTimeout = 1200;
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(home(), "control-center", "jev.json"), "utf8"));
    if (Number.isFinite(saved.timeoutMs)) configuredTimeout = Math.max(250, Math.min(2000, saved.timeoutMs));
  } catch {}
  const timeoutMs = Number.isFinite(timeoutOverride) ? timeoutOverride : configuredTimeout + 2500;

  return new Promise(resolve => {
    let child;
    let timer;
    let forceKillTimer;
    let settled = false;
    let stdout = "";
    let overflow = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const terminateBoundedly = () => {
      if (!child) return;
      try { child.kill("SIGTERM"); } catch {}
      if (!forceKillTimer) {
        forceKillTimer = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch {}
        }, 750);
      }
    };
    try {
      child = spawnProcess(python, [helper], {
        cwd: workspace,
        env: { ...process.env, HERMES_HOME: home(), HERMES_REPO: repo, HERMES_JEV_CONTROL: "1" },
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      finish(unavailable());
      return;
    }
    timer = setTimeout(() => {
      overflow = true;
      terminateBoundedly();
      finish(unavailable());
    }, timeoutMs);
    child.stdout?.on("data", chunk => {
      if (settled || overflow) return;
      stdout += chunk.toString();
      if (stdout.length > 64 * 1024) {
        overflow = true;
        terminateBoundedly();
        finish(unavailable());
      }
    });
    child.on("error", () => finish(unavailable()));
    child.on("close", code => {
      clearTimeout(forceKillTimer);
      if (settled || overflow || code !== 0) return finish(unavailable());
      try {
        const result = JSON.parse(stdout.trim());
        if (result.selected !== true || typeof result.model !== "string" || typeof result.provider !== "string") {
          return finish(unavailable());
        }
        const decision = result.decision && typeof result.decision === "object" ? result.decision : null;
        try { input.onDecision?.(decision); } catch { /* reporting never changes the selected route */ }
        finish({ selected: true, model: result.model, provider: result.provider, decision });
      } catch { finish(unavailable()); }
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify({
      text: input.text.slice(0, 5000),
      provider: input.provider || "",
      model: input.model || "",
      sessionId: input.sessionId || "",
      turnId: input.turnId || "",
    }));
  });
}
