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
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "panel-acp-test-"));
  const fake = path.join(directory, "fake-acp");
  fs.writeFileSync(fake, `#!${process.execPath}
const readline=require('node:readline');const fs=require('node:fs');
const out=o=>process.stdout.write(JSON.stringify(o)+'\\n');let permissionTurn;
readline.createInterface({input:process.stdin}).on('line',line=>{const e=JSON.parse(line);const p=e.params||{};let result={};
 if(e.id===99&&!e.method&&permissionTurn){const q=permissionTurn;out({jsonrpc:'2.0',method:'panel/turn_result',params:{sessionId:q.params.sessionId,text:'Permission handled.',exit_code:0,error:''}});out({jsonrpc:'2.0',id:q.id,result:{stopReason:'end_turn'}});return;}
 if(e.method==='initialize')result={protocolVersion:1};
 if(e.method==='session/new'||e.method==='session/load')result={sessionId:p.sessionId||'native-session',models:{currentModelId:process.env.PANEL_ACP_PROVIDER+':'+process.env.PANEL_ACP_MODEL}};
 if(e.method==='panel/stop_agent'){
  fs.appendFileSync(process.env.PANEL_DATA_DIR+'/stop-requests',JSON.stringify(p)+'\\n');
  if(p.runId&&p.agentId){out({jsonrpc:'2.0',method:'panel/agent_update',params:{sessionId:p.sessionId,runId:p.runId,agent:{id:p.agentId,name:'Background helper',task:'Finish its focused task',status:'cancelled',result:'Stopped.'}}});result={ok:true};}
  else result={ok:false,error:'missing child target'};
 }
 if(e.method==='session/prompt'){
  fs.appendFileSync(process.env.PANEL_DATA_DIR+'/executions',p.prompt[0].text+'\\n');
  fs.appendFileSync(process.env.PANEL_DATA_DIR+'/turn-instructions',JSON.stringify({sessionId:p.sessionId,text:p.prompt[0].text,runId:(p._meta||{})['hermes-control/run-id']||null,instructions:(p._meta||{})['hermes-control/turn-instructions']||null,commonInstructions:process.env.PANEL_ACP_INSTRUCTIONS||'',agentSoul:process.env.PANEL_AGENT_SOUL||''})+'\\n');
  if(p.prompt[0].text==='WAIT')return;
  if(p.prompt[0].text==='CRASH')process.exit(3);
  if(p.prompt[0].text==='PERMISSION'){permissionTurn=e;out({jsonrpc:'2.0',id:99,method:'session/request_permission',params:{sessionId:p.sessionId,toolCall:{title:'Write QA fixture'},options:[{optionId:'allow_once',name:'Allow once',kind:'allow_once'},{optionId:'deny',name:'Deny',kind:'reject_once'}]}});return;}
  if(p.prompt[0].text==='NO_RECEIPT'){out({jsonrpc:'2.0',id:e.id,result:{stopReason:'end_turn'}});return;}
  const emit=u=>out({jsonrpc:'2.0',method:'session/update',params:{sessionId:p.sessionId,update:u}});
  emit({sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'SECRET REASONING'}});
  emit({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Working. '}});
  emit({sessionUpdate:'tool_call',toolCallId:'tool-1',kind:'execute',title:'PRIVATE COMMAND',status:p.prompt[0].text==='PENDING_TOOL'?'pending':undefined,rawInput:{command:'SECRET'}});
  if(['PENDING_TOOL','ACTIVE_TOOL'].includes(p.prompt[0].text))return;
  emit({sessionUpdate:'tool_call_update',toolCallId:'tool-1',status:'completed',rawOutput:'PRIVATE RESULT'});
  emit({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Done.'}});
  if(p.prompt[0].text==='DELEGATE_LATE'){
   const runId=(p._meta||{})['hermes-control/run-id'];
   setTimeout(()=>out({jsonrpc:'2.0',method:'panel/agent_update',params:{sessionId:p.sessionId,runId,agent:{id:'child-for-'+runId,name:'Background helper',task:'Finish its focused task',status:'running',canStop:true}}}),120);
  }
  out({jsonrpc:'2.0',method:'panel/turn_result',params:{sessionId:p.sessionId,text:'Done.',exit_code:0,error:'',usage:{inputTokens:12,outputTokens:3,costUsd:0.001}}});result={stopReason:'end_turn'};
 }
 if(e.id!==undefined)out({jsonrpc:'2.0',id:e.id,result});
});
`, { mode: 0o700 });
  return { directory, env: { ...process.env, PANEL_APP_ROOT: appRoot, PANEL_DATA_DIR: directory, HERMES_ACP_COMMAND: fake, HERMES_VOICE_TRANSPORT: "acp" } };
}
function cleanup(directory) {
  const files = fs.existsSync(path.join(directory, "acp-runtime")) ? fs.readdirSync(path.join(directory, "acp-runtime")).filter(name => name.endsWith(".json")) : [];
  for (const name of files) {
    const spec = JSON.parse(fs.readFileSync(path.join(directory, "acp-runtime", name), "utf8"));
    try { process.kill(-spec.pid, "SIGKILL"); } catch {}
    try { fs.unlinkSync(spec.socket); } catch {}
  }
  fs.rmSync(directory, { recursive: true, force: true });
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
    assert.equal(fs.readFileSync(path.join(f.directory,"executions"),"utf8"),"VOICE_ONE\nCHAT_TWO\nVOICE_THREE\n");
  } finally { cleanup(f.directory); }
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
      sessionId: "native-session",
      runId: "parent-late",
      agentId: "child-for-parent-late",
    });
    assert.equal(result.executions, "DELEGATE_LATE\n");
    assert.equal(result.replacement.model, "replacement-after-child-stops");
    assert.notEqual(result.finalPid, result.beforePid);
  } finally { cleanup(f.directory); }
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
  } finally { cleanup(f.directory); }
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
  } finally { cleanup(f.directory); }
});

test("a dead ACP process cannot turn partial progress into success or automatically replay actions", async () => {
  const f=fixture();
  try {
    const {stdout}=await runNode(process.execPath,["--input-type=module","-e",imports+`
      const result=await turn('crash','CRASH');await wait(()=>!runs.assistantRunIsExecuting(runs.getAssistantRun('crash')));console.log(JSON.stringify(result));
    `],{env:f.env,cwd:appRoot,timeout:10000});
    assert.equal(JSON.parse(stdout.trim()).state,"error");
    assert.equal(fs.readFileSync(path.join(f.directory,"executions"),"utf8"),"CRASH\n");
  } finally { cleanup(f.directory); }
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
  } finally { cleanup(f.directory); }
});

test("ACP end_turn without an authoritative receipt fails without replay", async () => {
  const f=fixture();
  try {
    const {stdout}=await runNode(process.execPath,["--input-type=module","-e",imports+`
      const result=await turn('no-receipt','NO_RECEIPT');await wait(()=>!runs.assistantRunIsExecuting(runs.getAssistantRun('no-receipt')));console.log(JSON.stringify(result));
    `],{env:f.env,cwd:appRoot,timeout:10000});
    assert.equal(JSON.parse(stdout.trim()).state,"error");
    assert.equal(fs.readFileSync(path.join(f.directory,"executions"),"utf8"),"NO_RECEIPT\n");
  } finally { cleanup(f.directory); }
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
  } finally { cleanup(f.directory); }
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
  } finally { cleanup(f.directory); }
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
  } finally { cleanup(f.directory); }
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
  } finally { cleanup(f.directory); }
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
  } finally { cleanup(f.directory); }
});
