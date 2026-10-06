import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { routeControlModel } from "../../scripts/voice/jev-control-route.mjs";

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jev-control-route-"));
  const repo = path.join(directory, "hermes-agent");
  fs.mkdirSync(path.join(directory, "control-center"), { recursive: true });
  fs.mkdirSync(path.join(repo, "venv", "bin"), { recursive: true });
  fs.writeFileSync(path.join(repo, "venv", "bin", "python"), "");
  fs.writeFileSync(path.join(directory, "control-center", "jev.json"), JSON.stringify({ enabled: true, modelRouting: true }));
  const priorHome = process.env.HERMES_HOME;
  const priorRepo = process.env.HERMES_REPO;
  process.env.HERMES_HOME = directory;
  process.env.HERMES_REPO = repo;
  return {
    directory,
    cleanup() {
      if (priorHome === undefined) delete process.env.HERMES_HOME;
      else process.env.HERMES_HOME = priorHome;
      if (priorRepo === undefined) delete process.env.HERMES_REPO;
      else process.env.HERMES_REPO = priorRepo;
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function routeChild(result, { closeCode = 0, onKill } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = function() {
    if (result !== undefined) queueMicrotask(() => {
      child.stdout.emit("data", JSON.stringify(result));
      child.emit("close", closeCode);
    });
  };
  child.kill = signal => { onKill?.(signal); queueMicrotask(() => child.emit("close", 1)); };
  return child;
}

test("Control model routing respects explicit voice choices and fails open on timeout", async () => {
  let spawned = false;
  assert.deepEqual(await routeControlModel({ text: "write", provider: "openai", model: "gpt-5.5" }, {
    spawnProcess() { spawned = true; throw new Error("must not launch"); },
  }), { selected: false });
  assert.equal(spawned, false);

  const setup = fixture();
  try {
    let killed = false;
    const result = await routeControlModel({ text: "analyze this code", turnId: "turn-1" }, {
      spawnProcess: () => routeChild(undefined, { onKill: signal => { killed = signal === "SIGTERM"; } }),
      timeoutMs: 15,
    });
    assert.deepEqual(result, { selected: false });
    assert.equal(killed, true);

    let forceKilled = false;
    const stubborn = routeChild(undefined);
    stubborn.kill = signal => {
      if (signal === "SIGKILL") {
        forceKilled = true;
        queueMicrotask(() => stubborn.emit("close", 1));
      }
      return true;
    };
    await routeControlModel({ text: "analyze this code" }, { spawnProcess: () => stubborn, timeoutMs: 10 });
    await new Promise(resolve => setTimeout(resolve, 800));
    assert.equal(forceKilled, true);
  } finally { setup.cleanup(); }
});

test("Control model route returns the selected configured model and reports decision metadata", async () => {
  const setup = fixture();
  try {
    let inputText = "";
    let callbackDecision;
    const decision = { mode: "model", model: "deepseek-v4-pro", reason: "model_selected", confidence: 0.97, elapsedMs: 240, evaluated: true };
    const result = await routeControlModel({ text: "refactor this code", sessionId: "session-1", turnId: "turn-2", onDecision: value => { callbackDecision = value; } }, {
      spawnProcess(_python, _args, options) {
        const child = routeChild({ selected: true, model: "deepseek-v4-pro", provider: "deepseek", decision });
        const originalEnd = child.stdin.end.bind(child.stdin);
        child.stdin.end = body => {
          inputText = body;
          child.stdin.emit("error", Object.assign(new Error("closed input pipe"), { code: "EPIPE" }));
          originalEnd();
        };
        assert.equal(options.env.HERMES_JEV_CONTROL, "1");
        return child;
      },
    });
    assert.equal(result.selected, true);
    assert.equal(result.model, "deepseek-v4-pro");
    assert.equal(result.provider, "deepseek");
    assert.deepEqual(callbackDecision, decision);
    assert.deepEqual(JSON.parse(inputText), { text: "refactor this code", provider: "", model: "", sessionId: "session-1", turnId: "turn-2" });
  } finally { setup.cleanup(); }
});

test("assistant run metadata retains a Control model choice", async () => {
  const original = process.cwd();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jev-control-run-"));
  try {
    process.chdir(directory);
    const runs = await import(`../../lib/assistant-runs.js?jev-model=${Date.now()}`);
    const run = runs.createAssistantRun({ sessionId: "local-session" });
    runs.recordJevDecision(run.id, { mode: "model", model: "deepseek-v4-pro", reason: "model_selected", confidence: 0.97, elapsedMs: 240, evaluated: true });
    assert.equal(runs.publicAssistantRun(runs.getAssistantRun(run.id)).jev.lastDecision.selectedModel, "deepseek-v4-pro");
  } finally { process.chdir(original); fs.rmSync(directory, { recursive: true, force: true }); }
});
