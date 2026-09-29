import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolveGitExecutable} from '../src/git-read-policy.js';
import {createManagedWorktree,cleanupManagedWorktree,type ManagedWorktree} from '../src/managed-worktree.js';
import {JobManager} from '../src/jobs.js';
const exec=promisify(execFile);
async function git(cwd:string,...args:string[]){return (await exec(await resolveGitExecutable(),['-c','user.name=Fixture','-c','user.email=fixture@example.invalid',...args],{cwd,windowsHide:true})).stdout.trim();}
async function fixture(name='repo'){const root=await fs.mkdtemp(path.join(os.tmpdir(),'managed-worktree-test-'));const repo=path.join(root,name);await fs.mkdir(repo);await git(repo,'init');await fs.writeFile(path.join(repo,'file.txt'),'base');await git(repo,'add','.');await git(repo,'commit','-m','base');return {root,repo};}
async function finish(m:JobManager,id:string){for(let i=0;i<200;i++){const job=await m.status(id);if(['completed','failed','cancelled'].includes(job.status))return job;await new Promise(r=>setTimeout(r,10));}throw Error('Fixture did not finish');}
test('managed isolation rejects implicit dirty base, maps scope, preserves edits and removes only merged clean work',async()=>{
 const {root,repo}=await fixture();
 await fs.writeFile(path.join(repo,'dirty.txt'),'original only');
 await assert.rejects(()=>createManagedWorktree({cwd:repo,task:'fixture'},randomUUID()),/WORKTREE_BASE_REQUIRED/);
 const created=await createManagedWorktree({cwd:repo,task:'fixture',base_ref:'HEAD',allowed_paths:[path.join(repo,'file.txt')]},randomUUID());
 const w=created.worktree;
 try{
  assert.equal(path.basename(w.path),path.basename(repo));
  assert.equal(path.basename(path.dirname(w.path)),w.branch.slice('agent-acp/'.length));
  assert.equal(created.input.cwd,w.path);
  assert.equal(w.sourceHadChanges,true);assert.equal(created.input.allowed_paths?.[0],path.join(w.path,'file.txt'));
  assert.equal(await fs.stat(path.join(w.path,'dirty.txt')).catch(()=>undefined),undefined);
  await fs.writeFile(path.join(w.path,'file.txt'),'agent change');
  await assert.rejects(()=>cleanupManagedWorktree(w,'HEAD','fixture tests'),/modified/);
  await git(w.path,'add','.');await git(w.path,'commit','-m','agent change');
  await assert.rejects(()=>cleanupManagedWorktree(w,'HEAD','fixture tests'),/Original workspace/);
  await fs.unlink(path.join(repo,'dirty.txt'));
  await assert.rejects(()=>cleanupManagedWorktree(w,'HEAD','fixture tests'),/not merged/);
  await git(repo,'merge','--ff-only',w.branch);
  await fs.writeFile(path.join(w.path,'.gitignore'),'generated/\n');await git(w.path,'add','.gitignore');await git(w.path,'commit','-m','ignore generated');await git(repo,'merge','--ff-only',w.branch);
  await fs.mkdir(path.join(w.path,'generated'));await fs.writeFile(path.join(w.path,'generated','result.txt'),'build output');
  await assert.rejects(()=>cleanupManagedWorktree(w,'HEAD','tests'),/ignored files/);
  await fs.unlink(path.join(w.path,'generated','result.txt'));await fs.rmdir(path.join(w.path,'generated'));
  const cleaned=await cleanupManagedWorktree(w,'HEAD','verified fixture content');
  assert.equal(cleaned.state,'removed');assert.equal(await fs.stat(w.path).catch(()=>undefined),undefined);
  assert.equal(await fs.stat(path.dirname(w.path)).catch(()=>undefined),undefined);
  assert.equal(await fs.readFile(path.join(repo,'file.txt'),'utf8'),'agent change');
 }finally{if(await fs.stat(w.path).catch(()=>undefined)){await git(repo,'worktree','remove',w.path);}await fs.rm(root,{recursive:true,force:true});}
});
test('managed worktree preserves the original repository name when cwd is a subdirectory',async()=>{
 for(const name of ['case-ops','Project With Spaces']){
  const {root,repo}=await fixture(name);const nested=path.join(repo,'nested');await fs.mkdir(nested);await fs.writeFile(path.join(nested,'item.txt'),'nested');await git(repo,'add','.');await git(repo,'commit','-m','nested');
  const created=await createManagedWorktree({cwd:nested,task:'fixture',allowed_paths:['item.txt']},randomUUID());const w=created.worktree;
  try{
   assert.equal(path.basename(w.path),path.basename(repo));
   assert.equal(created.input.cwd,path.join(w.path,'nested'));
   assert.equal(created.input.allowed_paths?.[0],path.join(w.path,'nested','item.txt'));
   assert.equal(await fs.readFile(path.join(created.input.cwd,'item.txt'),'utf8'),'nested');
   assert.equal((await cleanupManagedWorktree(w,'HEAD','verified nested fixture')).state,'removed');
  }finally{if(await fs.stat(w.path).catch(()=>undefined))await git(repo,'worktree','remove',w.path);await fs.rm(root,{recursive:true,force:true});}
 }
});
test('cleanup accepts a previously recorded legacy UUID worktree root',async()=>{
 const {root,repo}=await fixture();const id=randomUUID(),branch='agent-acp/'+id;
 const target=path.join(os.tmpdir(),'agent-acp-worktrees',id);
 await fs.mkdir(path.dirname(target),{recursive:true});await git(repo,'worktree','add','-b',branch,target,'HEAD');
 const w:ManagedWorktree={originalCwd:repo,repository:repo,path:target,branch,baseCommit:await git(repo,'rev-parse','HEAD'),sourceHadChanges:false,state:'preserved'};
 try{assert.equal((await cleanupManagedWorktree(w,'HEAD','verified legacy fixture')).state,'removed');assert.equal(await fs.stat(target).catch(()=>undefined),undefined);}
 finally{if(await fs.stat(target).catch(()=>undefined))await git(repo,'worktree','remove',target);await fs.rm(root,{recursive:true,force:true});}
});
test('invalid UUID and ownership paths cannot create or remove a worktree',async()=>{
 const {root,repo}=await fixture();
 try{
  for(const invalid of ['not-a-uuid','../'+randomUUID(),randomUUID()+'/extra'])await assert.rejects(()=>createManagedWorktree({cwd:repo,task:'fixture'},invalid),/Invalid managed worktree UUID/);
  const created=await createManagedWorktree({cwd:repo,task:'fixture'},randomUUID());const w=created.worktree;
  try{
   await assert.rejects(()=>cleanupManagedWorktree({...w,branch:'agent-acp/not-a-uuid'},'HEAD','verified'),/ownership check failed/);
   await assert.rejects(()=>cleanupManagedWorktree({...w,path:path.dirname(w.path)},'HEAD','verified'),/ownership check failed/);
   await assert.rejects(()=>cleanupManagedWorktree({...w,path:path.join(w.path,'file.txt')},'HEAD','verified'),/ownership check failed/);
   assert.ok(await fs.stat(w.path));
   assert.equal((await cleanupManagedWorktree(w,'HEAD','verified valid ownership')).state,'removed');
  }finally{if(await fs.stat(w.path).catch(()=>undefined))await git(repo,'worktree','remove',w.path);}
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('failed isolated implementation preserves worktree and blocks managed cleanup',async()=>{
 const {root,repo}=await fixture();const m=new JobManager(path.join(root,'jobs'),async()=>({error:'fixture failure',errorKind:'task_error'}));
 const job=await m.start('agent_implement',{cwd:repo,task:'fixture',workspace_mode:'isolated'});
 try{await finish(m,job.job_id);await assert.rejects(()=>m.cleanupWorktree(job.job_id,'HEAD','reviewed'),/Failed, cancelled/);assert.ok(await fs.stat(job.worktree!.path));}
 finally{await m.close();await git(repo,'worktree','remove',job.worktree!.path);await git(repo,'branch','-D',job.worktree!.branch);await fs.rm(root,{recursive:true,force:true});}
});
test('auto creates worktree only on implementation conflict and cleanup requires completed verification',async()=>{
 const {root,repo}=await fixture();let release!:()=>void;
 const m=new JobManager(path.join(root,'jobs'),async(_kind,input)=>{
  if(input.task==='hold')await new Promise<void>(r=>{release=r;});
  return {error:null,cwd:input.cwd};
 });
 try{
  const first=await m.start('agent_implement',{cwd:repo,task:'hold',workspace_mode:'auto'});
  while(!release)await new Promise(r=>setTimeout(r,5));assert.equal(first.worktree,undefined);
  const second=await m.start('agent_implement',{cwd:repo,task:'isolated',workspace_mode:'auto'});
  assert.ok(second.worktree);assert.notEqual(second.cwd,repo);await finish(m,second.job_id);
  await assert.rejects(()=>m.cleanupWorktree(second.job_id,'HEAD','test verified'),/active job/);
  release();await finish(m,first.job_id);
  await assert.rejects(()=>m.cleanupWorktree(second.job_id,'HEAD',''),/summary/);
  const restarted=new JobManager(path.join(root,'jobs'),async()=>{throw Error('Must not rerun');});
  assert.equal((await restarted.worktreeStatus(second.job_id)).worktree.baseCommit,second.worktree?.baseCommit);
  assert.equal((await restarted.cleanupWorktree(second.job_id,'HEAD','no changes; fixture tests passed')).worktree.state,'removed');
  await restarted.close();
 }finally{release?.();await m.close();await fs.rm(root,{recursive:true,force:true});}
});
