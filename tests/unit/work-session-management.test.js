import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "panel-session-management-"));
process.env.PANEL_DATA_DIR = path.join(temporary, "store");
process.env.HERMES_HOME = path.join(temporary, "empty-hermes-home");
const sessions = await import("../../lib/work-sessions.js");
const runs = await import("../../lib/assistant-runs.js");
const queue = await import("../../lib/work-queue.js");
const { sessionSwitchBlocked } = await import("../../lib/work-session-state.js");
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier.startsWith("@/") ? pathToFileURL(path.resolve(specifier.slice(2))).href : specifier, context);
} });
const detailRoute = await import("../../app/api/sessions/[id]/route.js");
const listRoute = await import("../../app/api/sessions/route.js");
hooks.deregister();
const reset = () => fs.rmSync(process.env.PANEL_DATA_DIR, { recursive: true, force: true });
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
const conflict = error => error.status === 409;
const patch = (id, value) => detailRoute.PATCH(new Request(`http://panel/api/sessions/${id}`, { method: "PATCH", body: JSON.stringify(value) }), { params: Promise.resolve({ id }) });

test("session API persists pin/archive/restore without replacing history or native mapping", async () => {
  reset();
  const a = sessions.createWorkSession({ name: "Research", workingDirectory: temporary });
  const b = sessions.createWorkSession({ name: "Other" });
  runs.saveConversationSession(a.id, "native-research");
  const run = runs.createAssistantRun({ id: "research-turn", sessionId: a.id, text: "Keep the prompt" });
  runs.updateAssistantRun(run.id, { state: "complete", response: "Keep the answer" });
  const before = sessions.getWorkSession(a.id).messages;
  const response = await patch(a.id, { name: " Findings ", pinned: true, archived: true });
  assert.equal(response.status, 200);
  const saved = (await response.json()).session;
  assert.equal(saved.name, "Findings");
  assert.equal(saved.pinned, true);
  assert.ok(saved.archivedAt);
  assert.equal(saved.lastRun.state, "complete");
  assert.equal(saved.activeRun, null);
  const list = (await listRoute.GET().json()).sessions;
  assert.equal(list[0].id, a.id);
  assert.ok(list.some(session => session.id === b.id));
  assert.equal(list[0].messages, undefined);
  assert.deepEqual(sessions.getWorkSession(a.id).messages, before);
  assert.throws(() => runs.createAssistantRun({ sessionId: a.id, text: "Must not run" }), conflict);
  assert.throws(() => queue.createWorkTask({ sessionId: a.id, prompt: "Must not schedule" }), conflict);
  assert.equal((await patch(a.id, { archived: false, pinned: false })).status, 200);
  assert.equal(sessions.getWorkSession(a.id).archivedAt, null);
  assert.equal(runs.getConversationSession(a.id).hermesSessionId, "native-research");
  assert.deepEqual(sessions.getWorkSession(a.id).messages, before);
  assert.ok(runs.createAssistantRun({ sessionId: a.id, text: "Continue" }));
});

test("active and stopping runs block folder/archive changes while rename and pin remain available", async () => {
  reset();
  const session = sessions.createWorkSession();
  const run = runs.createAssistantRun({ id: "busy", sessionId: session.id, text: "Working" });
  assert.equal((await patch(session.id, { workingDirectory: temporary })).status, 409);
  assert.equal((await patch(session.id, { archived: true })).status, 409);
  assert.equal((await patch(session.id, { name: "Still working", pinned: true })).status, 200);
  runs.updateAssistantRun(run.id, { state: "complete", response: "Early result", executionActive: true, pid: process.pid });
  assert.throws(() => sessions.updateWorkSession(session.id, { archived: true }), conflict);
  assert.equal(sessions.listWorkSessions()[0].activeRun.state, "complete");
  runs.finishAssistantExecution(run.id);
  assert.equal((await patch(session.id, { workingDirectory: temporary })).status, 200);
  assert.equal((await patch(session.id, { archived: true })).status, 200);
});

test("archiving cannot leave queued scheduled work poised to resume unexpectedly", () => {
  reset();
  const session = sessions.createWorkSession();
  const task = queue.createWorkTask({ sessionId: session.id, prompt: "Later", runAt: new Date(Date.now() + 60_000).toISOString() });
  assert.throws(() => sessions.updateWorkSession(session.id, { archived: true }), /pending scheduled tasks/);
  assert.throws(() => sessions.updateWorkSession(session.id, { workingDirectory: temporary }), error => error.status === 409 && /pending scheduled tasks/.test(error.message));
  assert.equal(sessions.getWorkSession(session.id).workingDirectory, null);
  assert.equal(sessions.updateWorkSession(session.id, { name: "Renamed queued session", workingDirectory: null }).name, "Renamed queued session");
  queue.cancelWorkTask(task.id);
  assert.equal(sessions.updateWorkSession(session.id, { workingDirectory: temporary }).workingDirectory, fs.realpathSync(temporary));
  assert.ok(sessions.updateWorkSession(session.id, { archived: true }).archivedAt);
  sessions.updateWorkSession(session.id, { archived: false });
  assert.equal(queue.getWorkTask(task.id).state, "cancelled");
});

test("admission uses the locked current folder and rejects same-session collisions", () => {
  reset();
  const a = sessions.createWorkSession();
  const b = sessions.createWorkSession();
  sessions.updateWorkSession(a.id, { workingDirectory: temporary });
  const first = runs.createAssistantRun({ id: "a-turn", sessionId: a.id, text: "A", workingDirectory: null });
  assert.equal(first.workingDirectory, fs.realpathSync(temporary));
  assert.throws(() => runs.createAssistantRun({ id: "a-collision", sessionId: a.id, text: "Must not collide" }), conflict);
  const second = runs.createAssistantRun({ id: "b-turn", sessionId: b.id, text: "B" });
  assert.equal(runs.createAssistantRun({ id: first.id, sessionId: a.id }).id, first.id);
  runs.cancelAssistantRun(first.id, a.id);
  assert.equal(runs.getAssistantRun(second.id, b.id).state, "queued");
  assert.deepEqual(sessions.getWorkSession(b.id).messages.map(entry => entry.text), ["B"]);
});

test("list summaries expose bounded run state without prompts, results or permission payloads", () => {
  reset();
  const session = sessions.createWorkSession();
  const run = runs.createAssistantRun({ id: "summary", sessionId: session.id, text: "PRIVATE PROMPT", textOnly: true, statusLabel: "x".repeat(500) });
  runs.updateAssistantRun(run.id, { state: "active", response: "PRIVATE RESULT", permission: { command: "PRIVATE COMMAND" }, toolProgress: { title: "t".repeat(500), input: "PRIVATE INPUT" } });
  const saved = sessions.listWorkSessions()[0];
  assert.equal(saved.activeRun.id, run.id);
  assert.equal(saved.activeRun.permissionPending, true);
  assert.equal(saved.activeRun.statusLabel.length, 200);
  assert.equal(saved.activeRun.toolLabel.length, 160);
  assert.equal(JSON.stringify(saved).includes("PRIVATE"), false);
  runs.updateAssistantRun(run.id, { state: "error", error: "PRIVATE ERROR" });
  assert.equal(sessions.listWorkSessions()[0].activeRun, null);
  assert.equal(sessions.listWorkSessions()[0].lastRun.state, "error");
  assert.equal(sessions.listWorkSessions()[0].lastRun.permissionPending, false);
  assert.equal(sessions.listWorkSessions()[0].lastRun.toolLabel, null);
});

test("session edits validate booleans, folder paths and missing IDs", async () => {
  reset();
  const session = sessions.createWorkSession();
  assert.equal((await patch(session.id, { pinned: "yes" })).status, 400);
  assert.equal((await patch(session.id, { archived: 1 })).status, 400);
  assert.equal((await patch(session.id, { workingDirectory: "relative" })).status, 400);
  assert.equal((await patch("missing", { name: "No" })).status, 404);
  assert.equal(sessions.getWorkSession(session.id).pinned, false);
});

test("session switching requires server acceptance, not a locally allocated action ID", () => {
  assert.equal(sessionSwitchBlocked({ state: "idle" }), false);
  // callChat allocates the ID and sets CHAT_PENDING before its POST resolves.
  const submitting = { state: "thinking", requestPending: true, actionId: "new-request", acceptedActionId: null };
  assert.equal(sessionSwitchBlocked(submitting), true);
  assert.equal(sessionSwitchBlocked({ ...submitting, acceptedActionId: "older-request" }), true);
  const accepted = { ...submitting, acceptedActionId: "new-request" };
  assert.equal(sessionSwitchBlocked(accepted), false);
  assert.equal(sessionSwitchBlocked({ ...submitting, state: "error" }), true);
  assert.equal(sessionSwitchBlocked({ ...accepted, state: "error" }), false);
  assert.equal(sessionSwitchBlocked({ state: "thinking", requestPending: false }), true);
  assert.equal(sessionSwitchBlocked({ state: "thinking", requestPending: true }), true);
  for (const state of ["starting", "transcribing", "speaking", "capturing", "listening"]) assert.equal(sessionSwitchBlocked({ ...accepted, state }), true);
  for (const flags of [{ continuousRequested: true }, { pttRequested: true }, { permission: "pending" }, { permissionSaving: true }]) assert.equal(sessionSwitchBlocked({ ...accepted, ...flags }), true);
});

function childResult(code, env = {}) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; });
  child.stderr.on("data", data => { stderr += data; });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve(stdout) : reject(new Error(stderr || `Child exited ${code}`)));
  });
  return { child, done };
}

test("independent processes cannot archive and admit a run in the same session", async () => {
  reset();
  const session = sessions.createWorkSession();
  const gate = path.join(temporary, "admission-gate");
  const preamble = `import fs from 'node:fs'; import * as sessions from './lib/work-sessions.js'; import * as runs from './lib/assistant-runs.js'; while(!fs.existsSync(${JSON.stringify(gate)})) await new Promise(r=>setTimeout(r,5)); `;
  const archive = childResult(preamble + `try { sessions.updateWorkSession(${JSON.stringify(session.id)}, {archived:true}); console.log('archived'); } catch(e) { console.log(e.status); }`);
  const launch = childResult(preamble + `try { runs.createAssistantRun({id:'race-run',sessionId:${JSON.stringify(session.id)},text:'race'}); console.log('created'); } catch(e) { console.log(e.status); }`);
  fs.writeFileSync(gate, "go");
  const results = (await Promise.all([archive.done, launch.done])).map(result => result.trim());
  assert.ok(results[0] === "archived" && results[1] === "409" || results[0] === "409" && results[1] === "created", results.join(","));
  const saved = sessions.getWorkSession(session.id);
  const run = runs.getAssistantRun("race-run", session.id);
  assert.equal(!!saved.archivedAt && !!run, false);
});


test("global admission is bounded to four live requests and reopens after one stops", () => {
  reset();
  const all = Array.from({ length: 5 }, (_, index) => sessions.createWorkSession({ name: `Agent ${index + 1}` }));
  const active = all.slice(0, 4).map((session, index) => runs.createAssistantRun({ id: `agent-${index}`, sessionId: session.id, text: "Work" }));
  assert.equal(runs.MAX_CONCURRENT_ASSISTANT_RUNS, 4);
  assert.throws(() => runs.createAssistantRun({ id: "fifth", sessionId: all[4].id, text: "Wait" }), error => error.status === 409 && /up to 4/.test(error.message));
  assert.equal(runs.createAssistantRun({ id: active[0].id, sessionId: all[0].id }).id, active[0].id);
  runs.updateAssistantRun(active[0].id, { state: "complete", response: "Answer ready", executionActive: true, pid: process.pid });
  assert.throws(() => runs.createAssistantRun({ id: "fifth", sessionId: all[4].id, text: "Still wait" }), conflict);
  runs.finishAssistantExecution(active[0].id);
  assert.equal(runs.createAssistantRun({ id: "fifth", sessionId: all[4].id, text: "Now admitted" }).state, "queued");
});

async function until(check, label) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test("two detached fake agents execute together and stopping one preserves the other session", async () => {
  reset();
  const folderA = path.join(temporary, "parallel-a"), folderB = path.join(temporary, "parallel-b");
  fs.mkdirSync(folderA); fs.mkdirSync(folderB);
  const fake = path.join(temporary, "parallel-hermes.cjs");
  fs.writeFileSync(fake, `#!${process.execPath}\nconst fs=require('node:fs');const path=require('node:path');const name=path.basename(process.cwd());fs.writeFileSync('started',name);const timer=setInterval(()=>{if(fs.existsSync('release')){clearInterval(timer);console.log(JSON.stringify({type:'result',session_id:'native-'+name,exit_code:0,text:'Finished '+name}));}},20);\n`, { mode: 0o700 });
  const a = sessions.createWorkSession({ name: "Agent A", workingDirectory: folderA });
  const b = sessions.createWorkSession({ name: "Agent B", workingDirectory: folderB });
  const launch = (session, id) => {
    runs.createAssistantRun({ id, sessionId: session.id, text: `Prompt ${session.name}`, textOnly: true });
    fs.writeFileSync(runs.requestFileForRun(id), JSON.stringify({ sessionId: session.id, text: `Prompt ${session.name}`, textOnly: true, workingDirectory: session.workingDirectory }));
    return spawn(process.execPath, [path.resolve("scripts/voice/run-hermes-action.mjs"), id], { cwd: process.cwd(), env: { ...process.env, HERMES_CLI_PATH: fake }, detached: true, stdio: "ignore" });
  };
  const first = launch(a, "parallel-a"), second = launch(b, "parallel-b");
  try {
    await until(() => fs.existsSync(path.join(folderA, "started")) && fs.existsSync(path.join(folderB, "started")), "both independent agents to execute");
    assert.equal(sessions.listWorkSessions().filter(session => session.activeRun).length, 2);
    assert.equal(runs.getAssistantRun("parallel-a").state, "active");
    assert.equal(runs.getAssistantRun("parallel-b").state, "active");
    runs.cancelAssistantRun("parallel-a", a.id);
    await until(() => !runs.assistantRunIsExecuting(runs.getAssistantRun("parallel-a")), "only A to stop");
    assert.equal(runs.getAssistantRun("parallel-b").state, "active");
    assert.equal(runs.assistantRunIsExecuting(runs.getAssistantRun("parallel-b")), true);
    fs.writeFileSync(path.join(folderB, "release"), "finish");
    await until(() => runs.getAssistantRun("parallel-b").state === "complete" && !runs.assistantRunIsExecuting(runs.getAssistantRun("parallel-b")), "B to finish");
    assert.equal(runs.getConversationSession(b.id).hermesSessionId, "native-parallel-b");
    assert.equal(sessions.getWorkSession(b.id).messages.at(-1).text, "Finished parallel-b");
    assert.equal(sessions.getWorkSession(a.id).messages.some(entry => entry.text === "Finished parallel-b"), false);
  } finally {
    // Cleanup must not depend on getAssistantRun(): its transcript reconciliation
    // takes the same session lock as the detached workers, so a slow filesystem
    // can turn a successful run into a cleanup timeout and mask the real result.
    const processGroups = new Set([first, second].map(child => child.pid).filter(Number.isInteger));
    for (const id of ["parallel-a", "parallel-b"]) {
      try {
        const run = JSON.parse(fs.readFileSync(path.join(process.env.PANEL_DATA_DIR, "assistant-runs", `${id}.json`), "utf8"));
        if (Number.isInteger(run.hermesProcessGroupPid)) processGroups.add(run.hermesProcessGroupPid);
      } catch {}
    }
    for (const pid of processGroups) { try { process.kill(-pid, "SIGKILL"); } catch {} }
  }
});
