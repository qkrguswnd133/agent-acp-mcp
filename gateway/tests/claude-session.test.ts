import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {readClaudeSessionEffort,readClaudeSessionTelemetry} from '../src/claude-session.js';
const id='12345678-1234-1234-1234-123456789abc';
test('official session effort ignores other sessions and uses per-turn evidence',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'claude-effort-'));
 const dir=path.join(root,'project');await fs.mkdir(dir);
 const file=path.join(dir,`${id}.jsonl`),cwd=process.cwd();
 const entry=(extra:any={})=>({type:'assistant',sessionId:id,cwd,effort:'medium',message:{model:'claude-opus-5'},...extra});
 const write=async(entries:any[])=>fs.writeFile(file,entries.map(e=>JSON.stringify(e)).join('\n')+'\n{partial');
 try{
  await write([entry({sessionId:'different',effort:'max'}),entry({isSidechain:true,effort:'low'}),entry({perTurnEffort:'high'})]);
  assert.deepEqual(await readClaudeSessionEffort(cwd,id,[root]),{effort:'high',effortSource:'session_jsonl',observedEfforts:['high'],effortComplete:true});
  await write([entry(),entry({effort:'xhigh'})]);
  assert.equal((await readClaudeSessionEffort(cwd,id,[root])).effort,'mixed');
  await write([entry(),entry({effort:undefined})]);
  assert.equal((await readClaudeSessionEffort(cwd,id,[root])).effort,'unavailable');
  assert.equal((await readClaudeSessionEffort(path.join(cwd,'other'),id,[root])).effort,'unavailable');
  assert.equal((await readClaudeSessionEffort(cwd,'../escape',[root])).effort,'unavailable');
 }finally{await fs.unlink(file);await fs.rmdir(dir);await fs.rmdir(root);}
});
test('missing transcript does not fail the task or invent configured effort',async()=>{
 assert.equal((await readClaudeSessionEffort(process.cwd(),id,[])).effort,'unavailable');
});

test('official session telemetry recovers distinct partial text and the last distinct reported usage without aggregation',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'claude-telemetry-'));
 const dir=path.join(root,'project');await fs.mkdir(dir);const file=path.join(dir,`${id}.jsonl`),cwd=process.cwd();
 const entry=(text:string,usage:any)=>({type:'assistant',sessionId:id,cwd,effort:'high',message:{content:[{type:'text',text}],usage}});
 try{
  await fs.writeFile(file,[entry('first',{input:1}),entry('first',{input:1}),entry('second',{input:2})].map(value=>JSON.stringify(value)).join('\n'));
  const telemetry=await readClaudeSessionTelemetry(cwd,id,[root]);
  assert.equal(telemetry.text,'first\nsecond');assert.deepEqual(telemetry.usage,{input:2});assert.deepEqual(telemetry.observedUsage,[{input:1},{input:2}]);assert.equal(telemetry.usageSource,'session_jsonl');assert.equal(telemetry.usageScope,'last_observed_message');assert.equal(telemetry.effort,'high');
 }finally{await fs.unlink(file);await fs.rmdir(dir);await fs.rmdir(root);}
});
