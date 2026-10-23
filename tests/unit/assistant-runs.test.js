import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readHermesResult, readHermesTurnResult } from "../../lib/hermes-run-protocol.js";
import { assistantRunTimeoutMs, DEFAULT_ASSISTANT_RUN_TIMEOUT_MS } from "../../lib/assistant-timeout.js";

test("assistant runtime timeouts are finite, positive, and capped consistently", () => {
  assert.equal(assistantRunTimeoutMs(undefined), DEFAULT_ASSISTANT_RUN_TIMEOUT_MS);
  assert.equal(assistantRunTimeoutMs("-1"), DEFAULT_ASSISTANT_RUN_TIMEOUT_MS);
  assert.equal(assistantRunTimeoutMs("not-a-number"), DEFAULT_ASSISTANT_RUN_TIMEOUT_MS);
  assert.equal(assistantRunTimeoutMs("1"), 250);
  assert.equal(assistantRunTimeoutMs(String(DEFAULT_ASSISTANT_RUN_TIMEOUT_MS + 1)), DEFAULT_ASSISTANT_RUN_TIMEOUT_MS);
});

test("structured results exclude protocol and never mistake tool events for answers", () => {
  assert.equal(readHermesResult({ type: "tool_result", output: "SECRET" }), null);
  assert.equal(readHermesResult({ type: "text", text: "I will do it" }), null);
  assert.equal(readHermesResult({ type: "result", exit_code: 0, text: "Done. <｜DSML｜function_calls>raw</｜DSML｜function_calls>" }).state, "error");
  assert.match(readHermesResult({ type: "result", exit_code: 0, text: '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="terminal"></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>' }).error, /tool instructions/);
  assert.equal(readHermesResult({ type: "result", exit_code: 1, error: "401 secret-token" }).error.includes("secret-token"), false);
  assert.equal(readHermesResult({ type: "result", exit_code: 0, text: "## Result\n\n" + "x".repeat(10000) }).response.length, 10011);
});

test("early turn receipts preserve complete, failed, and partial exit semantics", () => {
  assert.deepEqual(readHermesTurnResult({ type: "turn_result", exit_code: 0, text: "Finished." }), {
    state: "complete", response: "Finished.", error: "",
  });
  assert.equal(readHermesTurnResult({ type: "turn_result", exit_code: 1, error: "provider failed" }).state, "error");
  assert.equal(readHermesTurnResult({ type: "turn_result", exit_code: 1, text: "partial draft" }).state, "error");
  assert.equal(readHermesTurnResult({ type: "result", exit_code: 0, text: "wrong envelope" }), null);
});

test("provider-reported usage is bounded and retained only on authoritative results", () => {
  assert.deepEqual(readHermesResult({ type: "result", exit_code: 0, text: "Finished.", usage: { inputTokens: 120, outputTokens: 30, costUsd: 0.004 } }), {
    state: "complete", response: "Finished.", error: "", usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150, costUsd: 0.004 },
  });
  assert.deepEqual(readHermesResult({ type: "result", exit_code: 1, error: "provider failed", usage: { inputTokens: 4, outputTokens: 1, costUsd: null } }).usage, {
    inputTokens: 4, outputTokens: 1, totalTokens: 5, costUsd: null,
  });
  for (const usage of [
    { inputTokens: -1, outputTokens: 2, costUsd: 0 },
    { inputTokens: 1.5, outputTokens: 2, costUsd: 0 },
    { inputTokens: 1_000_000_000_001, outputTokens: 2, costUsd: 0 },
    { inputTokens: 1, outputTokens: 2, costUsd: -1 },
    { inputTokens: 1, outputTokens: 2, costUsd: Number.POSITIVE_INFINITY },
  ]) assert.equal(readHermesResult({ type: "result", exit_code: 0, text: "Finished.", usage }).usage, undefined);
});

test("durable run lifecycle resumes exact sessions and completes only from a terminal result", async () => {
  const original = process.cwd();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-run-fixture-"));
  const runner = path.join(original, "scripts/voice/run-hermes-action.mjs");
  try {
    process.chdir(temp);
    const store = await import(`../../lib/assistant-runs.js?fixture=${Date.now()}`);
    const fake = path.join(temp, "fixture-hermes");
    fs.writeFileSync(fake, `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.writeFileSync('received.json', JSON.stringify({args,text:fs.readFileSync(args[args.indexOf('--query-file')+1],'utf8')}));process.stderr.write('HERMES_JEV_EVENT '+JSON.stringify({mode:'fallback',reason:'unchanged_request_retry',evaluated:false,elapsedMs:0,iteration:1})+'\\n'+'HERMES_JEV_EVENT '+JSON.stringify({mode:'forced',reason:'hermes_fills_arguments',tool:'web_search',evaluated:true,elapsedMs:42,confidence:.96,iteration:1})+'\\n');for (const event of [{type:'system',subtype:'init',session_id:'exact-hermes-session'},{type:'text',text:'private draft'},{type:'tool_use',name:'web_search',input:{query:'private input'},tool_call_id:'call1'},{type:'tool_result',name:'web_search',output:'private output',tool_call_id:'call1'},{type:'result',session_id:'exact-hermes-session',exit_code:0,text:'## Answer\\n\\n'+'x'.repeat(9000)}])console.log(JSON.stringify(event));\n`, { mode: 0o700 });
    const execute = async (id) => {
      fs.writeFileSync(store.requestFileForRun(id), JSON.stringify({ sessionId: "dashboard", text: "A".repeat(9000), textOnly: true }));
      await promisify(execFile)(process.execPath, [runner, id], { cwd: temp, env: { ...process.env, HERMES_CLI_PATH: fake }, timeout: 8000 });
    };
    const sessionLock = path.join(temp, "data", "assistant-runs", `session-${crypto.createHash("sha256").update("dashboard").digest("hex")}.json.lock`);
    fs.mkdirSync(path.dirname(sessionLock), { recursive: true });
    fs.writeFileSync(sessionLock, JSON.stringify({ pid: 2_147_483_647 }), { mode: 0o600 });
    const first = store.createAssistantRun({ id: "request-1", sessionId: "dashboard", textOnly: true });
    assert.equal(fs.existsSync(sessionLock), false, "run admission recovers a lock left by a dead owner");
    assert.throws(() => store.createAssistantRun({ sessionId: "dashboard" }), /still working/);
    assert.equal(store.createAssistantRun({ id: "request-1", sessionId: "dashboard" }).id, first.id);
    await execute(first.id);
    const complete = store.getAssistantRun(first.id, "dashboard");
    assert.equal(complete.state, "complete");
    assert.equal(complete.response.length, 9011);
    assert.equal(complete.response.includes("private"), false);
    assert.deepEqual(complete.jev, { observed: true, decisions: 1, lastDecision: { mode: "forced", reason: "hermes_fills_arguments", tool: "web_search", elapsedMs: 42, confidence: .96, iteration: 1 } });
    assert.deepEqual(store.publicAssistantRun(complete).jev, complete.jev);
    assert.equal(store.getConversationSession("dashboard").hermesSessionId, "exact-hermes-session");
    const second = store.createAssistantRun({ id: "request-2", sessionId: "dashboard", textOnly: true });
    await execute(second.id);
    const received = JSON.parse(fs.readFileSync(path.join(temp, "received.json")));
    assert.equal(received.args[received.args.indexOf("--resume") + 1], "exact-hermes-session");
    assert.equal(received.args.includes("--yolo"), false);
    assert.equal(received.text.length, 9000);
    const activity = JSON.parse(fs.readFileSync(path.join(temp, "data/voice-activity.json")));
    assert.ok(activity.events.some(event => event.source === "hermes/tool" && event.sessionId === "dashboard"));
    assert.equal(activity.events.filter(event => event.source === "hermes/jev").length, 2);
    assert.equal(JSON.stringify(activity).includes("private input"), false);
    assert.equal(JSON.stringify(activity).includes("private output"), false);
    const stopped = store.cancelAssistantRun("cancel-before-submit", "dashboard");
    assert.equal(stopped.state, "cancelled");
    assert.equal(store.createAssistantRun({ id: stopped.id, sessionId: "dashboard" }).state, "cancelled");
    store.updateAssistantRun(stopped.id, { state: "complete", response: "late reply" });
    assert.equal(store.getAssistantRun(stopped.id).state, "cancelled");
    assert.equal(store.getAssistantRun(first.id, "wrong-session"), null);
  } finally { process.chdir(original); fs.rmSync(temp, { recursive: true, force: true }); }
});

test("an authoritative result survives a contended final write and is reconciled once", async () => {
  const original = process.cwd();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-final-result-"));
  try {
    process.chdir(temp);
    const store = await import(`../../lib/assistant-runs.js?final=${Date.now()}`);
    const run = store.createAssistantRun({ id: "durable-final", sessionId: "session", text: "Finish durably" });
    store.beginAssistantRun(run.id);
    const lock = path.join(temp, "data", "assistant-runs", `${run.id}.json.lock`);
    const finalFile = path.join(temp, "data", "assistant-runs", `${run.id}.json.final`);
    fs.writeFileSync(lock, "busy", { mode: 0o600 });
    assert.throws(() => store.finalizeAssistantRun(run.id, { state: "complete", response: "Recovered answer", error: "" }), /busy/);
    assert.equal(fs.existsSync(finalFile), true);
    assert.equal(fs.statSync(finalFile).mode & 0o777, 0o600);
    fs.unlinkSync(lock);
    const recovered = store.getAssistantRun(run.id);
    assert.equal(recovered.state, "complete");
    assert.equal(recovered.response, "Recovered answer");
    assert.equal(fs.existsSync(finalFile), false);

    const cancelled = store.createAssistantRun({ id: "cancel-wins", sessionId: "other-session", text: "Stop this" });
    const cancelledFinal = path.join(temp, "data", "assistant-runs", `${cancelled.id}.json.final`);
    fs.writeFileSync(cancelledFinal, JSON.stringify({
      version: 1,
      runCreatedAt: cancelled.createdAt,
      savedAt: new Date().toISOString(),
      result: { state: "complete", response: "Too late", error: "" },
    }), { mode: 0o600 });
    store.cancelAssistantRun(cancelled.id, cancelled.sessionId);
    const afterCancel = store.getAssistantRun(cancelled.id);
    assert.equal(afterCancel.state, "cancelled");
    assert.equal(afterCancel.response, "");
    assert.equal(fs.existsSync(cancelledFinal), false);

    const firstWins = store.createAssistantRun({ id: "first-terminal-wins", sessionId: "third-session", text: "Keep the answer" });
    store.beginAssistantRun(firstWins.id);
    const firstWinsLock = path.join(temp, "data", "assistant-runs", `${firstWins.id}.json.lock`);
    fs.writeFileSync(firstWinsLock, "busy", { mode: 0o600 });
    assert.throws(() => store.finalizeAssistantRun(firstWins.id, { state: "complete", response: "Authoritative answer", error: "" }), /busy/);
    assert.throws(() => store.finalizeAssistantRun(firstWins.id, { state: "error", response: "", error: "Fallback close error" }), /busy/);
    fs.unlinkSync(firstWinsLock);
    const firstRecovered = store.getAssistantRun(firstWins.id);
    assert.equal(firstRecovered.state, "complete");
    assert.equal(firstRecovered.response, "Authoritative answer");
  } finally { process.chdir(original); fs.rmSync(temp, { recursive: true, force: true }); }
});
