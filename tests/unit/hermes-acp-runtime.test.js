import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const appRoot = process.cwd();
const runNode = promisify(execFile);
const { assistantRuntimeFingerprint } = await import("../../lib/hermes-acp-runtime.js");

test("runtime ownership changes with capability policy and runtime generation", () => {
  const base = { sessionId: "fingerprint", workingDirectory: appRoot, provider: "provider", model: "model" };
  const empty = { version: 1, tools: { mode: "allow", ids: [] }, skills: { mode: "allow", ids: [] } };
  const web = { version: 1, tools: { mode: "allow", ids: ["web_search"] }, skills: { mode: "allow", ids: [] } };
  assert.notEqual(assistantRuntimeFingerprint({ ...base, agentPolicy: empty }), assistantRuntimeFingerprint({ ...base, agentPolicy: web }));
  assert.notEqual(assistantRuntimeFingerprint({ ...base, runtimeGeneration: 1 }), assistantRuntimeFingerprint({ ...base, runtimeGeneration: 2 }));
  assert.equal(JSON.parse(assistantRuntimeFingerprint(base))[0], 18);
});
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "panel-acp-test-"));
  const fake = path.join(directory, "fake-acp");
  fs.writeFileSync(fake, `#!${process.execPath}
const readline=require('node:readline');const fs=require('node:fs');
const out=o=>process.stdout.write(JSON.stringify(o)+'\\n');let permissionTurn;let concurrentPermissionTurn;let duplicatePermissionTurn;const concurrentAnswers=new Set();let nextAgentRequest=700;const agentRequests=new Map();
const requestAgent=params=>{const id=nextAgentRequest++;agentRequests.set(id,params);fs.appendFileSync(process.env.PANEL_DATA_DIR+'/agent-requests',JSON.stringify({id,runId:params.runId})+'\\n');out({jsonrpc:'2.0',id,method:'_panel/agent_update',params});};
readline.createInterface({input:process.stdin}).on('line',line=>{const e=JSON.parse(line);const p=e.params||{};let result={};
 if(e.id!==undefined&&!e.method&&agentRequests.has(e.id)){const params=agentRequests.get(e.id);agentRequests.delete(e.id);fs.appendFileSync(process.env.PANEL_DATA_DIR+'/agent-acks',JSON.stringify({id:e.id,ok:e.result?.ok===true,error:Boolean(e.error)})+'\\n');if(e.error)setTimeout(()=>requestAgent(params),100);return;}
 if(e.id===99&&!e.method&&permissionTurn){const q=permissionTurn;out({jsonrpc:'2.0',method:'panel/turn_result',params:{sessionId:q.params.sessionId,text:'Permission handled.',exit_code:0,error:''}});out({jsonrpc:'2.0',id:q.id,result:{stopReason:'end_turn'}});return;}
 if([100,101,102].includes(e.id)&&!e.method){fs.appendFileSync(process.env.PANEL_DATA_DIR+'/permission-answers',JSON.stringify({id:e.id,outcome:e.result?.outcome?.outcome||'',optionId:e.result?.outcome?.optionId||''})+'\\n');if([100,101].includes(e.id)&&concurrentPermissionTurn){concurrentAnswers.add(e.id);if(concurrentAnswers.size===2){const q=concurrentPermissionTurn;out({jsonrpc:'2.0',method:'panel/turn_result',params:{sessionId:q.params.sessionId,text:'Concurrent permissions handled.',exit_code:0,error:''}});out({jsonrpc:'2.0',id:q.id,result:{stopReason:'end_turn'}});} }return;}
 if([103,104,105].includes(e.id)&&!e.method){fs.appendFileSync(process.env.PANEL_DATA_DIR+'/duplicate-answers',JSON.stringify({id:e.id,outcome:e.result?.outcome?.outcome||'',optionId:e.result?.outcome?.optionId||''})+'\\n');if(e.id===104&&duplicatePermissionTurn){const q=duplicatePermissionTurn;out({jsonrpc:'2.0',method:'panel/turn_result',params:{sessionId:q.params.sessionId,text:'Duplicate rejected.',exit_code:0,error:''}});out({jsonrpc:'2.0',id:q.id,result:{stopReason:'end_turn'}});}return;}
 if(e.method==='initialize')result={protocolVersion:1};
 if(e.method==='session/new'||e.method==='session/load')result={sessionId:p.sessionId||'native-session',models:{currentModelId:process.env.PANEL_ACP_REPORTED_MODEL||process.env.PANEL_ACP_PROVIDER+':'+process.env.PANEL_ACP_MODEL}};
 if(e.method==='_panel/stop_agent'){
  fs.appendFileSync(process.env.PANEL_DATA_DIR+'/stop-requests',JSON.stringify({method:e.method,params:p})+'\\n');
  if(p.runId&&p.agentId){out({jsonrpc:'2.0',method:'panel/agent_update',params:{sessionId:p.sessionId,runId:p.runId,agent:{id:p.agentId,name:'Background helper',task:'Finish its focused task',status:'cancelled',result:'Stopped.'}}});result={ok:true};}
  else result={ok:false,error:'missing child target'};
 }
 if(e.method==='session/prompt'){
  fs.appendFileSync(process.env.PANEL_DATA_DIR+'/executions',p.prompt[0].text+'\\n');
  fs.appendFileSync(process.env.PANEL_DATA_DIR+'/turn-instructions',JSON.stringify({sessionId:p.sessionId,text:p.prompt[0].text,runId:(p._meta||{})['hermes-control/run-id']||null,instructions:(p._meta||{})['hermes-control/turn-instructions']||null,commonInstructions:process.env.PANEL_ACP_INSTRUCTIONS||'',agentSoul:process.env.PANEL_AGENT_SOUL||''})+'\\n');
  if(p.prompt[0].text==='WAIT')return;
  if(p.prompt[0].text==='CRASH')process.exit(3);
  if(p.prompt[0].text==='PERMISSION'){permissionTurn=e;out({jsonrpc:'2.0',id:99,method:'session/request_permission',params:{sessionId:p.sessionId,toolCall:{title:'Write QA fixture'},options:[{optionId:'allow_once',name:'Allow once',kind:'allow_once'},{optionId:'deny',name:'Deny',kind:'reject_once'}]}});return;}
  if(p.prompt[0].text==='CONCURRENT_PERMISSION'){concurrentPermissionTurn=e;const options=[{optionId:'allow_once',name:'Allow once',kind:'allow_once'},{optionId:'deny',name:'Deny',kind:'reject_once'}];out({jsonrpc:'2.0',id:102,method:'session/request_permission',params:{sessionId:'wrong-session',toolCall:{title:'Wrong session'},options}});out({jsonrpc:'2.0',id:100,method:'session/request_permission',params:{sessionId:p.sessionId,toolCall:{title:'Write first fixture'},options}});out({jsonrpc:'2.0',id:101,method:'session/request_permission',params:{sessionId:p.sessionId,toolCall:{title:'Write second fixture'},options}});return;}
  if(p.prompt[0].text==='DUPLICATE_PERMISSION'){duplicatePermissionTurn=e;const options=[{optionId:'allow_once',name:'Allow once',kind:'allow_once'}];out({jsonrpc:'2.0',id:103,method:'session/request_permission',params:{sessionId:p.sessionId,toolCall:{title:'First duplicate'},options}});out({jsonrpc:'2.0',id:103,method:'session/request_permission',params:{sessionId:p.sessionId,toolCall:{title:'Second duplicate'},options}});out({jsonrpc:'2.0',id:104,method:'session/request_permission',params:{sessionId:p.sessionId,toolCall:{title:'Surviving request'},options}});return;}
  if(p.prompt[0].text==='TERMINAL_WITH_PERMISSION'){const options=[{optionId:'allow_once',name:'Allow once',kind:'allow_once'}];out({jsonrpc:'2.0',id:105,method:'session/request_permission',params:{sessionId:p.sessionId,toolCall:{title:'Unresolved terminal request',content:{}},options}});out({jsonrpc:'2.0',method:'panel/turn_result',params:{sessionId:p.sessionId,text:'Finished with cleanup.',exit_code:0,error:''}});out({jsonrpc:'2.0',id:e.id,result:{stopReason:'end_turn'}});return;}
  if(p.prompt[0].text==='NO_RECEIPT'){out({jsonrpc:'2.0',id:e.id,result:{stopReason:'end_turn'}});return;}
  const emit=u=>out({jsonrpc:'2.0',method:'session/update',params:{sessionId:p.sessionId,update:u}});
  emit({sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'SECRET REASONING'}});
  emit({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Working. '}});
  emit({sessionUpdate:'tool_call',toolCallId:'tool-1',kind:'execute',title:'PRIVATE COMMAND',status:p.prompt[0].text==='PENDING_TOOL'?'pending':undefined,rawInput:{command:'SECRET'}});
  if(['PENDING_TOOL','ACTIVE_TOOL'].includes(p.prompt[0].text))return;
  emit({sessionUpdate:'tool_call_update',toolCallId:'tool-1',status:'completed',rawOutput:'PRIVATE RESULT'});
  emit({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Done.'}});
  if(p.prompt[0].text==='PARTIAL_NO_RECEIPT'){out({jsonrpc:'2.0',id:e.id,result:{stopReason:'end_turn'}});return;}
  if(p.prompt[0].text==='DELEGATE_LATE'){
   const runId=(p._meta||{})['hermes-control/run-id'];
   setTimeout(()=>out({jsonrpc:'2.0',method:'_panel/agent_update',params:{sessionId:p.sessionId,runId,agent:{id:'child-for-'+runId,name:'Background helper',task:'Finish its focused task',status:'running',canStop:true}}}),120);
  }
  if(p.prompt[0].text==='DELEGATE_COMPLETE'){
   const runId=(p._meta||{})['hermes-control/run-id'];const agentId='child-for-'+runId;const delegationId='generation-for-'+runId;
   const update=agent=>out({jsonrpc:'2.0',method:'_panel/agent_update',params:{sessionId:p.sessionId,runId,agent:{id:agentId,delegationId,name:'Background helper',task:'Finish its focused task',...agent}}});
   update({status:'queued',canStop:false,updatedAt:'2026-10-13T12:00:01.000Z'});
   setTimeout(()=>update({status:'running',canStop:true,toolCount:1,updatedAt:'2026-10-13T12:00:02.000Z'}),40);
   setTimeout(()=>{const params={sessionId:p.sessionId,runId,agent:{id:agentId,delegationId,name:'Background helper',task:'Finish its focused task',status:'complete',canStop:false,toolCount:2,result:'Verified child result.',updatedAt:'2026-10-13T12:00:03.000Z'}};fs.writeFileSync(process.env.PANEL_DATA_DIR+'/agent-terminal-ready',runId);if(process.env.PANEL_AGENT_TERMINAL_GATE){const release=process.env.PANEL_DATA_DIR+'/agent-terminal-release';const gate=setInterval(()=>{if(!fs.existsSync(release))return;clearInterval(gate);requestAgent(params);},10);}else setTimeout(()=>requestAgent(params),Number(process.env.PANEL_AGENT_TERMINAL_DELAY||0));},100);
  }
  out({jsonrpc:'2.0',method:p.prompt[0].text==='PREFIXED_RESULT'?'_panel/turn_result':'panel/turn_result',params:{sessionId:p.sessionId,text:'Done.',exit_code:0,error:'',usage:{inputTokens:12,outputTokens:3,costUsd:0.001}}});result={stopReason:'end_turn'};
 }
 if(e.id!==undefined)out({jsonrpc:'2.0',id:e.id,result});
});
`, { mode: 0o700 });
  return { directory, env: { ...process.env, PANEL_APP_ROOT: appRoot, PANEL_DATA_DIR: directory, HERMES_ACP_COMMAND: fake, HERMES_VOICE_TRANSPORT: "acp" } };
}
async function cleanup(directory) {
  const files = fs.existsSync(path.join(directory, "acp-runtime")) ? fs.readdirSync(path.join(directory, "acp-runtime")).filter(name => name.endsWith(".json")) : [];
  const specs = files.map(name => JSON.parse(fs.readFileSync(path.join(directory, "acp-runtime", name), "utf8")));
  const runDirectory = path.join(directory, "assistant-runs");
  const readRuns = () => fs.existsSync(runDirectory)
    ? fs.readdirSync(runDirectory).filter(name => name.endsWith(".json")).map(name => JSON.parse(fs.readFileSync(path.join(runDirectory, name), "utf8")))
    : [];
  const owners = new Set();
  for (const run of readRuns()) {
    for (const pid of [run.pid, run.hermesProcessGroupPid, run.persistentRuntimePid]) if (Number.isSafeInteger(pid) && pid > 0) owners.add(pid);
  }
  for (const spec of specs) {
    if (Number.isSafeInteger(spec.pid) && spec.pid > 0) owners.add(spec.pid);
    try { process.kill(-spec.pid, "SIGKILL"); } catch {}
  }
  const deadline = Date.now() + 3000;
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const runExecuting = run => run.executionActive === true && (alive(run.pid) || alive(run.hermesProcessGroupPid || run.persistentRuntimePid));
  const unsettled = () => [...owners].filter(alive);
  while ((unsettled().length || readRuns().some(runExecuting)) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const remaining = unsettled();
  const activeRuns = readRuns().filter(runExecuting).map(run => run.id);
  if (remaining.length || activeRuns.length) throw new Error(`Fixture processes did not settle: pids=${remaining.join(",") || "none"} runs=${activeRuns.join(",") || "none"}`);
  for (const spec of specs) {
    try { fs.unlinkSync(spec.socket); } catch {}
  }
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}
const imports = `const runs=await import(${JSON.stringify(path.join(appRoot,"lib/assistant-runs.js"))});const launch=await import(${JSON.stringify(path.join(appRoot,"lib/assistant-launch.js"))});const runtime=await import(${JSON.stringify(path.join(appRoot,"lib/hermes-acp-runtime.js"))});const streams=await import(${JSON.stringify(path.join(appRoot,"lib/assistant-stream.js"))});const sleep=ms=>new Promise(r=>setTimeout(r,ms));const wait=async fn=>{for(let i=0;i<160;i++){let v=fn();if(v)return v;await sleep(25)}throw Error('wait timed out')};const payload={sessionId:'control-test',workingDirectory:${JSON.stringify(appRoot)},provider:'deepseek',model:'deepseek-v4-flash',textOnly:true};const turn=async(id,text,textOnly=payload.textOnly)=>{const run=runs.createAssistantRun({id,sessionId:payload.sessionId,text,textOnly});await launch.launchAssistantRun(run,{...payload,text,textOnly});return await wait(()=>{const r=runs.getAssistantRun(id);return ['complete','error','cancelled','interrupted'].includes(r.state)&&r})};`;

test("spoken and written turn instructions alternate on one persistent native conversation", async () => {
  const f=fixture();
  try {
    const {stdout}=await runNode(process.execPath,["--input-type=module","-e",imports+`
      payload.agentName='Atlas';payload.agentSoul='Speak plainly and keep answers grounded.';
      const results=[];
      for(const [id,text,textOnly] of [['voice-one','VOICE_ONE',false],['chat-two','CHAT_TWO',true],['voice-three','VOICE_THREE',false]]){
        results.push(await turn(id,text,textOnly));
        await wait(()=>!runs.assistantRunIsExecuting(runs.getAssistantRun(id)));
      }
      console.log(JSON.stringify(results.map(({id,persistentRuntimePid,nativeSessionId,selectedModel,state})=>({id,persistentRuntimePid,nativeSessionId,selectedModel,state}))));
    `],{env:f.env,cwd:appRoot,timeout:10000});
    const results=JSON.parse(stdout.trim());
    assert.deepEqual(results.map(result=>result.state),["complete","complete","complete"]);
    assert.equal(new Set(results.map(result=>result.persistentRuntimePid)).size,1);
    assert.deepEqual(results.map(result=>result.nativeSessionId),["native-session","native-session","native-session"]);
    assert.deepEqual(results.map(result=>result.selectedModel),["deepseek-v4-flash","deepseek-v4-flash","deepseek-v4-flash"]);
    const observed=fs.readFileSync(path.join(f.directory,"turn-instructions"),"utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(observed.map(turn=>turn.text),["VOICE_ONE","CHAT_TWO","VOICE_THREE"]);
    assert.deepEqual(observed.map(turn=>turn.sessionId),["native-session","native-session","native-session"]);
    assert.deepEqual(observed.map(turn=>turn.runId),["voice-one","chat-two","voice-three"]);
    assert.match(observed[0].instructions,/spoken Talk turn/);
    assert.match(observed[0].instructions,/1–3 natural, short sentences/);
    assert.match(observed[1].instructions,/written Talk or Chat turn/);
    assert.match(observed[1].instructions,/Do not impose a speech-length limit/);
    assert.equal(observed[0].instructions,observed[2].instructions);
    assert.notEqual(observed[0].instructions,observed[1].instructions);
    assert.ok(observed.every(turn=>turn.commonInstructions===observed[0].commonInstructions));
    assert.match(observed[0].commonInstructions,/You are "Atlas", the user's selected assistant/);
    assert.ok(observed.every(turn=>turn.agentSoul==='Speak plainly and keep answers grounded.'));
    assert.equal(observed[0].commonInstructions.includes('Speak plainly and keep answers grounded.'),false);
    assert.match(observed[0].commonInstructions,/Follow the scope/);
    assert.match(observed[0].commonInstructions,/Never claim success/);
    assert.match(observed[0].commonInstructions,/discover and describe it before calling it or declaring it unavailable/);
    assert.match(observed[0].commonInstructions,/verify the rendered result at relevant viewport sizes/);
    assert.match(observed[0].commonInstructions,/actual artwork bounds and colors/);
    assert.equal(fs.readFileSync(path.join(f.directory,"executions"),"utf8"),"VOICE_ONE\nCHAT_TWO\nVOICE_THREE\n");
  } finally { await cleanup(f.directory); }
});

test("late child updates survive parent completion and stop targets only that child on its existing runtime", async () => {
  const f = fixture();
  try {
    const { stdout } = await runNode(process.execPath, ["--input-type=module", "-e", imports + `
      const delegated=await import(${JSON.stringify(path.join(appRoot,"lib/delegated-agents.js"))});
      const result=await turn('parent-late','DELEGATE_LATE');
      await wait(()=>!runs.assistantRunIsExecuting(runs.getAssistantRun(result.id)));
      const childId='child-for-parent-late';
      const child=await wait(()=>{const item=delegated.getDelegatedAgent(payload.sessionId,'parent-late',childId);return item?.status==='running'&&item});
      const specPath=runtime.runtimePaths(payload).spec;
      const before=JSON.parse((await import('node:fs')).readFileSync(specPath,'utf8'));
      let blocked='';try{await runtime.warmAssistantRuntime({...payload,model:'replacement-while-child-runs'});}catch(error){blocked=error.message;}
      const whileActive=JSON.parse((await import('node:fs')).readFileSync(specPath,'utf8'));
      const stopped=await runtime.stopDelegatedAgent({sessionId:payload.sessionId,runId:'parent-late',agentId:childId});
      const terminal=await wait(()=>{const item=delegated.getDelegatedAgent(payload.sessionId,'parent-late',childId);return item?.status==='cancelled'&&item});
      const afterStop=JSON.parse((await import('node:fs')).readFileSync(specPath,'utf8'));
      const parent=runs.getAssistantRun('parent-late');
      const stopRequest=JSON.parse((await import('node:fs')).readFileSync(process.env.PANEL_DATA_DIR+'/stop-requests','utf8').trim());
      const executions=(await import('node:fs')).readFileSync(process.env.PANEL_DATA_DIR+'/executions','utf8');
      const replacement=await runtime.warmAssistantRuntime({...payload,model:'replacement-after-child-stops'});
      const finalSpec=JSON.parse((await import('node:fs')).readFileSync(specPath,'utf8'));
      console.log(JSON.stringify({child,blocked,beforePid:before.pid,whileActivePid:whileActive.pid,stopped,terminal,parentState:parent.state,parentPid:parent.persistentRuntimePid,afterStopPid:afterStop.pid,stopRequest,executions,replacement,finalPid:finalSpec.pid}));
    `], { env: f.env, cwd: appRoot, timeout: 15000 });
    const result = JSON.parse(stdout.trim());
    assert.equal(result.child.status, "running");
    assert.match(result.blocked, /delegated agents to finish/i);
    assert.equal(result.whileActivePid, result.beforePid);
    assert.deepEqual(result.stopped, { ok: true });
    assert.equal(result.terminal.status, "cancelled");
    assert.equal(result.parentState, "complete");
    assert.equal(result.parentPid, result.beforePid);
    assert.equal(result.afterStopPid, result.beforePid);
    assert.deepEqual(result.stopRequest, {
      method: "_panel/stop_agent",
      params: {
        sessionId: "native-session",
        runId: "parent-late",
        agentId: "child-for-parent-late",
      },
    });
    assert.equal(result.executions, "DELEGATE_LATE\n");
    assert.equal(result.replacement.model, "replacement-after-child-stops");
    assert.notEqual(result.finalPid, result.beforePid);
  } finally { await cleanup(f.directory); }
});

test("prefixed ACP extension notifications retain a child lifecycle on its originating parent run", async () => {
  const f = fixture();
  try {
    const { stdout } = await runNode(process.execPath, ["--input-type=module", "-e", imports + `
      const delegated=await import(${JSON.stringify(path.join(appRoot,"lib/delegated-agents.js"))});
      const fs=await import('node:fs');
      const parent=await turn('parent-framed','DELEGATE_COMPLETE');
      const child=await wait(()=>{const item=delegated.getDelegatedAgent(payload.sessionId,'parent-framed','child-for-parent-framed','generation-for-parent-framed');return item?.status==='complete'&&item});
      await wait(()=>fs.existsSync(process.env.PANEL_DATA_DIR+'/agent-acks')&&fs.readFileSync(process.env.PANEL_DATA_DIR+'/agent-acks','utf8').trim());
      console.log(JSON.stringify({parentState:parent.state,child,all:delegated.listDelegatedAgents(payload.sessionId)}));
    `], { env: f.env, cwd: appRoot, timeout: 10000 });
    const result = JSON.parse(stdout.trim());
    assert.equal(result.parentState, "complete");
    assert.equal(result.child.runId, "parent-framed");
    assert.equal(result.child.sessionId, "control-test");
    assert.equal(result.child.delegationId, "generation-for-parent-framed");
    assert.equal(result.child.status, "complete");
    assert.equal(result.child.toolCount, 2);
    assert.equal(result.child.result, "Verified child result.");
    assert.equal(result.all.filter(agent => agent.runId === "parent-framed").length, 1);
    const acknowledgements = fs.readFileSync(path.join(f.directory, "agent-acks"), "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(acknowledgements, [{ id: 700, ok: true, error: false }]);
  } finally { await cleanup(f.directory); }
});

test("terminal ACP request retries after delegated state lock contention and acknowledges only durable storage", async () => {
  const f = fixture();
  const store = await import("../../lib/work-store.js");
  try {
    const execution = runNode(process.execPath, ["--input-type=module", "-e", imports + `
      const delegated=await import(${JSON.stringify(path.join(appRoot,"lib/delegated-agents.js"))});
      await turn('parent-contended','DELEGATE_COMPLETE');
      const child=await wait(()=>{const item=delegated.getDelegatedAgent(payload.sessionId,'parent-contended','child-for-parent-contended','generation-for-parent-contended');return item?.status==='complete'&&item});
      console.log(JSON.stringify({child}));
    `], { env: { ...f.env, PANEL_AGENT_TERMINAL_GATE: "1" }, cwd: appRoot, timeout: 10000 });

    const ready = path.join(f.directory, "agent-terminal-ready");
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(fs.existsSync(ready), true);
    const delegatedDirectory = path.join(f.directory, "delegated-agents");
    fs.mkdirSync(delegatedDirectory, { recursive: true });
    const lock = path.join(delegatedDirectory, "parent-contended.json.lock");
    const ownerIdentity = store.processIdentity(process.pid);
    assert.match(ownerIdentity, /^(?:darwin|linux|win32):/);
    const lockDeadline = Date.now() + 5000;
    let lockDescriptor;
    let lockCollisions = 0;
    while (lockDescriptor === undefined && Date.now() < lockDeadline) {
      try { lockDescriptor = fs.openSync(lock, "wx", 0o600); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        lockCollisions += 1;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    assert.notEqual(lockDescriptor, undefined, `could not acquire synthetic contention lock after ${lockCollisions} live-lock collisions`);
    fs.writeFileSync(lockDescriptor, JSON.stringify({ pid: process.pid, pidIdentity: ownerIdentity }));
    fs.closeSync(lockDescriptor);
    fs.writeFileSync(path.join(f.directory, "agent-terminal-release"), "go", { mode: 0o600 });
    const requestFile = path.join(f.directory, "agent-requests");
    const requestDeadline = Date.now() + 5000;
    while ((!fs.existsSync(requestFile) || !fs.readFileSync(requestFile, "utf8").includes("parent-contended")) && Date.now() < requestDeadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(fs.existsSync(requestFile) && fs.readFileSync(requestFile, "utf8").includes("parent-contended"), true);
    const acknowledgementFile = path.join(f.directory, "agent-acks");
    const contentionDeadline = Date.now() + 8000;
    let acknowledgements = [];
    while (Date.now() < contentionDeadline) {
      acknowledgements = fs.existsSync(acknowledgementFile)
        ? fs.readFileSync(acknowledgementFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
        : [];
      if (acknowledgements.length) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(acknowledgements[0]?.error, true);
    fs.unlinkSync(lock);
    const { stdout } = await execution;
    try { fs.unlinkSync(lock); } catch {}

    assert.equal(JSON.parse(stdout.trim()).child.status, "complete");
    const acknowledgementDeadline = Date.now() + 3000;
    while (Date.now() < acknowledgementDeadline) {
      acknowledgements = fs.readFileSync(acknowledgementFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
      if (acknowledgements.at(-1)?.ok === true) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(acknowledgements[0].error, true);
    assert.equal(acknowledgements.at(-1).ok, true);
  } finally { await cleanup(f.directory); }
});

test("ACP warmup and repeated turns retain exact model, replay only public speech, and reuse one native worker", async () => {
  const f=fixture();
  try {
    const { stdout } = await runNode(process.execPath,["--input-type=module","-e", imports+`
      const ready=await runtime.warmAssistantRuntime(payload);
      const first=await turn('first','HELLO');await wait(()=>!runs.assistantRunIsExecuting(runs.getAssistantRun('first')));
      const second=await turn('second','AGAIN');
      await wait(()=>!runs.assistantRunIsExecuting(runs.getAssistantRun('second')));
      console.log(JSON.stringify({ready,first,second,chunks:streams.readAssistantText('first'),replay:streams.readAssistantText('first',1)}));
    `],{env:f.env,cwd:appRoot,timeout:10000});
    const result=JSON.parse(stdout.trim());
    assert.equal(result.ready.model,"deepseek-v4-flash");
    assert.equal(result.first.state,"complete");
    assert.equal(result.second.state,"complete");
    assert.deepEqual(result.first.usage,{inputTokens:12,outputTokens:3,totalTokens:15,costUsd:0.001});
    assert.deepEqual(result.second.usage,result.first.usage);
    assert.equal(result.first.persistentRuntimePid,result.second.persistentRuntimePid);
    assert.equal(result.first.response,"Done.");
    assert.equal(result.chunks.map(x=>x.text).join(""),"Working. Done.");
    assert.notEqual(result.chunks[0].messageId,result.chunks[1].messageId);
    assert.equal(result.replay.length,1);
    assert.equal(fs.readFileSync(path.join(f.directory,"executions"),"utf8"),"HELLO\nAGAIN\n");
    const feed=fs.readFileSync(path.join(f.directory,"voice-activity.json"),"utf8");
    assert.doesNotMatch(feed,/SECRET|PRIVATE/);
  } finally { await cleanup(f.directory); }
});

test("an unqualified native model receipt does not inherit the requested provider", async () => {
  const f = fixture();
  try {
    const { stdout } = await runNode(process.execPath, ["--input-type=module", "-e", imports + `
      const ready=await runtime.warmAssistantRuntime(payload);
      const result=await turn('unqualified-model','HELLO');
      console.log(JSON.stringify({ready,model:result.selectedModel,provider:result.selectedProvider,provenance:result.selectedModelProvenance}));
    `], { env: { ...f.env, PANEL_ACP_REPORTED_MODEL: "native-model-id" }, cwd: appRoot, timeout: 10000 });
    assert.deepEqual(JSON.parse(stdout.trim()), {
      ready: { ready: true, model: "native-model-id", provider: "" },
      model: "native-model-id",
      provider: "",
      provenance: "runtime",
    });
  } finally { await cleanup(f.directory); }
});

test("cancellation reaps the owning conversation runtime and never executes a duplicate run", async () => {
  const f=fixture();
  try {
    const {stdout}=await runNode(process.execPath,["--input-type=module","-e",imports+`
      const run=runs.createAssistantRun({id:'cancel-me',sessionId:payload.sessionId,text:'WAIT',textOnly:true});
      await launch.launchAssistantRun(run,{...payload,text:'WAIT'});
      await wait(()=>runs.getAssistantRun(run.id).persistentRuntimePid);
      runs.cancelAssistantRun(run.id,payload.sessionId);
      await wait(()=>!runs.assistantRunIsExecuting(runs.getAssistantRun(run.id)));
      await launch.launchAssistantRun(run,{...payload,text:'SHOULD NOT EXECUTE'});
      console.log(JSON.stringify(runs.getAssistantRun(run.id)));
    `],{env:f.env,cwd:appRoot,timeout:10000});
    assert.equal(JSON.parse(stdout.trim()).state,"cancelled");
    const executions=fs.existsSync(path.join(f.directory,"executions"))?fs.readFileSync(path.join(f.directory,"executions"),"utf8"):"";
    assert.doesNotMatch(executions,/SHOULD/);
  } finally { await cleanup(f.directory); }
});

test("a dead ACP process cannot turn partial progress into success or automatically replay actions", async () => {
  const f=fixture();
  try {
    const {stdout}=await runNode(process.execPath,["--input-type=module","-e",imports+`
      const result=await turn('crash','CRASH');await wait(()=>!runs.assistantRunIsExecuting(runs.getAssistantRun('crash')));console.log(JSON.stringify(result));
    `],{env:f.env,cwd:appRoot,timeout:10000});
    assert.equal(JSON.parse(stdout.trim()).state,"error");
    assert.equal(fs.readFileSync(path.join(f.directory,"executions"),"utf8"),"CRASH\n");
  } finally { await cleanup(f.directory); }
});

test("native permission remains pending until a matching advertised decision arrives", async () => {
  const f=fixture();
  try {
    const {stdout}=await runNode(process.execPath,["--input-type=module","-e",imports+`
      const run=runs.createAssistantRun({id:'permission',sessionId:payload.sessionId,text:'PERMISSION',textOnly:true});
      await launch.launchAssistantRun(run,{...payload,text:'PERMISSION'});
      const permission=await wait(()=>runs.getAssistantRun(run.id).permission);
      const fs=await import('node:fs');
      fs.writeFileSync(process.env.PANEL_DATA_DIR+'/assistant-runs/permission.permission.json',JSON.stringify({requestId:'wrong',optionId:'allow_once'}));
      await sleep(150);const stillPending=runs.getAssistantRun(run.id).state==='active';
      fs.writeFileSync(process.env.PANEL_DATA_DIR+'/assistant-runs/permission.permission.json',JSON.stringify({requestId:permission.requestId,optionId:'allow_once'}));
      const result=await wait(()=>runs.getAssistantRun(run.id).state==='complete'&&runs.getAssistantRun(run.id));
      await wait(()=>!runs.assistantRunIsExecuting(runs.getAssistantRun(run.id)));
      console.log(JSON.stringify({permission,stillPending,result}));
    `],{env:f.env,cwd:appRoot,timeout:10000});
    const result=JSON.parse(stdout.trim());
    assert.equal(result.permission.options[0].optionId,"allow_once");
    assert.equal(result.stillPending,true);
    assert.equal(result.result.response,"Permission handled.");
    assert.equal(result.result.permission,null);
  } finally { await cleanup(f.directory); }
});

test("concurrent native permissions are serialized without losing requests or accepting stale and cross-session decisions", async () => {
  const f = fixture();
  try {
    const { stdout } = await runNode(process.execPath, ["--input-type=module", "-e", imports + `
      const fs=await import('node:fs');
      const run=runs.createAssistantRun({id:'concurrent-permission',sessionId:payload.sessionId,text:'CONCURRENT_PERMISSION',textOnly:true});
      await launch.launchAssistantRun(run,{...payload,text:'CONCURRENT_PERMISSION'});
      const first=await wait(()=>runs.getAssistantRun(run.id).permission);
      fs.writeFileSync(process.env.PANEL_DATA_DIR+'/assistant-runs/concurrent-permission.permission.json',JSON.stringify({requestId:'stale-request',optionId:'allow_once'}));
      await sleep(150);const staleIgnored=runs.getAssistantRun(run.id).permission?.requestId===first.requestId;
      fs.writeFileSync(process.env.PANEL_DATA_DIR+'/assistant-runs/concurrent-permission.permission.json',JSON.stringify({requestId:first.requestId,optionId:'allow_once'}));
      const second=await wait(()=>{const p=runs.getAssistantRun(run.id).permission;return p&&p.requestId!==first.requestId&&p});
      fs.writeFileSync(process.env.PANEL_DATA_DIR+'/assistant-runs/concurrent-permission.permission.json',JSON.stringify({requestId:second.requestId,optionId:'allow_once'}));
      const result=await wait(()=>runs.getAssistantRun(run.id).state==='complete'&&runs.getAssistantRun(run.id));
      await wait(()=>!runs.assistantRunIsExecuting(runs.getAssistantRun(run.id)));
      console.log(JSON.stringify({first,second,staleIgnored,result}));
    `], { env: f.env, cwd: appRoot, timeout: 10000 });
    const result = JSON.parse(stdout.trim());
    assert.equal(result.staleIgnored, true);
    assert.match(result.first.requestId, /:100$/);
    assert.match(result.second.requestId, /:101$/);
    assert.ok(Date.parse(result.second.expiresAt) > Date.parse(result.first.expiresAt));
    assert.equal(result.result.response, "Concurrent permissions handled.");
    assert.equal(result.result.permission, null);
    const answers = fs.readFileSync(path.join(f.directory, "permission-answers"), "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(answers, [
      { id: 102, outcome: "cancelled", optionId: "" },
      { id: 100, outcome: "selected", optionId: "allow_once" },
      { id: 101, outcome: "selected", optionId: "allow_once" },
    ]);
  } finally { await cleanup(f.directory); }
});

test("duplicate native permission IDs fail closed without displacing a later valid request", async () => {
  const f = fixture();
  try {
    const { stdout } = await runNode(process.execPath, ["--input-type=module", "-e", imports + `
      const fs=await import('node:fs');
      const run=runs.createAssistantRun({id:'duplicate-permission',sessionId:payload.sessionId,text:'DUPLICATE_PERMISSION',textOnly:true});
      await launch.launchAssistantRun(run,{...payload,text:'DUPLICATE_PERMISSION'});
      const permission=await wait(()=>{const p=runs.getAssistantRun(run.id).permission;return p?.requestId.endsWith(':104')&&p});
      runs.cancelAssistantRun(run.id,payload.sessionId);
      let result;for(let i=0;i<320;i++){const current=runs.getAssistantRun(run.id);if(!runs.assistantRunIsExecuting(current)){result=current;break;}await sleep(25);}if(!result)throw Error('duplicate cleanup timed out');
      console.log(JSON.stringify({permission,result}));
    `], { env: f.env, cwd: appRoot, timeout: 10000 });
    const result = JSON.parse(stdout.trim());
    assert.match(result.permission.requestId, /:104$/);
    assert.equal(result.result.state, "cancelled");
    const answers = fs.readFileSync(path.join(f.directory, "duplicate-answers"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(answers.some(answer => answer.id === 103 && answer.outcome === "cancelled"), true);
  } finally { await cleanup(f.directory); }
});

test("cancelling a run rejects every queued native permission and clears the public prompt", async () => {
  const f = fixture();
  try {
    const { stdout } = await runNode(process.execPath, ["--input-type=module", "-e", imports + `
      const fs=await import('node:fs');
      const run=runs.createAssistantRun({id:'cancel-permissions',sessionId:payload.sessionId,text:'CONCURRENT_PERMISSION',textOnly:true});
      await launch.launchAssistantRun(run,{...payload,text:'CONCURRENT_PERMISSION'});
      await wait(()=>runs.getAssistantRun(run.id).permission);
      runs.cancelAssistantRun(run.id,payload.sessionId);
      let result;for(let i=0;i<320;i++){const current=runs.getAssistantRun(run.id);if(!runs.assistantRunIsExecuting(current)){result=current;break;}await sleep(25);}if(!result)throw Error('cancel cleanup timed out');
      console.log(JSON.stringify({result,permissionFileExists:fs.existsSync(process.env.PANEL_DATA_DIR+'/assistant-runs/cancel-permissions.permission.json')}));
    `], { env: f.env, cwd: appRoot, timeout: 10000 });
    const result = JSON.parse(stdout.trim());
    assert.equal(result.result.state, "cancelled");
    assert.equal(result.result.permission, null);
    assert.equal(result.permissionFileExists, false);
  } finally { await cleanup(f.directory); }
});

test("a native terminal result rejects unresolved permissions and clears the public prompt", async () => {
  const f = fixture();
  try {
    const { stdout } = await runNode(process.execPath, ["--input-type=module", "-e", imports + `
      const fs=await import('node:fs');
      const result=await turn('terminal-permission','TERMINAL_WITH_PERMISSION');
      await wait(()=>!runs.assistantRunIsExecuting(runs.getAssistantRun(result.id)));
      await wait(()=>fs.existsSync(process.env.PANEL_DATA_DIR+'/duplicate-answers'));
      console.log(JSON.stringify({result,answers:fs.readFileSync(process.env.PANEL_DATA_DIR+'/duplicate-answers','utf8').trim().split('\\n').map(JSON.parse)}));
    `], { env: f.env, cwd: appRoot, timeout: 10000 });
    const result = JSON.parse(stdout.trim());
    assert.equal(result.result.state, "complete");
    assert.equal(result.result.response, "Finished with cleanup.");
    assert.equal(result.result.permission, null);
    assert.equal(result.answers.some(answer => answer.id === 105 && answer.outcome === "cancelled"), true);
  } finally { await cleanup(f.directory); }
});

test("ACP end_turn without an authoritative receipt fails without replay", async () => {
  const f=fixture();
  try {
    const {stdout}=await runNode(process.execPath,["--input-type=module","-e",imports+`
      const result=await turn('no-receipt','NO_RECEIPT');await wait(()=>!runs.assistantRunIsExecuting(runs.getAssistantRun('no-receipt')));console.log(JSON.stringify(result));
    `],{env:f.env,cwd:appRoot,timeout:10000});
    assert.equal(JSON.parse(stdout.trim()).state,"error");
    assert.equal(fs.readFileSync(path.join(f.directory,"executions"),"utf8"),"NO_RECEIPT\n");
  } finally { await cleanup(f.directory); }
});

test("a late missing receipt keeps the latest safe streamed answer and does not claim an auth failure", async () => {
  const f = fixture();
  try {
    const { stdout } = await runNode(process.execPath, ["--input-type=module", "-e", imports + `
      const result=await turn('partial-no-receipt','PARTIAL_NO_RECEIPT');
      console.log(JSON.stringify({run:runs.publicAssistantRun(result),stream:streams.readAssistantText(result.id)}));
    `], { env: f.env, cwd: appRoot, timeout: 10000 });
    const result = JSON.parse(stdout.trim());
    assert.equal(result.run.state, "error");
    assert.equal(result.run.response, "");
    assert.equal(result.run.partialResponse, "Done.");
    assert.match(result.run.error, /could not complete/i);
    assert.doesNotMatch(result.run.error, /authenticate/i);
    assert.equal(result.stream.map(event => event.text).join(""), "Working. Done.");
  } finally { await cleanup(f.directory); }
});

test("underscore-prefixed Panel turn receipts are authoritative", async () => {
  const f = fixture();
  try {
    const { stdout } = await runNode(process.execPath, ["--input-type=module", "-e", imports + `
      const result=await turn('prefixed-result','PREFIXED_RESULT');
      console.log(JSON.stringify(result));
    `], { env: f.env, cwd: appRoot, timeout: 10000 });
    const result = JSON.parse(stdout.trim());
    assert.equal(result.state, "complete");
    assert.equal(result.response, "Done.");
  } finally { await cleanup(f.directory); }
});

test("warmup creates no active turn and idle expiry reaps its dedicated runtime", async () => {
  const f=fixture();
  try {
    const {stdout}=await runNode(process.execPath,["--input-type=module","-e",imports+`
      await runtime.warmAssistantRuntime(payload);const fs=await import('node:fs');
      const spec=JSON.parse(fs.readFileSync(runtime.runtimePaths(payload).spec));
      const alive=()=>{try{process.kill(spec.pid,0);return true}catch{return false}};
      await wait(()=>!alive());console.log(JSON.stringify({activeRun:runs.getConversationSession(payload.sessionId).activeRunId||null,nativeSession:runs.getConversationSession(payload.sessionId).hermesSessionId||null,executions:fs.existsSync(process.env.PANEL_DATA_DIR+'/executions')}));
    `],{env:{...f.env,HERMES_ACP_IDLE_TIMEOUT_MS:"100"},cwd:appRoot,timeout:10000});
    assert.deepEqual(JSON.parse(stdout.trim()),{activeRun:null,nativeSession:null,executions:false});
  } finally { await cleanup(f.directory); }
});

test("cancelling one conversation cannot stop another conversation's runtime", async () => {
  const f=fixture();
  try {
    const {stdout}=await runNode(process.execPath,["--input-type=module","-e",imports+`
      const first=runs.createAssistantRun({id:'isolation-first',sessionId:payload.sessionId,text:'WAIT',textOnly:true});
      const other={...payload,sessionId:'other-conversation'};
      const second=runs.createAssistantRun({id:'isolation-second',sessionId:other.sessionId,text:'WAIT',textOnly:true});
      await launch.launchAssistantRun(first,{...payload,text:'WAIT'});await launch.launchAssistantRun(second,{...other,text:'WAIT'});
      await wait(()=>runs.getAssistantRun(first.id).persistentRuntimePid&&runs.getAssistantRun(second.id).persistentRuntimePid);
      runs.cancelAssistantRun(first.id,payload.sessionId);await wait(()=>!runs.assistantRunIsExecuting(runs.getAssistantRun(first.id)));
      const otherStillRunning=runs.assistantRunIsExecuting(runs.getAssistantRun(second.id));
      runs.cancelAssistantRun(second.id,other.sessionId);await wait(()=>!runs.assistantRunIsExecuting(runs.getAssistantRun(second.id)));
      console.log(JSON.stringify({otherStillRunning}));
    `],{env:f.env,cwd:appRoot,timeout:10000});
    assert.equal(JSON.parse(stdout.trim()).otherStillRunning,true);
  } finally { await cleanup(f.directory); }
});

test("changing models replaces the idle worker and reloads the current conversation", async () => {
  const f=fixture();
  try {
    const {stdout}=await runNode(process.execPath,["--input-type=module","-e",imports+`
      const first=await turn('before-switch','HELLO');await wait(()=>!runs.assistantRunIsExecuting(runs.getAssistantRun(first.id)));
      const changed=await runtime.warmAssistantRuntime({...payload,model:'another-explicit-model'});
      const fs=await import('node:fs');const spec=JSON.parse(fs.readFileSync(runtime.runtimePaths(payload).spec));
      console.log(JSON.stringify({changed,replaced:spec.pid!==first.persistentRuntimePid,nativeSession:runs.getConversationSession(payload.sessionId).hermesSessionId}));
    `],{env:f.env,cwd:appRoot,timeout:10000});
    const result=JSON.parse(stdout.trim());
    assert.equal(result.changed.model,"another-explicit-model");
    assert.equal(result.replaced,true);
    assert.equal(result.nativeSession,"native-session");
  } finally { await cleanup(f.directory); }
});

test("enabling ACP for Chat preserves the legacy runner for scheduled tasks", async () => {
  const f=fixture();
  try {
    const {stdout}=await runNode(process.execPath,["--input-type=module","-e",imports+`
      const {EventEmitter}=await import('node:events');const selected=[];
      const spawnProcess=(command,args)=>{selected.push(args[0]);const child=new EventEmitter();child.pid=process.pid;child.unref=()=>{};queueMicrotask(()=>child.emit('spawn'));return child;};
      for(const source of ['task','chat']){
        const run=runs.createAssistantRun({id:'route-'+source,sessionId:'route-'+source,text:'routing fixture',textOnly:true,source});
        await launch.launchAssistantRun(run,{...payload,sessionId:run.sessionId},{spawnProcess});
      }
      console.log(JSON.stringify(selected));
    `],{env:f.env,cwd:appRoot,timeout:10000});
    const selected=JSON.parse(stdout.trim());
    assert.equal(path.basename(selected[0]),"run-hermes-action.mjs");
    assert.equal(path.basename(selected[1]),"run-hermes-acp-action.mjs");
    assert.equal(fs.existsSync(path.join(f.directory,"executions")),false);
  } finally { await cleanup(f.directory); }
});

test("native tool starts with omitted status become progress, explicit pending does not, and terminal state clears progress", async () => {
  const f=fixture();
  try {
    const {stdout}=await runNode(process.execPath,["--input-type=module","-e",imports+`
      const progress=[];
      for(const text of ['PENDING_TOOL','ACTIVE_TOOL']){
        const input={...payload,sessionId:'progress-'+text};
        const run=runs.createAssistantRun({id:'progress-'+text,sessionId:input.sessionId,text,textOnly:true});
        await launch.launchAssistantRun(run,{...input,text});
        await wait(()=>runs.getAssistantRun(run.id).statusLabel==='Preparing the requested action…'||runs.getAssistantRun(run.id).toolProgress);
        progress.push(runs.publicAssistantRun(runs.getAssistantRun(run.id)).toolProgress);
        runs.cancelAssistantRun(run.id,input.sessionId);await wait(()=>!runs.assistantRunIsExecuting(runs.getAssistantRun(run.id)));
        progress.push(runs.publicAssistantRun(runs.getAssistantRun(run.id)).toolProgress);
      }
      console.log(JSON.stringify(progress));
    `],{env:f.env,cwd:appRoot,timeout:10000});
    const result=JSON.parse(stdout.trim());
    assert.equal(result[0],null);
    assert.equal(result[1],null);
    assert.equal(result[2].kind,"execute");
    assert.equal(result[2].status,"in_progress");
    assert.ok(Number.isFinite(Date.parse(result[2].startedAt)));
    assert.equal(result[3],null);
    assert.doesNotMatch(JSON.stringify(result),/SECRET|PRIVATE/);
  } finally { await cleanup(f.directory); }
});
