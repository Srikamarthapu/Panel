import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { dataDirectory, processAlive, readJson, withFileLock, writeJson } from "./work-store.js";
import { getAssistantRun, getConversationSession } from "./assistant-runs.js";
import { listDelegatedAgents, getDelegatedAgent } from "./delegated-agents.js";

export const acpEnabled = () => process.env.HERMES_VOICE_TRANSPORT === "acp";
export function runtimePaths(payload) {
  const appRoot = path.resolve(process.env.PANEL_APP_ROOT || process.cwd());
  // One worker per conversation prevents model switches from resurrecting an
  // older in-memory copy of the same conversation when switching back.
  const key = crypto.createHash("sha256").update(JSON.stringify([appRoot, dataDirectory(), payload.sessionId])).digest("hex").slice(0, 24);
  const directory = path.join(dataDirectory(), "acp-runtime");
  const socketDirectory = path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", `hermes-control-${process.getuid?.() ?? "user"}`);
  fs.mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(socketDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077)) throw new Error("Control's local runtime directory is not private.");
  return { appRoot, directory, spec: path.join(directory, `${key}.json`), socket: path.join(socketDirectory, `${key}.sock`) };
}

export async function connectRuntime(payload, { timeoutMs = 45_000 } = {}) {
  const paths = runtimePaths(payload);
  fs.mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  const fingerprint = JSON.stringify([6, payload.workingDirectory || "", payload.provider || "", payload.model || "", payload.reasoningEffort || "", payload.agentName || "", crypto.createHash("sha256").update(payload.agentSoul || "").digest("hex")]);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
  let replacing = false;
  withFileLock(paths.spec, () => {
    const previous = readJson(paths.spec);
    if (previous?.pid && processAlive(previous.pid)) {
      if (previous.fingerprint === fingerprint) return;
      const currentId = getConversationSession(payload.sessionId).activeRunId;
      const current = currentId ? getAssistantRun(currentId) : null;
      if (current?.executionActive && current.persistentRuntimePid === previous.pid) throw new Error("Wait for the active request before changing the Hermes runtime model.");
      if (listDelegatedAgents(payload.sessionId).some(agent => ["queued", "running"].includes(agent.status))) throw new Error("Wait for delegated agents to finish, or stop them before changing this runtime.");
      try { process.kill(process.platform === "win32" ? previous.pid : -previous.pid, "SIGTERM"); } catch {}
      replacing = true;
      return;
    }
    try { fs.unlinkSync(paths.socket); } catch {}
    const spec = { ...payload, ...paths, fingerprint, dataDirectory: dataDirectory(), createdAt: new Date().toISOString() };
    writeJson(paths.spec, spec);
    const child = spawn(process.execPath, [path.join(paths.appRoot, "scripts/voice/hermes-acp-worker.mjs"), paths.spec], {
      cwd: paths.appRoot, detached: true, stdio: "ignore", env: { ...process.env, PANEL_DATA_DIR: dataDirectory() },
    });
    child.on("error", () => {});
    child.unref();
    writeJson(paths.spec, { ...spec, pid: child.pid });
  });
    if (replacing) { await new Promise(resolve => setTimeout(resolve, 100)); continue; }
    const connection = await new Promise(resolve => {
      const socket = net.createConnection(paths.socket);
      socket.once("connect", () => resolve(socket));
      socket.once("error", () => { socket.destroy(); resolve(null); });
    });
    if (connection) return connection;
    const owner = readJson(paths.spec);
    if (!owner?.pid || !processAlive(owner.pid)) throw new Error("The persistent Hermes runtime could not start. The request was not executed.");
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error("The persistent Hermes runtime did not become ready. The request was not executed.");
}

export async function warmAssistantRuntime(payload) {
  const socket = await connectRuntime(payload);
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Hermes is still starting. Try again shortly.")); }, 45_000);
    socket.on("error", () => { clearTimeout(timer); reject(new Error("Hermes runtime connection failed.")); });
    socket.on("close", () => { clearTimeout(timer); reject(new Error("Hermes runtime closed before becoming ready.")); });
    socket.on("data", chunk => {
      buffer += chunk;
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      let event; try { event = JSON.parse(buffer.slice(0, index)); } catch { return; }
      clearTimeout(timer); socket.end();
      if (event.type === "ready") resolve({ ready: true, model: event.model, provider: event.provider });
      else reject(new Error(event.error || "Hermes runtime could not become ready."));
    });
    socket.write(JSON.stringify({ type: "warmup" }) + "\n");
  });
}

export async function stopDelegatedAgent({ sessionId, runId, agentId }) {
  const agent = getDelegatedAgent(sessionId, runId, agentId);
  if (!agent?.canStop) throw new Error("This delegated agent is no longer available to stop.");
  const run = getAssistantRun(runId, sessionId);
  const paths = runtimePaths({ sessionId });
  const spec = readJson(paths.spec);
  if (!spec?.pid || !processAlive(spec.pid) || spec.pid !== run?.persistentRuntimePid) throw new Error("The agent's runtime is no longer connected.");
  // Connect to its existing owner only: stop must never create a replacement.
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(paths.socket);
    let buffer = "", settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("The agent did not acknowledge the stop request. Refresh its status before retrying.")), 12_000);
    socket.on("connect", () => socket.write(JSON.stringify({ type: "agent_control", runId, agentId }) + "\n"));
    socket.on("error", () => finish(new Error("The agent's runtime connection failed.")));
    socket.on("close", () => finish(new Error("The agent's runtime closed before acknowledging stop.")));
    socket.on("data", chunk => {
      buffer += chunk;
      if (buffer.length > 50_000) return finish(new Error("Invalid agent control response."));
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      try {
        const result = JSON.parse(buffer.slice(0, index));
        if (result.type === "agent_control" && result.ok) finish(null, { ok: true });
        else finish(new Error(result.error || "The agent could not be stopped."));
      } catch { finish(new Error("Invalid agent control response.")); }
    });
  });
}
