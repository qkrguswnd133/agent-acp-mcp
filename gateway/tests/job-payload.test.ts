import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {MAX_JOB_RESPONSE_BYTES,persistJobPayload,presentJobPayload} from '../src/job-payload.js';

async function fixture(){return fs.mkdtemp(path.join(os.tmpdir(),'job-payload-'));}
function oversized(){return {
 job_id:randomUUID(),status:'failed',kind:'agent_implement',error:'primary task failure',
 activity:{phase:'running',detail:'한글🦊'.repeat(30000)},
 result:{error:'provider quota',errorKind:'quota_exhausted',sessionId:'session-preserved',usage:{totalTokens:12345},selection:{requested:'auto',selected:'grok'},handoff:{requiresWorkspaceReview:true,cwd:'C:\\workspace'},
  text:'HEAD한글🦊'.repeat(5000)+'TAIL',rawEvents:Array.from({length:100},(_,i)=>({id:i,text:'raw🦊'.repeat(1000)})),
  commandExecutions:Array.from({length:100},(_,i)=>({id:`command-${i}`,command:'npm test',exitCode:i%3===0?1:0,output:'START-'+('한글🦊'.repeat(3000))+'-END'}))}
 };}
test('small ordinary jobs remain backward compatible and are not mutated',async()=>{
 const job={job_id:randomUUID(),status:'completed',result:{text:'Done',error:null,sessionId:'s',usage:{totalTokens:5}}};
 const before=structuredClone(job),dir=await fixture();
 try{assert.deepEqual(await persistJobPayload(job,dir),before);assert.deepEqual(await presentJobPayload(job,{jobsDirectory:dir}),before);assert.deepEqual(job,before);assert.deepEqual(await fs.readdir(dir),[]);}finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('large Unicode jobs persist compact previews and lossless raw artifacts',async()=>{
 const dir=await fixture(),job=oversized(),before=structuredClone(job);
 try{
  const saved=await persistJobPayload(job,dir),view=await presentJobPayload(saved,{jobsDirectory:dir});
  assert.ok(Buffer.byteLength(JSON.stringify(view))<=MAX_JOB_RESPONSE_BYTES);
  assert.deepEqual(job,before);assert.equal(view.status,'failed');assert.equal(view.error,job.error);
  for(const key of ['error','errorKind','sessionId','usage','selection','handoff'])assert.deepEqual(view.result[key],(job.result as any)[key]);
  assert.equal(view.result.rawEvents.length,0);assert.equal(view.payload.counts.rawEvents,100);assert.equal(view.payload.counts.commandExecutions,100);
  const command=view.result.commandExecutions[0];assert.equal(command.id,'command-0');assert.equal(command.exitCode,1);assert.match(command.output,/START-/);assert.match(command.output,/-END/);assert.doesNotMatch(command.output,/�/);
  const artifact=view.payload.artifact,contents=await fs.readFile(path.join(dir,artifact.path));
  assert.equal(contents.length,artifact.bytes);assert.equal(createHash('sha256').update(contents).digest('hex'),artifact.sha256);
  assert.deepEqual(await presentJobPayload(saved,{jobsDirectory:dir,verbose:true}),before);
  assert.deepEqual(await persistJobPayload(saved,dir),saved);
  assert.deepEqual(await persistJobPayload(job,dir),saved);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('legacy inline jobs compact read-only and verbose retains all content',async()=>{
 const dir=await fixture(),job=oversized();
 try{const result=await presentJobPayload(job,{jobsDirectory:dir});assert.ok(Buffer.byteLength(JSON.stringify(result))<=MAX_JOB_RESPONSE_BYTES);assert.equal(result.result.rawEvents.length,0);assert.deepEqual(await fs.readdir(dir),[]);assert.deepEqual(await presentJobPayload(job,{jobsDirectory:dir,verbose:true}),job);}finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('raw events alone are offloaded even below the response cap',async()=>{
 const dir=await fixture(),job={job_id:randomUUID(),status:'completed',result:{rawEvents:[{text:'raw event'}],text:'complete'}};
 try{const saved=await persistJobPayload(job,dir);assert.deepEqual(saved.result.rawEvents,[]);assert.equal(saved.payload.counts.rawEvents,1);assert.deepEqual(await presentJobPayload(saved,{verbose:true,jobsDirectory:dir}),job);}finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('small raw event strings are omitted, measured as text, and restored losslessly',async()=>{
 const dir=await fixture(),rawEvents='{"type":"thread.started","thread_id":"한글🦊"}\nnot-json\r\n\n';
 const job={job_id:randomUUID(),status:'completed',result:{rawEvents,text:'complete'}};
 try{
  const saved=await persistJobPayload(job,dir),view=await presentJobPayload(saved,{jobsDirectory:dir});
  assert.equal(saved.result.rawEvents,'');assert.equal(view.result.rawEvents,'');assert.ok(saved.payload.artifact);
  assert.equal(view.payload.counts.rawEvents,null);assert.equal(view.payload.counts.rawEventTextLines,2);assert.equal(view.payload.counts.rawEventBytes,Buffer.byteLength(rawEvents));
  assert.deepEqual(await presentJobPayload(saved,{verbose:true,jobsDirectory:dir}),job);
  assert.equal((await presentJobPayload(job,{jobsDirectory:dir})).result.rawEvents,'');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('Codex JSONL stdout and duplicated command outputs are compact with complete verbose restoration',async()=>{
 const dir=await fixture(),output='start\n'+('한글🦊\n'.repeat(50000))+'end';
 const rawEvents=[{type:'thread.started',thread_id:'codex-thread'},{type:'item.completed',item:{type:'command_execution',id:'item_0',command:'npm test',aggregated_output:output,exit_code:0}},{type:'turn.completed',usage:{input_tokens:100,output_tokens:20}}].map(item=>JSON.stringify(item)).join('\n')+'\n';
 const job={job_id:randomUUID(),status:'completed',result:{provider:'codex',text:'Implemented and tested.',error:null,errorKind:null,sessionId:'codex-thread',usage:{input_tokens:100,output_tokens:20},commandExecutions:[{command:'npm test',cwd:'C:\\workspace',exitCode:0,output,source:'codex_json'}],rawEvents}};
 try{
  const saved=await persistJobPayload(job,dir),view=await presentJobPayload(saved,{jobsDirectory:dir});
  assert.ok(Buffer.byteLength(JSON.stringify(view))<=MAX_JOB_RESPONSE_BYTES);assert.equal(view.result.rawEvents,'');assert.equal(view.payload.counts.rawEventTextLines,3);assert.equal(view.payload.counts.rawEventBytes,Buffer.byteLength(rawEvents));assert.equal(view.payload.counts.commandExecutions,1);
  assert.match(view.result.commandExecutions[0].output,/^start/);assert.match(view.result.commandExecutions[0].output,/end$/);
  assert.deepEqual(await presentJobPayload(saved,{verbose:true,jobsDirectory:dir}),job);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('storage failures preserve full inline data and primary errors',async()=>{
 const dir=await fixture(),job=oversized(),blocked=path.join(dir,'file');await fs.writeFile(blocked,'blocked');
 try{const saved=await persistJobPayload(job,blocked);assert.equal(saved.status,'failed');assert.equal(saved.error,'primary task failure');assert.deepEqual(saved.result,job.result);assert.equal(saved.payload.diagnostics[0].operation,'storage');const view=await presentJobPayload(saved,{jobsDirectory:blocked});assert.ok(Buffer.byteLength(JSON.stringify(view))<=MAX_JOB_RESPONSE_BYTES);assert.equal(view.payload.diagnostics[0].operation,'storage');assert.equal(view.error,job.error);}finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('verbose hydration rejects traversal, foreign jobs, tampering and symlink files',async(t)=>{
 const dir=await fixture(),job=oversized();
 try{
  const saved=await persistJobPayload(job,dir),ref=saved.payload.artifact;
  for(const malicious of ['../secret.json',`../${ref.path}`,ref.path.replace(job.job_id,randomUUID()),path.join(dir,ref.path)]){
   const forged=structuredClone(saved);forged.payload.artifact.path=malicious;
   const result=await presentJobPayload(forged,{jobsDirectory:dir,verbose:true});assert.equal(result.payload.diagnostics[0].operation,'hydration');assert.equal(result.error,job.error);assert.deepEqual(result.result,saved.result);
  }
  const file=path.join(dir,ref.path),moved=path.join(dir,'original.json');await fs.rename(file,moved);
  await fs.writeFile(file,'tampered');assert.equal((await presentJobPayload(saved,{jobsDirectory:dir,verbose:true})).payload.diagnostics[0].operation,'hydration');await fs.unlink(file);
  try{await fs.symlink(moved,file,'file');}catch(error){if((error as NodeJS.ErrnoException).code==='EPERM'){t.diagnostic('File symlink requires Windows privilege; directory junction test covers available redirect surface.');return;}throw error;}
  assert.equal((await presentJobPayload(saved,{jobsDirectory:dir,verbose:true})).payload.diagnostics[0].operation,'hydration');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('artifact directory junctions cannot hydrate or receive snapshots',async()=>{
 const dir=await fixture(),job=oversized();
 try{
  const saved=await persistJobPayload(job,dir),folder=path.join(dir,job.job_id,'artifacts'),outside=path.join(dir,'redirect');await fs.rename(folder,outside);await fs.symlink(outside,folder,process.platform==='win32'?'junction':'dir');
  assert.equal((await presentJobPayload(saved,{jobsDirectory:dir,verbose:true})).payload.diagnostics[0].operation,'hydration');
  const failed=await persistJobPayload(job,dir);assert.deepEqual(failed.result,job.result);assert.equal(failed.payload.diagnostics[0].operation,'storage');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('current orphan/derived metadata survives hydration',async()=>{
 const dir=await fixture(),job=oversized();
 try{const saved=await persistJobPayload(job,dir);saved.status='interrupted';saved.error='Owner process ended';saved.implementationProgress={status:'observed_activity'};saved.poll_after_seconds=0;const full=await presentJobPayload(saved,{jobsDirectory:dir,verbose:true});assert.equal(full.status,'interrupted');assert.equal(full.error,'Owner process ended');assert.equal(full.poll_after_seconds,0);assert.deepEqual(full.result,job.result);}finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('current completionPending overrides the stored snapshot during verbose hydration',async()=>{
 const dir=await fixture(),job={...oversized(),completionPending:false};
 try{const saved=await persistJobPayload(job,dir);saved.completionPending=true;const full=await presentJobPayload(saved,{jobsDirectory:dir,verbose:true});assert.equal(full.completionPending,true);assert.deepEqual(full.result,job.result);}finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('serialized escaping and large activity arrays obey the byte cap',async()=>{
 const dir=await fixture(),job=oversized();
 job.result.text='\u0000\n"\\🦊'.repeat(20000);
 (job.activity as any).events=Array.from({length:500},(_,i)=>({id:i,detail:'\u0001'.repeat(10000)}));
 try{
  const saved=await persistJobPayload(job,dir);
  assert.ok(Buffer.byteLength(JSON.stringify(saved))<=MAX_JOB_RESPONSE_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(await presentJobPayload(saved,{jobsDirectory:dir})))<=MAX_JOB_RESPONSE_BYTES);
  assert.deepEqual((await presentJobPayload(saved,{jobsDirectory:dir,verbose:true})).result,job.result);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
