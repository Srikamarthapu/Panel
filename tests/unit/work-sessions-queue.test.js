import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "panel-work-"));
process.env.PANEL_DATA_DIR = path.join(temporary, "store");
process.env.HERMES_HOME = path.join(temporary, "empty-hermes-home");
const sessions = await import("../../lib/work-sessions.js");
const runs = await import("../../lib/assistant-runs.js");
const queue = await import("../../lib/work-queue.js");
const launcher = await import("../../lib/assistant-launch.js");
const storeHelpers = await import("../../lib/work-store.js");
const runner = path.resolve("scripts/voice/run-hermes-action.mjs");
const execute = promisify(execFile);

test.after(() => { fs.rmSync(temporary, { recursive: true, force: true }); });
function reset() { fs.rmSync(process.env.PANEL_DATA_DIR, { recursive: true, force: true }); }

test("sessions validate folders, persist renamed sessions, and deduplicate full results by run ID", () => {
  reset();
  assert.throws(() => sessions.createWorkSession({ workingDirectory: "relative/folder" }), /absolute/);
  assert.throws(() => sessions.createWorkSession({ workingDirectory: path.join(temporary, "missing") }), /does not exist/);
  const a = sessions.createWorkSession({ name: "Research", workingDirectory: temporary });
  const b = sessions.createWorkSession({ name: "Writing" });
  sessions.updateWorkSession(a.id, { name: "Findings" });
  assert.equal(sessions.getWorkSession(a.id).name, "Findings");
  assert.equal(sessions.getWorkSession(a.id).workingDirectory, fs.realpathSync(temporary));
  const run = runs.createAssistantRun({ id: "saved-turn", sessionId: a.id, text: "Read this project" });
  runs.updateAssistantRun(run.id, { state: "complete", response: "Answer ".repeat(1500) });
  sessions.recordSessionRun(runs.getAssistantRun(run.id));
  sessions.recordSessionRun(runs.getAssistantRun(run.id));
  const transcript = sessions.getWorkSession(a.id).messages;
  assert.equal(transcript.length, 2);
  assert.equal(transcript[1].text.length, 10500);
  assert.deepEqual(sessions.getWorkSession(b.id).messages, []);
  assert.equal(sessions.listWorkSessions().length, 2);
});

test("scheduled tasks wait until due, serialize a session, and retain complete transcripts", async () => {
  reset();
  const session = sessions.createWorkSession({ name: "Tasks" });
  const scheduledAt = Date.now() + 60_000;
  const a = queue.createWorkTask({ sessionId: session.id, prompt: "First", runAt: new Date(scheduledAt).toISOString() });
  const b = queue.createWorkTask({ sessionId: session.id, prompt: "Second", runAt: new Date(scheduledAt + 1).toISOString() });
  let launches = 0;
  const fakeLaunch = async input => {
    const run = runs.createAssistantRun({ ...input });
    launches += 1;
    return runs.updateAssistantRun(run.id, { state: "active", pid: process.pid, executionActive: true });
  };
  await queue.tickWorkQueue({ now: scheduledAt - 1, launch: fakeLaunch });
  assert.equal(launches, 0);
  await queue.tickWorkQueue({ now: scheduledAt + 2, launch: fakeLaunch });
  assert.equal(launches, 1);
  assert.equal(queue.getWorkTask(a.id).state, "running");
  assert.equal(queue.getWorkTask(b.id).state, "queued");
  runs.updateAssistantRun(a.runId, { state: "complete", response: "Done first." });
  // An early answer cannot release the session while its process is still running.
  await queue.tickWorkQueue({ now: scheduledAt + 2, launch: fakeLaunch });
  assert.equal(launches, 1);
  runs.finishAssistantExecution(a.runId);
  await queue.tickWorkQueue({ now: scheduledAt + 2, launch: fakeLaunch });
  assert.equal(launches, 2);
  assert.equal(queue.getWorkTask(a.id).state, "complete");
  assert.equal(queue.getWorkTask(b.id).state, "running");
  assert.equal(sessions.getWorkSession(session.id).messages[1].text, "Done first.");
});

test("restart reconciles known results and marks uncertain work interrupted without replay", async () => {
  reset();
  const session = sessions.createWorkSession();
  const task = queue.createWorkTask({ sessionId: session.id, prompt: "One external action" });
  await queue.tickWorkQueue({ launch: async input => {
    const run = runs.createAssistantRun(input);
    return runs.updateAssistantRun(run.id, { state: "active", pid: 2147483647 });
  } });
  let repeats = 0;
  await queue.tickWorkQueue({ launch: async () => { repeats += 1; } });
  assert.equal(queue.getWorkTask(task.id).state, "interrupted");
  assert.equal(runs.getAssistantRun(task.runId).state, "interrupted");
  assert.equal(repeats, 0);
  await queue.tickWorkQueue({ launch: async () => { repeats += 1; } });
  assert.equal(repeats, 0);
  const lost = queue.createWorkTask({ sessionId: session.id, prompt: "Uncertain dispatch" });
  await queue.tickWorkQueue({ launch: async () => null });
  await queue.tickWorkQueue({ launch: async () => { repeats += 1; } });
  assert.equal(queue.getWorkTask(lost.id).state, "interrupted");
  assert.equal(repeats, 0);
});

test("cancellation prevents queued starts and dispatch claims are idempotent", async () => {
  reset();
  const session = sessions.createWorkSession();
  const task = queue.createWorkTask({ sessionId: session.id, prompt: "Do not start" });
  queue.cancelWorkTask(task.id);
  let starts = 0;
  await queue.tickWorkQueue({ launch: async () => { starts += 1; } });
  assert.equal(starts, 0);
  assert.equal(queue.getWorkTask(task.id).state, "cancelled");
  const run = runs.createAssistantRun({ id: "claimed-once", sessionId: session.id, text: "Once" });
  assert.ok(runs.claimAssistantRun(run.id));
  assert.equal(runs.claimAssistantRun(run.id), null);
  assert.ok(runs.beginAssistantRun(run.id));
  assert.equal(runs.beginAssistantRun(run.id), null);
  runs.updateAssistantRun(run.id, { pid: 2147483647 });
  const cancelled = runs.cancelAssistantRun(run.id, session.id);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(runs.beginAssistantRun(run.id), null);
});

test("worker lease permits one owner and readiness follows its heartbeat", () => {
  reset();
  const first = queue.acquireQueueWorker();
  assert.ok(first);
  assert.equal(queue.acquireQueueWorker(), null);
  assert.equal(queue.queueWorkerStatus().running, true);
  queue.releaseQueueWorker(first);
  assert.equal(queue.queueWorkerStatus().running, false);
  const second = queue.acquireQueueWorker();
  assert.ok(second);
  assert.notEqual(second.owner, first.owner);
  queue.releaseQueueWorker(second);
});

test("real detached runner uses each selected folder and exact Hermes resume without permission bypass", async () => {
  reset();
  const folderA = path.join(temporary, "project-a");
  const folderB = path.join(temporary, "project-b");
  fs.mkdirSync(folderA); fs.mkdirSync(folderB);
  const a = sessions.createWorkSession({ name: "A", workingDirectory: folderA });
  const b = sessions.createWorkSession({ name: "B", workingDirectory: folderB });
  const fake = path.join(temporary, "fake-hermes.cjs");
  fs.writeFileSync(fake, `#!${process.execPath}\nconst fs=require('node:fs');const path=require('node:path');const args=process.argv.slice(2);const file=path.join(process.cwd(),'received.json');let all=[];try{all=JSON.parse(fs.readFileSync(file))}catch{}all.push({args,cwd:process.cwd(),text:fs.readFileSync(args[args.indexOf('--query-file')+1],'utf8')});fs.writeFileSync(file,JSON.stringify(all));console.log(JSON.stringify({type:'result',session_id:'hermes-'+path.basename(process.cwd()),exit_code:0,text:'Done in '+path.basename(process.cwd())}));\n`, { mode: 0o700 });
  const launch = async (session, id) => {
    runs.createAssistantRun({ id, sessionId: session.id, text: "Read the local project", textOnly: true });
    fs.writeFileSync(runs.requestFileForRun(id), JSON.stringify({ sessionId: session.id, text: "Read the local project", textOnly: true, workingDirectory: session.workingDirectory }));
    await execute(process.execPath, [runner, id], { cwd: process.cwd(), env: { ...process.env, HERMES_HOME: path.join(temporary, "empty-hermes-home"), HERMES_CLI_PATH: fake }, timeout: 8000 });
  };
  await launch(a, "a-1"); await launch(b, "b-1"); await launch(a, "a-2");
  const observedA = JSON.parse(fs.readFileSync(path.join(folderA, "received.json")));
  const observedB = JSON.parse(fs.readFileSync(path.join(folderB, "received.json")));
  assert.equal(observedA[1].args[observedA[1].args.indexOf("--resume") + 1], "hermes-project-a");
  assert.equal(observedB[0].args.includes("--resume"), false);
  assert.equal(observedA[0].args.includes("--yolo"), false);
  assert.equal(runs.getConversationSession(b.id).hermesSessionId, "hermes-project-b");
  assert.equal(sessions.getWorkSession(a.id).messages.length, 4);
  assert.equal(sessions.getWorkSession(b.id).messages.length, 2);
  assert.equal(runs.getAssistantRun("a-2").executionActive, false);
  // Native Node imports (including voice config dependencies) are exercised by the launcher.
  assert.equal(typeof launcher.startAssistantRun, "function");
});

async function until(check, label) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const value = check(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test("separate queue worker survives browser absence, reconciles a restart, and cancels an active child", async () => {
  reset();
  const folder = path.join(temporary, "worker-project"); fs.mkdirSync(folder);
  const session = sessions.createWorkSession({ workingDirectory: folder });
  const fake = path.join(temporary, "worker-hermes.cjs");
  fs.writeFileSync(fake, `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);const text=fs.readFileSync(args[args.indexOf('--query-file')+1],'utf8');fs.appendFileSync('starts.jsonl',JSON.stringify({text,pid:process.pid})+'\\n');console.log(JSON.stringify({type:'system',session_id:'worker-hermes'}));setTimeout(()=>console.log(JSON.stringify({type:'result',exit_code:0,text:'Task finished.'})),text==='Cancel me'?10000:1600);\n`, { mode: 0o700 });
  const env = { ...process.env, HERMES_CLI_PATH: fake, PANEL_PARENT_PID: String(process.pid) };
  const workerPath = path.resolve("scripts/work-queue-worker.mjs");
  const startWorker = () => spawn(process.execPath, [workerPath], { cwd: process.cwd(), env, stdio: "ignore" });
  const stopWorker = child => new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.once("exit", resolve); child.kill("SIGTERM"); });
  const task = queue.createWorkTask({ sessionId: session.id, prompt: "Finish once" });
  let worker = startWorker();
  try {
    await until(() => fs.existsSync(path.join(folder, "starts.jsonl")), "first child start");
    assert.equal(queue.queueWorkerStatus().running, true);
    const duplicate = startWorker();
    const duplicateCode = await new Promise(resolve => duplicate.once("exit", resolve));
    assert.equal(duplicateCode, 0);
    await stopWorker(worker);
    assert.equal(queue.queueWorkerStatus().running, false);
    worker = startWorker();
    await until(() => queue.getWorkTask(task.id).state === "complete", "reconciled task completion");
    const lines = () => fs.readFileSync(path.join(folder, "starts.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(lines().filter(line => line.text === "Finish once").length, 1);
    assert.equal(sessions.getWorkSession(session.id).messages.filter(message => message.role === "hermes").length, 1);
    const cancelled = queue.createWorkTask({ sessionId: session.id, prompt: "Cancel me" });
    const childRecord = await until(() => lines().find(line => line.text === "Cancel me"), "cancellable child");
    queue.cancelWorkTask(cancelled.id);
    await until(() => { try { process.kill(childRecord.pid, 0); return false; } catch { return true; } }, "child cancellation");
    assert.equal(queue.getWorkTask(cancelled.id).state, "cancelled");
    assert.equal(runs.getAssistantRun(cancelled.runId).state, "cancelled");
  } finally { await stopWorker(worker); }
});


test("a quick follow-up waits for the previous terminal runner without overlapping execution", async () => {
  reset();
  const session = sessions.createWorkSession();
  const lingering = spawn(process.execPath, ["-e", "setTimeout(() => {}, 320)"], { stdio: "ignore" });
  const closed = new Promise(resolve => lingering.once("exit", resolve));
  const previous = runs.createAssistantRun({ id: "short-linger", sessionId: session.id, text: "First" });
  runs.updateAssistantRun(previous.id, { state: "complete", response: "First answer", pid: lingering.pid, executionActive: true });
  let observedExited = false;
  const { EventEmitter } = await import("node:events");
  const spawnProcess = () => {
    observedExited = lingering.exitCode !== null;
    const child = new EventEmitter(); child.pid = 2147483647; child.unref = () => {};
    queueMicrotask(() => child.emit("spawn")); return child;
  };
  try {
    const result = await launcher.startAssistantRun({ id: "after-linger", sessionId: session.id, text: "Second" }, { spawnProcess });
    assert.equal(result.id, "after-linger");
    assert.equal(observedExited, true, "the next runner may dispatch only after the previous child exits");
  } finally { lingering.kill("SIGTERM"); await closed; }
});


test("unattended queue bounds concurrent tasks across different sessions", async () => {
  reset();
  const firstSession = sessions.createWorkSession();
  const secondSession = sessions.createWorkSession();
  const first = queue.createWorkTask({ sessionId: firstSession.id, prompt: "First session" });
  const second = queue.createWorkTask({ sessionId: secondSession.id, prompt: "Second session" });
  const launched = [];
  const launch = async input => {
    const run = runs.createAssistantRun(input); launched.push(run.id);
    return runs.updateAssistantRun(run.id, { state: "active", pid: process.pid, executionActive: true });
  };
  await queue.tickWorkQueue({ launch });
  assert.deepEqual(launched, [first.runId]);
  assert.equal(queue.getWorkTask(second.id).state, "queued");
  runs.updateAssistantRun(first.runId, { state: "complete", response: "First done", executionActive: false });
  await queue.tickWorkQueue({ launch });
  assert.deepEqual(launched, [first.runId, second.runId]);
});

test("abandoned malformed locks recover, while a live owner's lock is preserved", () => {
  reset();
  const file = path.join(process.env.PANEL_DATA_DIR, "recover.json");
  fs.mkdirSync(process.env.PANEL_DATA_DIR, { recursive: true });
  const lock = `${file}.lock`;
  for (const contents of ["", "not json", "{}"]) {
    fs.writeFileSync(lock, contents);
    const old = new Date(Date.now() - 20_000); fs.utimesSync(lock, old, old);
    const { withFileLock } = storeHelpers;
    assert.equal(withFileLock(file, () => "recovered"), "recovered");
    assert.equal(fs.existsSync(lock), false);
  }
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  const old = new Date(Date.now() - 20_000); fs.utimesSync(lock, old, old);
  assert.throws(() => storeHelpers.withFileLock(file, () => assert.fail("must not enter")), /busy/);
  assert.equal(fs.existsSync(lock), true);
  fs.unlinkSync(lock);
});


test("foreground runner death is visible immediately and ordinary completed receipts remain truthful", () => {
  reset();
  const session = sessions.createWorkSession();
  const interrupted = runs.createAssistantRun({ id: "dead-foreground", sessionId: session.id, text: "Perform an action" });
  runs.updateAssistantRun(interrupted.id, { state: "active", pid: 2147483647, executionActive: true });
  assert.equal(runs.getAssistantRun(interrupted.id).state, "interrupted");
  assert.match(sessions.getWorkSession(session.id).messages[1].text, /not replayed/);
  const completed = runs.createAssistantRun({ id: "dead-after-complete", sessionId: session.id, text: "Another action" });
  runs.updateAssistantRun(completed.id, { state: "complete", response: "Finished", pid: 2147483647, executionActive: true });
  assert.equal(runs.getAssistantRun(completed.id).state, "complete");
  const claimed = runs.createAssistantRun({ id: "claim-no-pid", sessionId: session.id, text: "Claimed" });
  runs.claimAssistantRun(claimed.id);
  assert.equal(runs.getAssistantRun(claimed.id).state, "queued", "an in-progress spawn retains its grace period");
  runs.updateAssistantRun(claimed.id, { launchClaimedAt: new Date(Date.now() - 11_000).toISOString() });
  assert.equal(runs.getAssistantRun(claimed.id).state, "interrupted");
  const stopped = runs.createAssistantRun({ id: "silent-stop", sessionId: session.id, text: "Interrupted before answer" });
  runs.beginAssistantRun(stopped.id);
  runs.finishAssistantExecution(stopped.id);
  assert.equal(runs.getAssistantRun(stopped.id).state, "interrupted", "a clean process exit without a final result must still be visible");
});


test("task submission retries retain one durable task and reject a reused key with changed input", async () => {
  reset();
  const session = sessions.createWorkSession();
  const input = { requestId: "stable-submit-1", sessionId: session.id, prompt: "Perform once" };
  const first = queue.createWorkTask(input);
  await new Promise(resolve => setTimeout(resolve, 15));
  const retry = queue.createWorkTask(input);
  assert.equal(retry.id, first.id);
  assert.equal(retry.runAt, first.runAt, "an immediate retry retains its original scheduled timestamp");
  assert.equal(queue.listWorkTasks().length, 1);
  for (const change of [{ prompt: "Perform something else" }, { runAt: new Date(Date.now() + 60_000).toISOString() }, { sessionId: sessions.createWorkSession().id }]) {
    assert.throws(() => queue.createWorkTask({ ...input, ...change }), error => error.status === 409);
  }
  assert.throws(() => queue.createWorkTask({ ...input, requestId: "../unsafe" }), error => error.status === 400);
  let launches = 0;
  const launch = async payload => {
    launches += 1;
    const run = runs.createAssistantRun(payload);
    return runs.updateAssistantRun(run.id, { state: "complete", response: "Only once" });
  };
  await queue.tickWorkQueue({ launch });
  const reloaded = await import(`../../lib/work-queue.js?retry=${Date.now()}`);
  const afterRestart = reloaded.createWorkTask(input);
  assert.equal(afterRestart.id, first.id);
  assert.equal(afterRestart.state, "complete");
  await reloaded.tickWorkQueue({ launch });
  assert.equal(launches, 1, "retrying a completed submission must not execute another action");
  const schedule = { requestId: "scheduled-submit", sessionId: session.id, prompt: "Later", runAt: new Date(Date.now() + 60_000).toISOString() };
  assert.equal(queue.createWorkTask(schedule).id, queue.createWorkTask(schedule).id);
  assert.equal(queue.listWorkTasks().length, 2);
});
