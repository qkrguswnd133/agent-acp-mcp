import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {JobManager} from '../src/jobs.js';
import {persistJobPayload} from '../src/job-payload.js';
import {createManagedWorktree} from '../src/managed-worktree.js';
import {resolveGitExecutable} from '../src/git-read-policy.js';
import {verifyInterruptedOwnership} from '../src/interrupted-ownership.js';
const exec=promisify(execFile);
const testStorage=await fs.mkdtemp(path.join(os.tmpdir(),'job-operations-worktrees-'));
const previousStorage=process.env.AGENT_MCP_WORKTREE_DIR;
process.env.AGENT_MCP_WORKTREE_DIR=testStorage;
after(async()=>{if(previousStorage===undefined)delete process.env.AGENT_MCP_WORKTREE_DIR;else process.env.AGENT_MCP_WORKTREE_DIR=previousStorage;await fs.rm(testStorage,{recursive:true,force:true});});
const delay=(n:number)=>new Promise(r=>setTimeout(r,n));
async function root(t:any){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'job-operations-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
async function fixtureGit(cwd:string,...args:string[]){return (await exec(await resolveGitExecutable(),['-c','user.name=Fixture','-c','user.email=fixture@example.invalid',...args],{cwd,windowsHide:true})).stdout.trim();}
async function maintenanceFixture(t:any,ownershipVerifier?:typeof verifyInterruptedOwnership){
 const dir=await root(t),repo=path.join(dir,'repo'),jobs=path.join(dir,'jobs');await fs.mkdir(repo);await fs.mkdir(jobs);
 await fixtureGit(repo,'init');await fs.mkdir(path.join(repo,'nested'));await fs.writeFile(path.join(repo,'nested','base.txt'),'base');await fixtureGit(repo,'add','.');await fixtureGit(repo,'commit','-m','base');
 const id=randomUUID(),created=await createManagedWorktree({cwd:path.join(repo,'nested'),task:'fixture'},id),file=path.join(jobs,id+'.json');
 const record={job_id:id,kind:'agent_implement',cwd:created.input.cwd,ownerPid:process.pid,status:'completed',startedAt:'2020-01-01T00:00:00Z',lastActivityAt:'2020-01-01T00:00:00Z',finishedAt:'2020-01-01T00:00:01Z',worktree:created.worktree,activity:{cwd:created.input.cwd,event:'historical'},result:{error:null,results:[{provider:'grok',sessionId:'historical-session',cwd:created.input.cwd,text:'completed'}]}};
 await fs.writeFile(file,JSON.stringify(record));
 const m=new JobManager(jobs,async()=>{throw Error('No replay');},undefined,ownershipVerifier);
 return {dir,repo,jobs,id,file,record,m,w:created.worktree};
}
async function disposeFixture(f:Awaited<ReturnType<typeof maintenanceFixture>>){
 await f.m.close();const record=JSON.parse(await fs.readFile(f.file,'utf8'));
 if(await fs.stat(record.worktree.path).catch(()=>undefined)){await fixtureGit(record.worktree.path,'restore','--source=HEAD','--staged','--worktree','.');await fixtureGit(f.repo,'worktree','remove',record.worktree.path);}
}
test('wait returns completion or timeout and aborting the wait never cancels the job',async t=>{
 const dir=await root(t);let release!:(v:any)=>void;let taskSignal!:AbortSignal;
 const m=new JobManager(path.join(dir,'jobs'),async(_kind,_input,signal)=>{taskSignal=signal;return new Promise(r=>release=r);});
 const job=await m.start('agent_ask',{cwd:dir,task:'fixture'});while(!release)await delay(1);
 assert.equal((await m.wait(job.job_id,0)).wait.timed_out,true);assert.equal(taskSignal.aborted,false);
 const abort=new AbortController();const waiting=m.wait(job.job_id,3,false,abort.signal);abort.abort();assert.equal((await waiting).wait.cancelled,true);assert.equal(taskSignal.aborted,false);
 const completed=m.wait(job.job_id,3);release({error:null,text:'done'});assert.equal((await completed).wait.completed,true);await m.close();
});
test('wait observes another live process completing its persisted job',async t=>{
 const dir=await root(t),jobs=path.join(dir,'jobs'),id=randomUUID();await fs.mkdir(jobs);
 const file=path.join(jobs,id+'.json');
 const child=spawn(process.execPath,['--input-type=module','-e',`import fs from 'node:fs';const job={job_id:${JSON.stringify(id)},cwd:${JSON.stringify(dir)},kind:'agent_ask',ownerPid:process.pid,status:'running',startedAt:new Date().toISOString(),lastActivityAt:new Date().toISOString()};fs.writeFileSync(${JSON.stringify(file)},JSON.stringify(job));process.stdout.write('ready');setTimeout(()=>{job.status='completed';fs.writeFileSync(${JSON.stringify(file)},JSON.stringify(job));},300);setTimeout(()=>process.exit(0),1400);`],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 t.after(()=>{if(child.exitCode===null)child.kill();});await new Promise<void>((r,j)=>{child.stdout.once('data',()=>r());child.once('error',j);});
 const m=new JobManager(jobs,async()=>{throw Error('No replay');});const result=await m.wait(id,3);assert.equal(result.status,'completed');assert.equal(result.wait.completed,true);await m.close();
});
test('large persisted results have compact status and lossless explicit verbose output',async t=>{
 const dir=await root(t),m=new JobManager(path.join(dir,'jobs'),async()=>({error:'original failure',errorKind:'task_error',results:[{provider:'codex',sessionId:'known',usage:{totalTokens:9},text:'summary',rawEvents:'x'.repeat(764000),commandExecutions:[{command:'git show',exitCode:0,output:'界'.repeat(240000)}]}]}));
 const started=await m.start('agent_review',{cwd:dir,task:'fixture'});await m.wait(started.job_id,5);await m.close();
 const small=await m.status(started.job_id);assert(Buffer.byteLength(JSON.stringify(small))<=65536);assert.equal(small.result.error,'original failure');assert.ok(small.payload.artifact);
 const full=await m.status(started.job_id,true);assert.equal(full.result.results[0].rawEvents.length,764000);assert.equal(full.result.results[0].commandExecutions[0].output.length,240000);assert.equal(full.result.results[0].usage.totalTokens,9);
});
test('bulk dry-run preserves worktrees; apply removes only eligible targets; original edits survive',async t=>{
 const dir=await root(t),repo=path.join(dir,'repo'),jobs=path.join(dir,'jobs');await fs.mkdir(repo);await fs.mkdir(jobs);
 const git=async(cwd:string,...args:string[])=>(await exec(await resolveGitExecutable(),['-c','user.name=Fixture','-c','user.email=fixture@example.invalid',...args],{cwd,windowsHide:true})).stdout.trim();
 await git(repo,'init');await fs.writeFile(path.join(repo,'base.txt'),'base');await git(repo,'add','.');await git(repo,'commit','-m','base');
 const entries=[];
 for(const status of ['failed','completed']){const id=randomUUID(),created=await createManagedWorktree({cwd:repo,task:'fixture'},id);entries.push({id,w:created.worktree});await fs.writeFile(path.join(jobs,id+'.json'),JSON.stringify({job_id:id,kind:'agent_implement',cwd:created.input.cwd,ownerPid:process.pid,status,startedAt:'2020-01-01T00:00:00Z',lastActivityAt:'2020-01-01T00:00:00Z',worktree:{...created.worktree,createdAt:'2020-01-01T00:00:00Z'},result:{error:status==='failed'?'failed':null}}));}
 const [empty,dirty]=entries;await fs.writeFile(path.join(dirty.w.path,'untracked.txt'),'preserve');await fs.writeFile(path.join(repo,'unrelated.txt'),'user data');
 const m=new JobManager(jobs,async()=>{throw Error('No replay');});
 try{
  const listed=await m.listWorktrees();assert.equal(listed.total,2);assert.equal(listed.items.length,2);assert.equal((await m.worktreeWarnings()).count,2);
  const preview=await m.cleanupWorktrees(entries.map(e=>e.id),'HEAD','',{dryRun:true,verified:false});assert.deepEqual(preview.results.map(r=>r.ok),[true,false]);assert.ok(await fs.stat(empty.w.path));
  const emptyFile=path.join(jobs,empty.id+'.json'),original=await fs.readFile(emptyFile,'utf8'),evidence=JSON.parse(original);
  evidence.result={error:'child still alive',results:[{provider:'grok',childCleanedUp:false,rawEvents:'x'.repeat(80000)}]};
  const archived=await persistJobPayload(evidence,jobs);await fs.writeFile(emptyFile,JSON.stringify(archived));
  await assert.rejects(m.cleanupWorktree(empty.id,'HEAD',''),/child cleanup/);
  await fs.unlink(path.join(jobs,archived.payload.artifact.path));
  await assert.rejects(m.cleanupWorktree(empty.id,'HEAD',''),/Full job evidence/);
  await fs.writeFile(emptyFile,original);
  const result=await m.cleanupWorktrees(entries.map(e=>e.id),'HEAD','',{verified:false});assert.deepEqual(result.results.map(r=>r.ok),[true,false]);assert.match((result.results[1] as any).reason,/untracked/);assert.equal(await fs.readFile(path.join(repo,'unrelated.txt'),'utf8'),'user data');assert.equal((await m.worktreeWarnings()).count,1);
 }finally{await m.close();for(const e of entries){if(await fs.stat(e.w.path).catch(()=>undefined)){await fs.unlink(path.join(e.w.path,'untracked.txt')).catch(()=>{});await git(repo,'worktree','remove',e.w.path);await git(repo,'update-ref','-d','refs/heads/'+e.w.branch,e.w.baseCommit);}}}
});

test('maintenance migration dry-run is read-only and apply updates cwd while retaining result history',async t=>{
 const f=await maintenanceFixture(t),targetRoot=path.join(f.dir,'persistent'),before=await fs.readFile(f.file,'utf8');
 try{
  await fs.writeFile(path.join(f.w.path,'nested','base.txt'),'unfinished edit');
  const preview=await f.m.worktreeMaintenance(f.id,'migrate',{dryRun:true,targetRoot});assert.equal('dry_run' in preview&&preview.dry_run,true);assert.equal('eligible' in preview.worktree&&preview.worktree.eligible,true);assert.equal(await fs.readFile(f.file,'utf8'),before);assert.equal(await fs.stat(targetRoot).catch(()=>undefined),undefined);
  const applied=await f.m.worktreeMaintenance(f.id,'migrate',{targetRoot});assert.ok('restartRequired' in applied&&applied.restartRequired);assert.notEqual(applied.worktree.path,f.w.path);
  const saved=JSON.parse(await fs.readFile(f.file,'utf8'));assert.equal(saved.cwd,path.join(applied.worktree.path,'nested'));assert.equal(saved.worktree.originalCwd,f.w.originalCwd);assert.deepEqual(saved.result,f.record.result);assert.deepEqual(saved.activity,f.record.activity);assert.equal(saved.worktreeMigration.previousCwd,f.record.cwd);assert.equal(saved.worktreeMigration.currentCwd,saved.cwd);assert.equal(saved.worktreeMigration.restartRequired,true);assert.equal(await fs.readFile(path.join(saved.cwd,'base.txt'),'utf8'),'unfinished edit');assert.equal(await fs.readFile(path.join(f.repo,'nested','base.txt'),'utf8'),'base');
  assert.equal(await fs.stat(f.w.path).catch(()=>undefined),undefined);assert.equal(await fs.stat(f.file+'.cleanup.lock').catch(()=>undefined),undefined);
 }finally{await disposeFixture(f);}
});

test('maintenance requires terminal idle ownership and confirmed child cleanup',async t=>{
 const f=await maintenanceFixture(t),targetRoot=path.join(f.dir,'persistent');
 try{
  for(const status of ['running','queued','cancelling','interrupted']){
   await fs.writeFile(f.file,JSON.stringify({...f.record,status}));await assert.rejects(()=>f.m.worktreeMaintenance(f.id,'migrate',{dryRun:true,targetRoot}),/finished.*idle|owner process is still alive/);
  }
  await fs.writeFile(f.file,JSON.stringify({...f.record,result:{error:null,results:[{childCleanedUp:false}]}}));await assert.rejects(()=>f.m.worktreeMaintenance(f.id,'migrate',{dryRun:true,targetRoot}),/child cleanup/);
  await fs.writeFile(f.file,JSON.stringify(f.record));const otherId=randomUUID(),otherFile=path.join(f.jobs,otherId+'.json');
  for(const cwd of [f.w.originalCwd,f.w.path]){
   await fs.writeFile(otherFile,JSON.stringify({job_id:otherId,kind:'agent_implement',status:'running',cwd,ownerPid:process.pid}));await assert.rejects(()=>f.m.worktreeMaintenance(f.id,'migrate',{dryRun:true,targetRoot}),/active job/);
  }
  // Completion can be persisted before provider/job finalization has finished.
  const finalizing={job_id:otherId,kind:'agent_implement',status:'completed',cwd:f.w.originalCwd,ownerPid:process.pid};await fs.writeFile(otherFile,JSON.stringify(finalizing));
  (f.m as any).active.set(otherId,{job:finalizing,finalizing:true,done:Promise.resolve(),controller:new AbortController()});
  try{await assert.rejects(()=>f.m.worktreeMaintenance(f.id,'migrate',{dryRun:true,targetRoot}),/active job|finalizing/);}finally{(f.m as any).active.delete(otherId);}
  await fs.unlink(otherFile);await fs.writeFile(f.file,JSON.stringify({...f.record,status:'failed',result:{error:'task failed'}}));const preview=await f.m.worktreeMaintenance(f.id,'migrate',{dryRun:true,targetRoot});assert.ok('eligible' in preview.worktree&&preview.worktree.eligible);
 }finally{await disposeFixture(f);}
});

test('migration rolls back physical checkout when saving updated job metadata fails',async t=>{
 const f=await maintenanceFixture(t),targetRoot=path.join(f.dir,'persistent'),before=await fs.readFile(f.file,'utf8');const originalSave=(f.m as any).save;
 try{
  await fs.writeFile(path.join(f.w.path,'nested','base.txt'),'preserved dirty edit');(f.m as any).save=async()=>{throw Error('simulated metadata write failure');};
  await assert.rejects(()=>f.m.worktreeMaintenance(f.id,'migrate',{targetRoot}),/rolled back.*metadata save failed/);
  assert.equal(await fs.readFile(f.file,'utf8'),before);assert.equal(await fs.readFile(path.join(f.w.path,'nested','base.txt'),'utf8'),'preserved dirty edit');assert.equal(await fs.stat(path.join(targetRoot,f.id,'repo')).catch(()=>undefined),undefined);assert.equal(await fs.stat(f.file+'.cleanup.lock').catch(()=>undefined),undefined);
 }finally{(f.m as any).save=originalSave;await disposeFixture(f);}
});

test('damaged checkout recovery requires acknowledgement and retains branch on restore or remove',async t=>{
 for(const action of ['restore','remove'] as const){
  const f=await maintenanceFixture(t);
  try{
   await fs.unlink(path.join(f.w.path,'nested','base.txt'));await fs.rmdir(path.join(f.w.path,'nested'));
   const before=await fs.readFile(f.file,'utf8'),preview=await f.m.worktreeMaintenance(f.id,action,{dryRun:true});assert.ok('eligible' in preview.worktree&&preview.worktree.eligible);assert.equal(await fs.readFile(f.file,'utf8'),before);
   await assert.rejects(()=>f.m.cleanupWorktree(f.id,'HEAD',''),/damaged/);await assert.rejects(()=>f.m.worktreeMaintenance(f.id,action,{summary:'reviewed'}),/verified=true/);await assert.rejects(()=>f.m.worktreeMaintenance(f.id,action,{verified:true}),/summary/);
   const result=await f.m.worktreeMaintenance(f.id,action,{verified:true,summary:'Missing tracked files reviewed; retain branch'});assert.equal(result.worktree.state,action==='remove'?'removed':'preserved');assert.equal(result.worktree.recoveryBranchPreserved,true);assert.equal(await fixtureGit(f.repo,'rev-parse',f.w.branch),f.w.baseCommit);
   const saved=JSON.parse(await fs.readFile(f.file,'utf8'));assert.equal(saved.worktree.state,result.worktree.state);assert.deepEqual(saved.result,f.record.result);
   if(action==='restore')assert.equal(await fs.readFile(path.join(f.w.path,'nested','base.txt'),'utf8'),'base');
  }finally{await disposeFixture(f);}
 }
});

test('list100 inventory is compact, paginated and scans disk only when requested',async t=>{
 const f=await maintenanceFixture(t);
 try{
  for(let i=0;i<99;i++){const id=randomUUID();await fs.writeFile(path.join(f.jobs,id+'.json'),JSON.stringify({...f.record,job_id:id,worktree:{...f.w,path:path.join(testStorage,id,'repo'),branch:'agent-acp/'+id}}));}
  const started=performance.now(),list=await f.m.listWorktrees(0,100);t.diagnostic(`list100 completed in ${Math.round(performance.now()-started)} ms (one real checkout and 99 missing-path records)`);assert.equal(list.total,100);assert.equal(list.items.length,100);assert.equal(list.next_offset,null);assert.equal(list.include_disk_size,false);assert.ok(list.items.every(item=>item.worktree&&!('diskBytes' in item.worktree)&&!('changes' in item.worktree)&&!('changedFiles' in item.worktree)));
  const actualIndex=list.items.findIndex(item=>item.job_id===f.id),page=await f.m.listWorktrees(actualIndex,1,false,true);assert.equal(page.include_disk_size,true);assert.equal(page.items[0].job_id,f.id);assert.ok(page.items[0].worktree.diskBytes>0);assert.equal(page.items[0].worktree.diskBytesComplete,true);assert.equal(page.next_offset,actualIndex+1<100?actualIndex+1:null);
  const status=await f.m.worktreeStatus(f.id);assert.equal('diskBytes' in status.worktree,false);const diskStatus=await f.m.worktreeStatus(f.id,true);assert.ok('diskBytes' in diskStatus.worktree&&diskStatus.worktree.diskBytes!==undefined&&diskStatus.worktree.diskBytes>0);
 }finally{await disposeFixture(f);}
});

test('JobManager patch-equivalent cleanup forwards opt-in and requires parent verification',async t=>{
 const f=await maintenanceFixture(t);
 try{
  await fs.writeFile(path.join(f.w.path,'nested','base.txt'),'integrated patch');await fixtureGit(f.w.path,'add','.');await fixtureGit(f.w.path,'commit','-m','patch');
  await fs.writeFile(path.join(f.repo,'original.txt'),'diverged');await fixtureGit(f.repo,'add','.');await fixtureGit(f.repo,'commit','-m','diverge');await fixtureGit(f.repo,'cherry-pick',f.w.branch);
  await assert.rejects(()=>f.m.cleanupWorktree(f.id,'HEAD','tests passed',{verified:true}),/not merged/);
  const preview=await f.m.cleanupWorktree(f.id,'HEAD','tests passed',{dryRun:true,allowPatchEquivalent:true});assert.equal(preview.worktree.integrationMethod,'patch-equivalent');assert.equal(preview.worktree.state,'preserved');
  await assert.rejects(()=>f.m.cleanupWorktree(f.id,'HEAD','tests passed',{verified:false,allowPatchEquivalent:true}),/Parent verification/);
  const result=await f.m.cleanupWorktree(f.id,'HEAD','tests passed',{verified:true,allowPatchEquivalent:true});assert.equal(result.worktree.state,'removed');assert.equal(result.worktree.integrationMethod,'patch-equivalent');assert.equal(JSON.parse(await fs.readFile(f.file,'utf8')).worktree.integrationMethod,'patch-equivalent');
 }finally{await disposeFixture(f);}
});

test('list100 completes full healthy checkout inspections without disk estimates',{skip:process.env.AGENT_MCP_WORKTREE_BENCHMARK!=='1'},async t=>{
 const f=await maintenanceFixture(t);
 try{
  // Shared fixture contents isolate inspection overhead from worktree creation.
  // Every record still performs the full ownership, registration and Git checks.
  for(let i=0;i<99;i++){const id=randomUUID();await fs.writeFile(path.join(f.jobs,id+'.json'),JSON.stringify({...f.record,job_id:id}));}
  const started=performance.now(),list=await f.m.listWorktrees(0,100);t.diagnostic(`list100 full inspections completed in ${Math.round(performance.now()-started)} ms (100 records sharing a healthy checkout)`);
  assert.equal(list.items.length,100);assert.ok(list.items.every(item=>!item.error&&item.worktree.checkoutState==='complete'&&item.worktree.missingTrackedFileCount===0&&!('diskBytes' in item.worktree)));
 }finally{await disposeFixture(f);}
});

test('interrupted migration requires fresh ownership evidence and explicit idle acknowledgement, preserving history',async t=>{
 const scans:unknown[]=[];const f=await maintenanceFixture(t,async input=>{scans.push(input);return {ownerAbsent:true,processScan:'passed',checkedAt:'2026-01-01T00:00:00Z'};});
 const targetRoot=path.join(f.dir,'persistent'),record={...f.record,status:'running',ownerPid:2147483647,result:{error:'historical partial result',childCleanedUp:false,results:[{provider:'grok',sessionId:'old-session',childCleanedUp:false}]}};await fs.writeFile(f.file,JSON.stringify(record));
 try{
  const before=await fs.readFile(f.file,'utf8'),preview=await f.m.worktreeMaintenance(f.id,'migrate',{dryRun:true,targetRoot});assert.ok('requires_idle_confirmation' in preview&&preview.requires_idle_confirmation);assert.ok('idleCheck' in preview&&preview.idleCheck?.ownerAbsent);assert.equal(scans.length,1);assert.equal(await fs.readFile(f.file,'utf8'),before);
  await assert.rejects(()=>f.m.worktreeMaintenance(f.id,'migrate',{targetRoot,summary:'reviewed'}),/idle_confirmed=true/);await assert.rejects(()=>f.m.worktreeMaintenance(f.id,'migrate',{targetRoot,idleConfirmed:true}),/verification summary/);
  await f.m.worktreeMaintenance(f.id,'migrate',{targetRoot,idleConfirmed:true,summary:'Parent confirmed no manually launched workspace writers'});assert.equal(scans.length,2);
  const saved=JSON.parse(await fs.readFile(f.file,'utf8'));assert.equal(saved.status,'running');assert.equal(saved.error,undefined);assert.deepEqual(saved.result,record.result);assert.equal(saved.worktreeIdleCheck.parentConfirmed,true);assert.equal(saved.worktreeIdleCheck.processScan,'passed');assert.equal(saved.worktreeIdleCheck.ownerAbsent,true);assert.equal(saved.worktreeIdleCheck.checkedAt,'2026-01-01T00:00:00Z');
 }finally{await disposeFixture(f);}
});

test('interrupted maintenance blocks unknown or surviving-process evidence even with parent acknowledgement',async t=>{
 for(const reason of ['Process inventory unavailable','Interrupted owner is still alive','Interrupted job has surviving child processes']){
  const f=await maintenanceFixture(t,async()=>{throw Error(reason);});await fs.writeFile(f.file,JSON.stringify({...f.record,status:'interrupted',ownerPid:2147483647}));
  try{
   const before=await fs.readFile(f.file,'utf8');for(const dryRun of [true,false])await assert.rejects(()=>f.m.worktreeMaintenance(f.id,'migrate',{dryRun,targetRoot:path.join(f.dir,'persistent'),idleConfirmed:true,summary:'Parent reviewed idle state'}),new RegExp(reason));
   assert.equal(await fs.readFile(f.file,'utf8'),before);assert.ok(await fs.stat(f.w.path));assert.equal(await fs.stat(f.file+'.cleanup.lock').catch(()=>undefined),undefined);
  }finally{await disposeFixture(f);}
 }
});

test('interrupted recovery uses the same process scan and requires both idle and recovery acknowledgement',async t=>{
 const f=await maintenanceFixture(t,async()=>({ownerAbsent:true,processScan:'passed',checkedAt:'2026-01-01T00:00:00Z'}));await fs.writeFile(f.file,JSON.stringify({...f.record,status:'interrupted',ownerPid:2147483647}));
 try{
  await fs.unlink(path.join(f.w.path,'nested','base.txt'));await fs.rmdir(path.join(f.w.path,'nested'));
  const preview=await f.m.worktreeMaintenance(f.id,'restore',{dryRun:true});assert.ok('requires_idle_confirmation' in preview&&preview.requires_idle_confirmation);
  await assert.rejects(()=>f.m.worktreeMaintenance(f.id,'restore',{verified:true,summary:'Missing files reviewed'}),/idle_confirmed=true/);
  await assert.rejects(()=>f.m.worktreeMaintenance(f.id,'restore',{idleConfirmed:true,summary:'Idle writers reviewed'}),/verified=true/);
  const restored=await f.m.worktreeMaintenance(f.id,'restore',{idleConfirmed:true,verified:true,summary:'Missing files and absence of manual writers reviewed'});assert.equal(restored.worktree.state,'preserved');assert.equal(await fs.readFile(path.join(f.w.path,'nested','base.txt'),'utf8'),'base');assert.equal(JSON.parse(await fs.readFile(f.file,'utf8')).status,'interrupted');
 }finally{await disposeFixture(f);}
});
