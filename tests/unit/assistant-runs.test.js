import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readHermesResult, readHermesTurnResult } from "../../lib/hermes-run-protocol.js";

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
    const first = store.createAssistantRun({ id: "request-1", sessionId: "dashboard", textOnly: true });
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
