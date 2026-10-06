import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getJevRouterStatus, saveJevRouterConfig, sanitizeJevRuntime } from "../../lib/jev-router.js";

test("inside-loop settings preserve saved credentials and independent controls", () => {
  const previousHome = process.env.HERMES_HOME;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-jev-test-"));
  process.env.HERMES_HOME = directory;
  try {
    const saved = saveJevRouterConfig({ enabled: true, apiKey: "private-test-key" });
    assert.equal(saved.toolSelection, true);
    assert.equal(saved.directDispatch, true);
    assert.equal(saved.discordEnabled, false);
    assert.equal(saved.modelRouting, false);
    assert.equal(saved.configured, true);
    assert.equal(saved.keySuffix, "-key");
    assert.equal(JSON.stringify(saved).includes("private-test-key"), false);
    const updated = saveJevRouterConfig({ monitorProgress: false, discordEnabled: true, modelRouting: true });
    assert.equal(updated.enabled, true);
    assert.equal(updated.monitorProgress, false);
    assert.equal(updated.manageContext, true);
    assert.equal(updated.discordEnabled, true);
    assert.equal(updated.modelRouting, true);
    const file = path.join(directory, "control-center", "jev.json");
    assert.equal(JSON.parse(fs.readFileSync(file)).apiKey, "private-test-key");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.throws(() => saveJevRouterConfig({ directDispatch: "yes" }), /true or false/);
    assert.throws(() => saveJevRouterConfig({ apiKey: "a key with spaces" }), /without spaces/);
    saveJevRouterConfig({ enabled: false, removeKey: true });
    assert.equal(getJevRouterStatus().enabled, false);
    assert.equal(fs.readFileSync(file, "utf8").includes("private-test-key"), false);
  } finally {
    if (previousHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previousHome;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime status exposes measured decisions without private state", () => {
  const status = sanitizeJevRuntime({ apiKey: "secret", providerTrackingSince: "2026-09-19T01:00:00Z", lastDecision: { mode: "direct", tool: "skill_view", elapsedMs: 152, confidence: .94, state: { private: true }, arguments: "private", skippedFrontier: true }, lastProviderCall: { at: "2026-09-19T01:02:03Z", outcome: "success", requestIdHash: "abcdef012345", body: "private" }, metrics: { direct: 3, decisions: 5, averageDecisionMs: 164, providerAttempts: 6, providerSuccesses: 5, providerFailures: 1, bad: "secret" }, reasons: { uncertain_selection: 2, private_reason: 9 } });
  assert.equal(status.lastDecision.tool, "skill_view");
  assert.equal(status.metrics.direct, 3);
  assert.equal(status.lastDecision.skippedFrontier, true);
  assert.equal(status.providerTrackingSince, "2026-09-19T01:00:00Z");
  assert.deepEqual(status.lastProviderCall, { at: "2026-09-19T01:02:03Z", outcome: "success", requestIdHash: "abcdef012345" });
  assert.equal(status.metrics.providerAttempts, 6);
  assert.equal(status.metrics.providerSuccesses, 5);
  assert.equal(status.reasons.uncertain_selection, 2);
  assert.equal(JSON.stringify(status).includes("private"), false);
  assert.equal(JSON.stringify(status).includes("secret"), false);
  assert.equal(sanitizeJevRuntime({ metrics: { decisions: 4 } }).metrics.providerSuccesses, 0);
  assert.equal(sanitizeJevRuntime({ mode: "shellcode", confidence: NaN, elapsedMs: -1 }).lastDecision.elapsedMs, null);
  assert.deepEqual(
    { mode: sanitizeJevRuntime({ mode: "model", model: "deepseek-v4-pro" }).lastDecision.mode,
      model: sanitizeJevRuntime({ mode: "model", model: "deepseek-v4-pro" }).lastDecision.selectedModel },
    { mode: "model", model: "deepseek-v4-pro" },
  );
});

test("Jev status distinguishes the plugin link from the Discord gateway route hook", () => {
  const previousHome = process.env.HERMES_HOME;
  const previousRepo = process.env.HERMES_REPO;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-jev-route-status-"));
  const repo = path.join(directory, "repo");
  process.env.HERMES_HOME = directory;
  process.env.HERMES_REPO = repo;
  try {
    fs.mkdirSync(path.join(directory, "plugins", "hermes-jev"), { recursive: true });
    fs.writeFileSync(path.join(directory, "plugins", "hermes-jev", "plugin.yaml"), "name: hermes-jev\n");
    let status = getJevRouterStatus();
    assert.equal(status.runtime.installed, true);
    assert.equal(status.runtime.discordModelRouteInstalled, false);

    fs.mkdirSync(path.join(repo, "hermes_cli"), { recursive: true });
    fs.mkdirSync(path.join(repo, "gateway"), { recursive: true });
    fs.writeFileSync(path.join(repo, "hermes_cli", "plugins.py"), '    "pre_model_route",\n');
    fs.writeFileSync(path.join(repo, "gateway", "run_turn_runner.py"), "def _route_discord_turn_model():\nmodel = _route_discord_turn_model(runner, ctx, model, runtime_kwargs)\n");
    status = getJevRouterStatus();
    assert.equal(status.runtime.discordModelRouteInstalled, true);
  } finally {
    if (previousHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previousHome;
    if (previousRepo === undefined) delete process.env.HERMES_REPO;
    else process.env.HERMES_REPO = previousRepo;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
