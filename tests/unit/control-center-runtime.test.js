import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeGateway, readBoundedLines, readControlCenterSnapshot } from "../../lib/control-center.js";

test("gateway requires a living PID, but an idle state timestamp is not a heartbeat", () => {
  const now = Date.now();
  const record = { pid: 12, gateway_state: "running", active_agents: 1, updated_at: new Date(now).toISOString(), platforms: { discord: { state: "connected" } } };
  const live = normalizeGateway(record, "12", { now, processAlive: () => true });
  assert.equal(live.running, true);
  assert.equal(live.activeAgents, 1);
  const dead = normalizeGateway(record, "12", { now, processAlive: () => false });
  assert.equal(dead.online, false);
  assert.equal(dead.activeAgents, 0);
  assert.equal(dead.platforms.discord.state, "unknown");
  const old = normalizeGateway(record, "12", { now: now + 100_000, processAlive: () => true });
  assert.equal(old.isStale, false);
  assert.equal(old.running, true);
  assert.equal(old.activeAgents, 1);
});

test("bounded tail discards a partial leading line and respects its byte budget", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-tail-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "events.jsonl");
  await fs.writeFile(file, "very-long-leading-line\nsecond\nthird\n");
  assert.deepEqual(await readBoundedLines(file, 80, 16), ["second", "third"]);
});

test("small snapshot keeps historical timestamps, exposes unavailable counts, and strips private gateway fields", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-runtime-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, "data"));
  const now = Date.now();
  const ts = new Date(now - 10_000).toISOString();
  await fs.writeFile(path.join(dir, "gateway_state.json"), JSON.stringify({ pid: 10, gateway_state: "running", updated_at: ts, argv: "private command", platforms: {} }));
  await fs.writeFile(path.join(dir, "config.yaml"), "model:\n  provider: deepseek\n  default: deepseek-chat\n  api_key: secret\n");
  await fs.writeFile(path.join(dir, "data", "voice-activity.json"), JSON.stringify({ events: [{ id: "a", source: "voice/action", state: "active", title: "Working", updatedAt: ts }] }));
  const result = await readControlCenterSnapshot({ workspaceRoot: dir, hermesHome: dir, now, processAlive: () => true });
  assert.deepEqual(result.model, { provider: "deepseek", model: "deepseek-chat" });
  assert.equal(result.gateway.argv, undefined);
  assert.equal(result.activity[0].updatedAt, ts);
  assert.equal(result.status.state, "working");
  assert.equal(result.tasks.available, false);
  assert.equal(result.tasks.total, null);
});
