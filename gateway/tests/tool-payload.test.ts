import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {boundedToolPayload} from '../src/tool-payload.js';
const bytes=(v:any)=>Buffer.byteLength(JSON.stringify({content:[{type:'text',text:JSON.stringify(v)}]}));
test('160-PID job and maintenance responses are bounded, deduplicated and lossless in artifacts',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'tool-payload-'));
 try{
  const checks=Array.from({length:160},(_,pid)=>({pid:1000+pid,decision:pid%2?'reused':'unknown',reason:'한글 evidence '.repeat(30)})),proof={checks},audit={trackedProcessCheck:proof,processCleanupUnchanged:true,processWarnings:['Unverified; original history retained']};
  for(const payload of [{job_id:'fixture',status:'failed',result:{error:'preserve me',processCleanup:{trackedProcesses:checks},commandExecutions:checks,text:'review'.repeat(10000)}},{job_id:'fixture',record_only:true,worktree:{forgetAudit:audit},trackedProcessCheck:proof}]){
   const before=structuredClone(payload);const compact=await boundedToolPayload(payload,root);assert(bytes(compact)<20*1024);assert.ok(compact.details.artifact);assert.deepEqual(JSON.parse(await fs.readFile(compact.details.artifact.path,'utf8')),before);assert.deepEqual(payload,before);
   if('record_only' in payload){assert.equal(compact.trackedProcessCheck,undefined);assert.equal(compact.worktree.forgetAudit.trackedProcessCheck.pidDecisions.unknown,80);}
   const verbose=await boundedToolPayload(payload,root,true);assert(bytes(verbose)<20*1024);assert.deepEqual(JSON.parse(await fs.readFile(verbose.details.artifact.path,'utf8')),before);
   if('record_only' in payload){const wrapped=await boundedToolPayload({operation_id:'fixture',status:'completed',result:payload},root);assert.equal(wrapped.result.trackedProcessCheck,undefined);assert.equal(wrapped.result.worktree.forgetAudit.trackedProcessCheck.pidDecisions.unknown,80);}
  }
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('artifact storage failure retains outcome without returning an oversized diagnostic',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'tool-payload-'));try{const file=path.join(root,'file');await fs.writeFile(file,'keep');const r=await boundedToolPayload({status:'failed',error:'primary task error',raw:'x'.repeat(100000)},file);assert.equal(r.status,'failed');assert.equal(r.error,'primary task error');assert(bytes(r)<20*1024);assert.ok(r.details.error);assert.equal(await fs.readFile(file,'utf8'),'keep');}finally{await fs.rm(root,{recursive:true,force:true});}
});
