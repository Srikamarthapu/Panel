import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "panel-execution-stop-"));
process.env.PANEL_DATA_DIR = path.join(temporary, "data");
process.env.HERMES_HOME = path.join(temporary, "empty-hermes-home");
const sessions = await import("../../lib/work-sessions.js");
const runs = await import("../../lib/assistant-runs.js");
const queue = await import("../../lib/work-queue.js");
const runner = path.resolve("scripts/voice/run-hermes-action.mjs");
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

async function until(check, label, timeout = 9000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for ${label}`);
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid < 2) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function kill(pid, group = true) {
  if (!Number.isInteger(pid) || pid < 2) return;
  try { process.kill(group ? -pid : pid, "SIGKILL"); } catch { /* already stopped */ }
}
function fixture(t, name, cliBody) {
  fs.rmSync(process.env.PANEL_DATA_DIR, { recursive: true, force: true });
  const folder = path.join(temporary, name); fs.mkdirSync(folder);
  const session = sessions.createWorkSession({ name, workingDirectory: folder });
  const fake = path.join(folder, "fake-hermes.cjs");
  fs.writeFileSync(fake, `#!${process.execPath}\nconst fs = require('node:fs');
const report = process.env.HERMES_QUIET_TURN_REPORT_FILE;
function writeTurn(reply) { const temp = report + '.tmp'; fs.writeFileSync(temp, JSON.stringify({pid:process.pid,exit_code:0,error:'',reply})); fs.renameSync(temp, report); }
fs.writeFileSync('cli.pid', String(process.pid));
console.log(JSON.stringify({type:'system',session_id:'isolated-${name}'}));
${cliBody}\n`, { mode: 0o700 });
  const executions = [];
  function start(input) {
    const run = runs.createAssistantRun(input);
    fs.writeFileSync(runs.requestFileForRun(run.id), JSON.stringify({ sessionId: session.id, text: input.text, textOnly: true, workingDirectory: folder }));
    const helper = spawn(process.execPath, [runner, run.id], {
      cwd: process.cwd(), detached: true, stdio: "ignore",
      env: { ...process.env, HERMES_CLI_PATH: fake, HERMES_JEV_CONTROL: "0", HERMES_VOICE_RUN_TIMEOUT_MS: "15000" },
    });
    const done = new Promise((resolve, reject) => { helper.once("error", reject); helper.once("exit", (code, signal) => resolve({ code, signal })); });
    const execution = { run, helper, done }; executions.push(execution);
    return execution;
  }
  t.after(async () => {
    for (const execution of executions) {
      let saved;
      try { saved = JSON.parse(fs.readFileSync(path.join(process.env.PANEL_DATA_DIR, "assistant-runs", `${execution.run.id}.json`))); } catch { /* not created */ }
      kill(saved?.hermesProcessGroupPid);
      kill(saved?.hermesCliPid, false);
      kill(execution.helper.pid);
      await execution.done;
    }
    try { kill(Number(fs.readFileSync(path.join(folder, "cli.pid"), "utf8")), false); } catch { /* CLI did not start */ }
  });
  return { session, folder, start };
}

test("stopping after an early receipt preserves the answer, stops execution, and suppresses late followups", { timeout: 20000 }, async t => {
  const f = fixture(t, "early-stop", `
writeTurn('The initial answer is complete.');
process.on('SIGTERM', () => { setTimeout(() => {
  writeTurn('This late followup must not be delivered after Stop.');
  console.log(JSON.stringify({type:'result',exit_code:0,text:'This late followup must not be delivered after Stop.'}));
  process.exit(0);
}, 80); });
setInterval(() => {}, 1000);`);
  const execution = f.start({ id: "early-stop-run", sessionId: f.session.id, text: "Synthetic early receipt", textOnly: true });
  const completed = await until(() => { const run = runs.getAssistantRun(execution.run.id); return run?.state === "complete" ? run : null; }, "early receipt");
  assert.equal(completed.response, "The initial answer is complete.");
  assert.equal(runs.assistantRunIsExecuting(completed), true);
  assert.ok(completed.hermesProcessGroupPid > 1);
  assert.ok(completed.hermesCliPid > 1);
  const stopped = runs.cancelAssistantRun(completed.id, f.session.id);
  assert.equal(stopped.state, "complete", "Stop must not rewrite an already received answer");
  assert.equal(stopped.response, completed.response);
  assert.ok(stopped.executionCancelRequestedAt);
  const settled = await until(() => { const run = runs.getAssistantRun(completed.id); return !runs.assistantRunIsExecuting(run) && run.executionCancelledAt ? run : null; }, "confirmed execution cancellation");
  await execution.done;
  assert.equal(settled.state, "complete");
  assert.equal(alive(completed.hermesCliPid), false);
  assert.equal(sessions.getWorkSession(f.session.id).messages.filter(message => message.role === "hermes").length, 1);
  assert.equal(sessions.getWorkSession(f.session.id).messages.at(-1).text, completed.response);
  const eventsPath = path.join(process.env.PANEL_DATA_DIR, "voice-activity.json");
  const events = fs.existsSync(eventsPath) ? JSON.parse(fs.readFileSync(eventsPath)).events : [];
  assert.equal(events.some(event => event.id?.startsWith(`${completed.id}:followup:`)), false);
});

test("runner death retains child ownership until orphan cleanup and blocks session and queue overlap", { timeout: 20000 }, async t => {
  const f = fixture(t, "orphan-stop", `process.on('SIGTERM', () => {}); fs.writeFileSync('cli-ready', 'ready'); setInterval(() => {}, 1000);`);
  const first = queue.createWorkTask({ sessionId: f.session.id, prompt: "Synthetic process that ignores TERM" });
  const otherSession = sessions.createWorkSession({ name: "Queued elsewhere" });
  const next = queue.createWorkTask({ sessionId: otherSession.id, prompt: "Must wait for orphan cleanup" });
  let execution;
  await queue.tickWorkQueue({ launch: async input => { execution = f.start(input); return execution.run; } });
  const active = await until(() => { const run = runs.getAssistantRun(first.runId); return run?.hermesCliPid && alive(run.hermesCliPid) && fs.existsSync(path.join(f.folder, "cli-ready")) ? run : null; }, "tracked Hermes process");
  assert.ok(active.hermesProcessGroupPid > 1);
  execution.helper.kill("SIGKILL");
  await execution.done;
  const interrupted = runs.getAssistantRun(first.runId);
  assert.equal(interrupted.state, "interrupted");
  assert.equal(interrupted.executionActive, true, "runner death cannot release a surviving CLI");
  assert.equal(runs.assistantRunIsExecuting(interrupted), true);
  assert.throws(() => runs.createAssistantRun({ id: "blocked-overlap", sessionId: f.session.id, text: "Do not overlap" }), error => error.status === 409);
  let starts = 0;
  await queue.tickWorkQueue({ launch: async () => { starts++; } });
  assert.equal(starts, 0, "unattended work remains serialized during orphan cleanup");
  assert.equal(queue.getWorkTask(next.id).state, "queued");
  await until(() => { const run = runs.getAssistantRun(first.runId); return !runs.assistantRunIsExecuting(run) && !alive(active.hermesCliPid); }, "TERM-resistant child escalation");
  const following = runs.createAssistantRun({ id: "after-orphan-cleanup", sessionId: f.session.id, text: "May start after confirmed cleanup" });
  assert.equal(following.id, "after-orphan-cleanup");
});

test("confirmed execution cleanup never signals a later process that reuses a saved PID", { timeout: 5000 }, async t => {
  fs.rmSync(process.env.PANEL_DATA_DIR, { recursive: true, force: true });
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  const done = new Promise(resolve => child.once("exit", resolve));
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  t.after(async () => { kill(child.pid); await done; });
  const session = sessions.createWorkSession({ name: "Previously stopped session" });
  const run = runs.createAssistantRun({ id: "settled-old-run", sessionId: session.id, text: "Old request" });
  const finishedAt = new Date(Date.now() - 60_000).toISOString();
  // A durable record keeps old PIDs after cleanup. Using the live test child's
  // PID models the OS later assigning those numeric IDs to unrelated work.
  runs.updateAssistantRun(run.id, {
    state: "complete", response: "Saved answer", pid: child.pid, hermesProcessGroupPid: child.pid,
    executionActive: false, executionCancelRequestedAt: finishedAt, executionStopRequestedAt: finishedAt,
    executionFinishedAt: finishedAt, executionCancelledAt: finishedAt,
  });
  const read = runs.getAssistantRun(run.id);
  assert.equal(read.executionActive, false, "confirmed cleanup is a durable boundary, not a new ownership claim");
  assert.equal(read.executionCancelledAt, finishedAt);
  assert.equal(alive(child.pid), true, "reading completed history must never signal unrelated work");
});
