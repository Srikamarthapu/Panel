import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repo = path.resolve(".");

async function isolated(body) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "panel-active-index-"));
  try {
    return await execute(process.execPath, ["--input-type=module", "-e", body], {
      cwd: repo,
      env: { ...process.env, PANEL_DATA_DIR: path.join(temporary, "data"), FIXTURE_ROOT: temporary },
      timeout: 10000,
    });
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

test("a valid empty active index avoids reading historical run files", async () => {
  const { stdout } = await isolated(`
    import fs from 'node:fs'; import path from 'node:path';
    const root=path.join(process.env.PANEL_DATA_DIR,'assistant-runs'); fs.mkdirSync(root,{recursive:true});
    fs.writeFileSync(path.join(root,'historical.json'),'{not-json');
    fs.writeFileSync(path.join(root,'active-index.json'),JSON.stringify({version:1,ids:[],updatedAt:new Date().toISOString()}));
    const runs=await import('./lib/assistant-runs.js');
    console.log(runs.createAssistantRun({id:'new-run',sessionId:'session',text:'hello'}).id);
  `);
  assert.equal(stdout.trim(), "new-run");
});

test("a missing active index is rebuilt conservatively from potentially executing runs", async () => {
  const { stdout } = await isolated(`
    import fs from 'node:fs'; import path from 'node:path';
    const store=await import('./lib/work-store.js');
    const root=path.join(process.env.PANEL_DATA_DIR,'assistant-runs'); fs.mkdirSync(root,{recursive:true});
    const identity=store.processIdentity(process.pid), now=new Date().toISOString();
    for(let i=0;i<4;i++) fs.writeFileSync(path.join(root,'active-'+i+'.json'),JSON.stringify({id:'active-'+i,sessionId:'s'+i,state:'complete',createdAt:now,updatedAt:now,pid:process.pid,pidIdentity:identity,executionActive:true}));
    const runs=await import('./lib/assistant-runs.js');
    try { runs.createAssistantRun({id:'blocked',sessionId:'new-session',text:'hello'}); }
    catch(error) { console.log(JSON.stringify({status:error.status,message:error.message,index:JSON.parse(fs.readFileSync(path.join(root,'active-index.json'),'utf8')).ids})); }
  `);
  const result = JSON.parse(stdout);
  assert.equal(result.status, 409);
  assert.match(result.message, /up to 4/);
  assert.deepEqual(result.index, ["active-0", "active-1", "active-2", "active-3"]);
});

test("an update rebuilds a corrupt index without omitting other active runs", async () => {
  const { stdout } = await isolated(`
    import fs from 'node:fs'; import path from 'node:path';
    const root=path.join(process.env.PANEL_DATA_DIR,'assistant-runs'); fs.mkdirSync(root,{recursive:true});
    const runs=await import('./lib/assistant-runs.js');
    for(let i=0;i<4;i++) runs.createAssistantRun({id:'kept-'+i,sessionId:'s'+i,text:'work'});
    fs.writeFileSync(path.join(root,'active-index.json'),'{corrupt');
    runs.updateAssistantRun('kept-0',{statusLabel:'still active'});
    let blocked=false; try { runs.createAssistantRun({id:'must-block',sessionId:'other',text:'more'}); }
    catch(error) { blocked=error.status===409; }
    console.log(JSON.stringify({blocked,ids:JSON.parse(fs.readFileSync(path.join(root,'active-index.json'),'utf8')).ids}));
  `);
  const result = JSON.parse(stdout);
  assert.equal(result.blocked, true);
  assert.deepEqual(result.ids, ["kept-0", "kept-1", "kept-2", "kept-3"]);
});
