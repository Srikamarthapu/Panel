import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runner = path.join(projectRoot, "scripts/voice/run-hermes-action.mjs");

async function fixture(t) {
  const previousCwd = process.cwd();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-turn-report-"));
  process.chdir(directory);
  const store = await import(`../../lib/assistant-runs.js?turn-report=${Date.now()}-${Math.random()}`);
  const sessions = await import("../../lib/work-sessions.js");
  sessions.createWorkSession({ id: "fixture-session" });
  const executions = [];
  t.after(async () => {
    // A failed assertion must not leave the synthetic CLI or its runner alive.
    for (const execution of executions) {
      let saved;
      try { saved = store.getAssistantRun(execution.run.id, "fixture-session"); } catch {}
      for (const pid of [saved?.hermesProcessGroupPid ? -saved.hermesProcessGroupPid : 0, saved?.hermesCliPid]) {
        if (!Number.isInteger(pid) || Math.abs(pid) < 2) continue;
        try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
      }
      if (execution.child.exitCode === null && execution.child.signalCode === null) execution.child.kill("SIGKILL");
      await Promise.race([execution.done.catch(() => {}), new Promise(resolve => setTimeout(resolve, 1000))]);
    }
    process.chdir(previousCwd);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, store, sessions, executions };
}

function createFakeCli(directory, body) {
  const file = path.join(directory, "fake-hermes");
  fs.writeFileSync(file, `#!${process.execPath}\nconst fs=require('node:fs');\nfs.writeFileSync('fake-path.txt',process.env.PATH);\nconst report=process.env.HERMES_QUIET_TURN_REPORT_FILE;\nfunction writeTurn(reply, exit_code=0, error=''){const temp=report+'.tmp';fs.writeFileSync(temp,JSON.stringify({pid:process.pid,exit_code,error,reply}),{mode:0o600});fs.renameSync(temp,report);}\n${body}\n`, { mode: 0o700 });
  return file;
}

function startRun(directory, store, id, fakeCli, timeoutMs = "120000", text = "Check the requested item") {
  const run = store.createAssistantRun({ id, sessionId: "fixture-session", textOnly: true });
  const requestFile = store.requestFileForRun(id);
  fs.writeFileSync(requestFile, JSON.stringify({ sessionId: "fixture-session", text, textOnly: true }));
  const child = spawn(process.execPath, [runner, id], {
    cwd: directory,
    env: {
      ...process.env,
      HERMES_CLI_PATH: fakeCli,
      HERMES_HOME: path.join(directory, "hermes-home"),
      HERMES_REPO: path.join(directory, "custom-hermes-repo"),
      HERMES_JEV_CONTROL: "0",
      HERMES_VOICE_RUN_TIMEOUT_MS: timeoutMs,
    },
    stdio: "ignore",
  });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return { run, child, done, requestFile, reportFile: `${requestFile}.turn.json`, queryFile: `${requestFile}.txt` };
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.fail(`Condition did not become true within ${timeoutMs}ms`);
}

test("native turn report completes the spoken turn before linger and preserves the later follow-up", { timeout: 20000 }, async (t) => {
  const { directory, store, sessions, executions } = await fixture(t);
  const releaseFile = path.join(directory, "release-followup");
  const fakeCli = createFakeCli(directory, `
const args=process.argv.slice(2);
const prompt=fs.readFileSync(args[args.indexOf('--query-file')+1],'utf8');
if(prompt.includes('First request')) {
  console.log(JSON.stringify({type:'system',subtype:'init',session_id:'session-from-hermes'}));
  writeTurn('Okay, I found the page.');
  // Keep linger under test control, independent of parallel-suite CPU load.
  const safety=setTimeout(()=>process.exit(70),15000);
  const poll=setInterval(()=>{
    if(!fs.existsSync(${JSON.stringify(releaseFile)})) return;
    clearInterval(poll); clearTimeout(safety);
    writeTurn('I found the page and verified its date.'); process.exit(0);
  },20);
} else {
  console.log(JSON.stringify({type:'system',subtype:'init',session_id:'session-from-second'}));
  console.log(JSON.stringify({type:'result',exit_code:0,text:'Second run response.'}));
}`);
  const execution = startRun(directory, store, "early-turn", fakeCli, "120000", "First request");
  executions.push(execution);

  const completed = await waitFor(() => {
    const current = store.getAssistantRun(execution.run.id, "fixture-session");
    return current?.state === "complete" ? current : null;
  }, 10000);
  assert.equal(completed.response, "Okay, I found the page.");
  assert.equal(fs.existsSync(releaseFile), false, "receipt must complete before the test releases the follow-up");
  assert.equal(execution.child.exitCode, null, "the runner should still own the lingering CLI");
  assert.ok(completed.hermesCliPid > 1, "receipt identifies the actual CLI process");
  assert.doesNotThrow(() => process.kill(completed.hermesCliPid, 0), "the CLI must still be alive when its receipt completes");

  assert.throws(() => startRun(directory, store, "new-turn-during-linger", fakeCli, "120000", "Second request"), /still working/, "a completed receipt must not permit overlapping Hermes execution in the same session");
  fs.writeFileSync(releaseFile, "release");
  const closed = await execution.done;
  assert.equal(closed.code, 0);
  const next = startRun(directory, store, "new-turn-after-linger", fakeCli, "120000", "Second request");
  executions.push(next);
  const nextClosed = await next.done;
  assert.equal(nextClosed.code, 0);
  assert.equal(store.getAssistantRun(next.run.id, "fixture-session").response, "Second run response.");

  assert.equal(store.getConversationSession("fixture-session").hermesSessionId, "session-from-second", "the late first turn must not replace the newer session ID");
  const savedMessages = sessions.getWorkSession("fixture-session").messages;
  assert.equal(savedMessages.filter(message => message.text === "I found the page and verified its date.").length, 1, "late follow-up must survive server transcript reload exactly once");
  assert.equal(savedMessages.find(message => message.id === "early-turn:result").text, "Okay, I found the page.", "follow-up must not rewrite the original receipt");
  assert.ok(fs.readFileSync(path.join(directory, "fake-path.txt"), "utf8").split(path.delimiter).includes(path.join(directory, "custom-hermes-repo", "venv", "bin")));
  const events = JSON.parse(fs.readFileSync(path.join(directory, "data/voice-activity.json"), "utf8")).events;
  assert.ok(events.some((event) => event.id?.startsWith("early-turn:followup:") && event.summary === "I found the page and verified its date."));
  assert.equal(store.getAssistantRun(next.run.id, "fixture-session").state, "complete", "the old CLI close must not alter the newer run");
  assert.equal(store.getAssistantRun(next.run.id, "fixture-session").response, "Second run response.");
  assert.equal(fs.existsSync(execution.queryFile), false);
  assert.equal(fs.existsSync(execution.reportFile), false);
});

test("a failing report after an early success is surfaced as a follow-up without rewriting history", async (t) => {
  const { directory, store } = await fixture(t);
  const fakeCli = createFakeCli(directory, `writeTurn('The lookup finished.');setTimeout(()=>{writeTurn('',1,'provider unavailable');process.exit(1);},2600);`);
  const execution = startRun(directory, store, "early-then-error", fakeCli);

  const closed = await execution.done;
  assert.equal(closed.code, 0);
  const finished = store.getAssistantRun(execution.run.id, "fixture-session");
  assert.equal(finished.state, "complete");
  assert.equal(finished.response, "The lookup finished.");
  const events = JSON.parse(fs.readFileSync(path.join(directory, "data/voice-activity.json"), "utf8")).events;
  assert.ok(events.some((event) => event.id?.startsWith("early-then-error:followup:") && event.state === "error" && /could not complete/i.test(event.summary)));
  assert.equal(JSON.stringify(events).includes("provider unavailable"), false, "raw backend diagnostics stay private");
});

test("an empty native turn report becomes an honest terminal error", async (t) => {
  const { directory, store } = await fixture(t);
  const fakeCli = createFakeCli(directory, `writeTurn('');process.exit(0);`);
  const execution = startRun(directory, store, "empty-turn", fakeCli);

  const closed = await execution.done;
  assert.equal(closed.code, 0);
  const finished = store.getAssistantRun(execution.run.id, "fixture-session");
  assert.equal(finished.state, "error");
  assert.match(finished.error, /no usable answer/i);
  assert.equal(finished.response, "");
  assert.equal(fs.existsSync(execution.queryFile), false);
  assert.equal(fs.existsSync(execution.reportFile), false);
});

test("a stalled CLI is force-stopped after timeout while its completed receipt stays truthful", { timeout: 9000 }, async (t) => {
  const { directory, store } = await fixture(t);
  const pidFile = path.join(directory, "cli.pid");
  const fakeCli = createFakeCli(directory, `fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));writeTurn('The requested lookup finished.');process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`);
  const startedAt = Date.now();
  const execution = startRun(directory, store, "stalled-turn", fakeCli, "350");

  const closed = await execution.done;
  const elapsed = Date.now() - startedAt;
  assert.equal(closed.code, 0);
  assert.ok(elapsed >= 4000 && elapsed < 8000, `watchdog should allow TERM then reap the CLI group (elapsed ${elapsed}ms)`);
  const finished = store.getAssistantRun(execution.run.id, "fixture-session");
  assert.equal(finished.state, "complete");
  assert.equal(finished.response, "The requested lookup finished.");
  const cliPid = Number(fs.readFileSync(pidFile, "utf8"));
  assert.throws(() => process.kill(cliPid, 0), { code: "ESRCH" });
  assert.equal(fs.existsSync(execution.queryFile), false);
  assert.equal(fs.existsSync(execution.reportFile), false);
});
