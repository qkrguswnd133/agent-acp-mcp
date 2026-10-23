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

test('nine worktree rows keep every job, disposition and counts while historical diagnostics are offloaded',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'tool-payload-'));
 try{
  const value={items:Array.from({length:9},(_,i)=>({job_id:`job-${i}`,jobStatus:i===8?'failed':'completed',createdAt:'2026-10-23T00:00:00Z',worktree:{path:`C:/worktrees/job-${i}/repo`,branch:`agent-acp/job-${i}`,state:'preserved',commitCount:i,changedFileCount:2,ignoredFileCount:4000,ignoredDirectories:['backend/build','backend/.gradle'],integratedIntoOriginalHead:i!==8,nextAction:'Review integration before cleanup',forgetAudit:{trackedProcesses:Array.from({length:117},(_,pid)=>({pid,commandLine:'diagnostic'.repeat(80)}))}}})),total:12,next_offset:9};
  const compact=await boundedToolPayload(value,root);assert(bytes(compact)<20*1024);
  assert.equal(compact.items.length,9);assert.equal(compact.items[8].jobStatus,'failed');assert.equal(compact.items[8].worktree.commitCount,8);
  assert.equal(compact.items[0].worktree.ignoredFileCount,4000);assert.deepEqual(compact.items[0].worktree.ignoredDirectories,['backend/build','backend/.gradle']);
  assert.equal(compact.next_offset,9);assert.equal(compact.total,12);assert.deepEqual(JSON.parse(await fs.readFile(compact.details.artifact.path,'utf8')),value);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('review body survives command-output compaction and operation wrappers retain failure and command outcomes',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'tool-payload-'));
 try{
  const text='Review conclusion and evidence. '.repeat(240);
  const value={operation_id:'operation',status:'completed',result:{job_id:'job',status:'failed',error:'Tests failed',result:{text,outcome:'failed',successCount:0,failureCount:1,execution:{commands:Array.from({length:8},(_,i)=>({command:`test-${i}`,exitCode:i===7?1:0,output:'START'+'output '.repeat(10000)+'END'}))},skipped:[{provider:'claude',reason:'Prior implementation failed; review workspace'}]}}};
  const compact=await boundedToolPayload(value,root);assert(bytes(compact)<20*1024);
  assert.equal(compact.result.result.text,text);assert.equal(compact.result.error,'Tests failed');assert.equal(compact.result.result.failureCount,1);
  assert.equal(compact.result.result.execution.commands.at(-1).exitCode,1);assert.match(compact.result.result.execution.commands.at(-1).output,/END$/);
  assert.equal(compact.result.result.skipped[0].reason,value.result.result.skipped[0].reason);
  assert.deepEqual(JSON.parse(await fs.readFile(compact.details.artifact.path,'utf8')),value);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('oversized deliverable text is explicitly marked and preserved in the full artifact',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'tool-payload-'));
 try{
  const value={job_id:'job',status:'completed',result:{text:'HEAD'+'한글🦊'.repeat(10000)+'TAIL',usage:{totalTokens:123}}};
  const compact=await boundedToolPayload(value,root);assert(bytes(compact)<20*1024);assert.equal(compact.result.textTruncated,true);
  assert.match(compact.result.text,/^HEAD/);assert.match(compact.result.text,/TAIL$/);assert.doesNotMatch(compact.result.text,/�/);
  assert.equal(JSON.parse(await fs.readFile(compact.details.artifact.path,'utf8')).result.text,value.result.text);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
