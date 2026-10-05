import test from 'node:test';
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
const exec=promisify(execFile);
const delay=(n:number)=>new Promise(r=>setTimeout(r,n));
async function root(t:any){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'job-operations-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
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
