import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { promisify } from "node:util";

const appRoot = process.cwd();
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "panel-direct-launch-"));
const store = path.join(temporary, "data");
process.env.PANEL_DATA_DIR = store;
process.env.PANEL_APP_ROOT = appRoot;
process.env.HERMES_HOME = path.join(temporary, "missing-hermes");
process.env.HERMES_VOICE_TRANSPORT = "legacy";

const { getDirectConfig, saveDirectConfig } = await import("../../lib/direct-config.js");
const { launchAssistantRun, startAssistantRun } = await import("../../lib/assistant-launch.js");
const { createAssistantRun, getAssistantRun, getConversationSession, prepareConversationRuntime, requestFileForRun, saveConversationSession } = await import("../../lib/assistant-runs.js");
const { createWorkAgent } = await import("../../lib/work-agents.js");
const { createWorkSession } = await import("../../lib/work-sessions.js");
const { createWorkTask, getWorkTask, tickWorkQueue } = await import("../../lib/work-queue.js");

function fakeSpawner() {
  const calls = [];
  const spawnProcess = (command, args, options) => {
    const child = new EventEmitter();
    child.pid = process.pid;
    child.unref = () => {};
    calls.push({ command, args, options });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
  return { calls, spawnProcess };
}

test.beforeEach(() => fs.rmSync(store, { recursive: true, force: true }));
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

test("runtime generations separate direct history from cached native Hermes state", () => {
  const first = prepareConversationRuntime("session-a", "hermes");
  saveConversationSession("session-a", "native-old");
  const direct = prepareConversationRuntime("session-a", "direct");
  const hermes = prepareConversationRuntime("session-a", "hermes");
  const retry = prepareConversationRuntime("session-a", "hermes");
  assert.equal(direct.runtimeGeneration, first.runtimeGeneration + 1);
  assert.equal(hermes.runtimeGeneration, direct.runtimeGeneration + 1);
  assert.equal(retry.runtimeGeneration, hermes.runtimeGeneration);
  assert.equal(getConversationSession("session-a").hermesSessionId, undefined);
});

test("launch fails before execution when process ownership cannot be established", async () => {
  createWorkSession({ id: "identity-session", name: "Identity test" });
  const run = createAssistantRun({ id: "identity-run", sessionId: "identity-session", text: "must not execute", executionMode: "direct" });
  let killed = false;
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.pid = process.pid;
    child.kill = () => { killed = true; };
    child.unref = () => {};
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
  await assert.rejects(
    launchAssistantRun(run, { sessionId: run.sessionId, text: run.text }, { spawnProcess, identifyProcess: () => null }),
    /could not verify ownership/,
  );
  const failed = getAssistantRun(run.id);
  assert.equal(killed, true);
  assert.equal(failed.state, "error");
  assert.equal(failed.executionActive, false);
  assert.match(failed.error, /Restart Panel/);
  assert.equal(fs.existsSync(requestFileForRun(run.id)), false);
});

test("an accepted request retry keeps its runtime snapshot and launch file secret-free", async () => {
  createWorkSession({ id: "direct-session", name: "Direct test" });
  saveDirectConfig({ credentialProvider: "openai", apiKey: "launch-secret", provider: "openai", model: "provider-model", executionMode: "direct" });
  const spawner = fakeSpawner();
  const input = { id: "direct-idempotent", sessionId: "direct-session", text: "hello" };
  const first = await startAssistantRun(input, { spawnProcess: spawner.spawnProcess });
  const payloadText = fs.readFileSync(requestFileForRun(first.id), "utf8");
  const before = getConversationSession("direct-session");
  assert.equal(first.executionMode, "direct");
  assert.match(spawner.calls[0].args[0], /run-direct-action\.mjs$/);
  assert.equal(payloadText.includes("launch-secret"), false);
  const payload = JSON.parse(payloadText);
  assert.equal(payload.runtimeGeneration, before.runtimeGeneration);
  assert.deepEqual([first.surface, first.modelOrigin, first.requestedProvider, first.requestedModel], ["chat", "direct", "openai", "provider-model"]);
  assert.deepEqual([payload.surface, payload.provider, payload.model], ["chat", "openai", "provider-model"]);
  assert.match(payload.credentialFingerprint, /^[a-f0-9]{64}$/);

  saveDirectConfig({ executionMode: "hermes" });
  const retry = await startAssistantRun(input, { spawnProcess: spawner.spawnProcess });
  assert.equal(retry.id, first.id);
  assert.equal(spawner.calls.length, 1);
  assert.deepEqual(getConversationSession("direct-session"), before);
});

test("the direct runner rejects credential rotation and removal after admission", async () => {
  for (const scenario of ["rotated", "removed"]) {
    const sessionId = `credential-${scenario}-session`;
    const runId = `credential-${scenario}-run`;
    createWorkSession({ id: sessionId, name: `Credential ${scenario}` });
    saveDirectConfig({ credentialProvider: "openai", apiKey: `${scenario}-accepted-key`, provider: "openai", model: "provider-model", executionMode: "direct" });
    const spawner = fakeSpawner();
    const run = await startAssistantRun({ id: runId, sessionId, text: "must not reach provider" }, { spawnProcess: spawner.spawnProcess });
    if (scenario === "rotated") saveDirectConfig({ credentialProvider: "openai", apiKey: "replacement-key" });
    else {
      saveDirectConfig({ executionMode: "hermes" });
      saveDirectConfig({ credentialProvider: "openai", clearKey: true });
    }
    await promisify(execFile)(process.execPath, ["scripts/voice/run-direct-action.mjs", run.id], { cwd: appRoot, env: { ...process.env, PANEL_DATA_DIR: store, OPENAI_API_KEY: "" }, timeout: 15_000 });
    const finished = getAssistantRun(run.id, run.sessionId);
    assert.equal(finished.state, "error");
    assert.match(finished.error, /credential changed after this request was accepted.*Retry the request/);
    assert.equal(finished.response, "");
    assert.equal(fs.existsSync(path.join(store, "assistant-runs", `${run.id}.stream.jsonl`)), false);
    assert.equal(fs.existsSync(requestFileForRun(run.id)), false);
  }
});

test("the direct runner does not publish malformed config contents", async () => {
  createWorkSession({ id: "malformed-session", name: "Malformed config" });
  saveDirectConfig({ credentialProvider: "openai", apiKey: "initial-key", provider: "openai", model: "provider-model", executionMode: "direct" });
  const spawner = fakeSpawner();
  const run = await startAssistantRun({ id: "malformed-config-run", sessionId: "malformed-session", text: "hello" }, { spawnProcess: spawner.spawnProcess });
  const reflected = "secret-inside-invalid-json";
  fs.writeFileSync(path.join(store, "direct-provider.json"), `{"credentials":{"openai":{"apiKey":"${reflected}"}},`);
  await promisify(execFile)(process.execPath, ["scripts/voice/run-direct-action.mjs", run.id], { cwd: appRoot, env: { ...process.env, PANEL_DATA_DIR: store }, timeout: 15_000 });
  const finished = getAssistantRun(run.id, run.sessionId);
  assert.equal(finished.state, "error");
  assert.match(finished.error, /failed before an answer was confirmed/);
  assert.equal(finished.error.includes(reflected), false);
});

test("restricted teammates fail closed before a legacy scheduled launch is accepted", async () => {
  saveDirectConfig({ executionMode: "hermes" });
  const agent = createWorkAgent({ id: "restricted-scheduled", name: "Restricted teammate" });
  const spawner = fakeSpawner();
  await assert.rejects(
    startAssistantRun({ id: "restricted-task-run", sessionId: agent.sessionId, text: "do work", source: "task" }, { spawnProcess: spawner.spawnProcess }),
    /capability policy requires the persistent Hermes runtime/,
  );
  assert.equal(getAssistantRun("restricted-task-run"), null);
  assert.equal(spawner.calls.length, 0);
  assert.equal(fs.existsSync(requestFileForRun("restricted-task-run")), false);
  assert.equal(getDirectConfig().executionMode, "hermes");

  const task = createWorkTask({ requestId: "restricted-queue-request", sessionId: agent.sessionId, prompt: "scheduled work" });
  const launch = input => startAssistantRun(input, { spawnProcess: spawner.spawnProcess });
  await tickWorkQueue({ now: Date.now(), launch });
  const rejected = getWorkTask(task.id);
  assert.equal(rejected.state, "error");
  assert.match(rejected.error, /capability policy requires the persistent Hermes runtime/);
  assert.equal(getAssistantRun(task.runId), null);
  await tickWorkQueue({ now: Date.now() + 1_000, launch });
  assert.deepEqual(getWorkTask(task.id), rejected);
  assert.equal(spawner.calls.length, 0);
});
