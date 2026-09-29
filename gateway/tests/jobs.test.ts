import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {JobManager} from '../src/jobs.js';
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
test('persisted progress warning is visible without cancelling or treating fresh activity as a stall',async()=>{
 const {dir}=await fixture(),id=randomUUID(),directory=path.join(dir,'jobs');await fs.mkdir(directory);
 const now=new Date().toISOString();
 const job={job_id:id,kind:'agent_implement',cwd:dir,ownerPid:process.pid,status:'completed',startedAt:now,lastActivityAt:now,finishedAt:now,activity:{implementationProgress:{startedAt:new Date(Date.now()-600000).toISOString(),successfulReads:51,successfulWrites:0,commandsStarted:0}}};
 await fs.writeFile(path.join(directory,id+'.json'),JSON.stringify(job));
 const m=new JobManager(directory,async()=>{throw Error('must not rerun')});
 try{const value=await m.status(id);assert.equal(value.status,'completed');assert.equal(value.stalled_suspected,false);assert.equal(value.implementationProgress.status,'exploration_without_observed_execution');assert.equal(value.implementationProgress.automaticCancellation,false);}finally{await m.close();await fs.rm(dir,{recursive:true,force:true});}
});
test('parallel readers retain individual locks and report writer conflicts with job details',async()=>{
 const {dir,input}=await fixture();const child=path.join(dir,'child');await fs.mkdir(child);
 const m=new JobManager(path.join(dir,'jobs'),async(_kind,_input,signal)=>new Promise(resolve=>{
  const finish=()=>resolve({error:'Cancelled',errorKind:'cancelled'});
  if(signal.aborted)finish();else signal.addEventListener('abort',finish,{once:true});
 }));
 try{
  const a=await m.start('agent_ask',{...input,provider:'claude'});
  const b=await m.start('agent_review',{...input,cwd:child,provider:'grok'});
  await assert.rejects(()=>m.start('agent_implement',input),error=>{
   const text=String(error);return text.includes(a.job_id)&&text.includes('claude')&&text.includes('agent_ask')&&text.includes('worktree');
  });
  await m.cancel(a.job_id);await done(m,a.job_id);
  await assert.rejects(()=>m.start('agent_implement',input),new RegExp(b.job_id));
  await m.cancel(b.job_id);await done(m,b.job_id);
  const writer=await m.start('agent_implement',{...input,provider:'claude'});
  await assert.rejects(()=>m.start('agent_ask',{...input,cwd:child}),new RegExp(writer.job_id));
  await assert.rejects(()=>m.start('agent_implement',{...input,allowed_paths:[child]}),/overlapping/);
 }finally{await m.close();}
});
async function fixture(){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'grok-jobs-'));return {dir,input:{cwd:dir,task:'fixture'}};}
async function done(m:JobManager,id:string){for(let i=0;i<100;i++){const s=await m.status(id);if(['completed','failed','cancelled'].includes(s.status))return s;await sleep(10);}throw Error('Job did not finish');}
test('start returns before runner finishes, status persists results and rejects overlapping workspace',async()=>{
 const {dir,input}=await fixture();let resolve!:(r:any)=>void;
 const m=new JobManager(path.join(dir,'jobs'),async()=>new Promise(r=>{resolve=r;}));
 const j=await m.start('grok_implement',input);
 while(!resolve)await sleep(1);
 assert.equal((await m.status(j.job_id)).status,'running');
 await assert.rejects(()=>m.start('grok_implement',input),/overlapping/);
 resolve({error:null,sessionId:'fixture',usage:{totalTokens:12}});
 const s=await done(m,j.job_id);assert.equal(s.status,'completed');assert.equal(s.result.usage.totalTokens,12);
 const restarted=new JobManager(path.join(dir,'jobs'),async()=>{throw Error('Must not replay');});
 assert.equal((await restarted.status(j.job_id)).status,'completed');await m.close();
});
test('stalled status does not cancel a live runner; explicit cancel returns partial result',async()=>{
 const {dir,input}=await fixture();let signal:AbortSignal|undefined;
 const m=new JobManager(path.join(dir,'jobs'),async(_k,_i,s,h)=>{
   signal=s;h.onActivity({phase:'prompt',sessionId:'fixture'});
   return new Promise(r=>s.addEventListener('abort',()=>setTimeout(()=>r({error:'Cancelled',errorKind:'cancelled',clientOperations:{writes:2}}),20),{once:true}));
 },10);
 const j=await m.start('grok_implement',input);while(!signal)await sleep(1);await sleep(20);
 assert.equal((await m.status(j.job_id)).stalled_suspected,true);assert.equal(signal.aborted,false);
 assert.equal((await m.cancel(j.job_id)).status,'cancelling');
 const s=await done(m,j.job_id);assert.equal(s.status,'cancelled');assert.equal(s.result.clientOperations.writes,2);await m.close();
});
test('restart recognizes orphan state without replay and reports runner failure',async()=>{
 const {dir,input}=await fixture(),storage=path.join(dir,'jobs');await fs.mkdir(storage);
 const id=randomUUID();await fs.writeFile(path.join(storage,id+'.json'),JSON.stringify({job_id:id,ownerPid:process.pid,status:'running',lastActivityAt:new Date().toISOString()}));
 const m=new JobManager(storage,async()=>{throw Error('Synthetic failure');});
 assert.equal((await m.status(id)).status,'interrupted');
 const j=await m.start('grok_ask',input);assert.equal((await done(m,j.job_id)).error,'Synthetic failure');await m.close();
});
test('bridge close cancels active work and waits for cleanup',async()=>{
 const {dir,input}=await fixture();let ready=false,cleaned=false;
 const m=new JobManager(path.join(dir,'jobs'),async(_k,_i,s)=>{
 ready=true;return new Promise(r=>s.addEventListener('abort',()=>setTimeout(()=>{cleaned=true;r({error:'cancelled',errorKind:'cancelled'});},10)));
 });
 const j=await m.start('grok_ask',input);while(!ready)await sleep(1);
 await m.close();assert.equal(cleaned,true);assert.equal((await m.status(j.job_id)).status,'cancelled');
 await assert.rejects(()=>m.start('grok_ask',input),/shutting down/);
});
test('partial success is persisted as failed with successful results and handoff preserved',async()=>{
 const {dir,input}=await fixture();const result={outcome:'partial_success',error:'claude: quota exhausted',errorKind:'quota_exhausted',successCount:1,failureCount:1,results:[{provider:'grok',text:'completed portion',error:null},{provider:'claude',text:'partial portion',error:'quota exhausted',sessionId:'fixture',usage:{totalTokens:12}}],handoff:{requiresWorkspaceReview:true,cwd:dir}};
 const m=new JobManager(path.join(dir,'jobs'),async()=>result);
 const j=await m.start('agent_implement',input);const finished=await done(m,j.job_id);
 assert.equal(finished.status,'failed');assert.equal(finished.result.outcome,'partial_success');assert.equal(finished.result.successCount,1);assert.equal(finished.result.results[1].usage.totalTokens,12);assert.equal(finished.result.handoff.requiresWorkspaceReview,true);
 const restarted=new JobManager(path.join(dir,'jobs'),async()=>{throw Error('Do not resume automatically');});
 assert.equal((await restarted.status(j.job_id)).result.results[0].text,'completed portion');await m.close();await restarted.close();
});
