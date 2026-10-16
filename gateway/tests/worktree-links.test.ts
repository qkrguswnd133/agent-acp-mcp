import './isolated-environment.js';
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolveGitExecutable} from '../src/git-read-policy.js';
import {createManagedWorktree,cleanupManagedWorktree,inspectManagedWorktree,recoverManagedWorktree,type ManagedWorktree} from '../src/managed-worktree.js';
import {inspectWorktreeLinks,prepareWorktreeRemoval} from '../src/worktree-links.js';
import {JobManager} from '../src/jobs.js';

const execute=promisify(execFile),storage=await fs.mkdtemp(path.join(os.tmpdir(),'worktree-link-storage-'));
const priorStorage=process.env.AGENT_MCP_WORKTREE_DIR;process.env.AGENT_MCP_WORKTREE_DIR=storage;
after(async()=>{if(priorStorage===undefined)delete process.env.AGENT_MCP_WORKTREE_DIR;else process.env.AGENT_MCP_WORKTREE_DIR=priorStorage;await fs.rm(storage,{recursive:true,force:true});});
async function git(cwd:string,...args:string[]){return (await execute(await resolveGitExecutable(),['-c','user.name=Fixture','-c','user.email=fixture@example.invalid',...args],{cwd,windowsHide:true})).stdout.trim();}
async function fixture(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'worktree-link-test-')),repo=path.join(root,'repo'),outside=path.join(root,'external-target');
 await fs.mkdir(repo);await fs.mkdir(path.join(outside,'nested'),{recursive:true});
 await fs.writeFile(path.join(outside,'keep.txt'),'external root file');await fs.writeFile(path.join(outside,'nested','keep.txt'),'external nested file');
 await git(repo,'init');await fs.writeFile(path.join(repo,'tracked.txt'),'base');await git(repo,'add','.');await git(repo,'commit','-m','base');
 await fs.writeFile(path.join(repo,'.git','info','exclude'),'external\nnested/external\n');
 const {worktree:w}=await createManagedWorktree({cwd:repo,task:'temporary link fixture'},randomUUID());
 return {root,repo,outside,w};
}
async function snapshot(root:string):Promise<unknown>{
 const stat=await fs.lstat(root);
 if(!stat.isDirectory()||stat.isSymbolicLink())return {size:stat.size,mtimeMs:stat.mtimeMs};
 return {mtimeMs:stat.mtimeMs,children:await Promise.all((await fs.readdir(root)).sort().map(async name=>({name,data:await snapshot(path.join(root,name))})))};
}
async function dispose(root:string,repo:string,w:ManagedWorktree){
 if(await fs.lstat(w.path).catch(()=>undefined)){
  // Remove only fixture-owned links before Git receives any worktree path.
  const links=await inspectWorktreeLinks(w.path,{verbose:true});assert.equal(links.linksScanComplete,true);
  for(const link of links.links)await fs.unlink(link.path);
  await git(w.path,'restore','--source=HEAD','--staged','--worktree','.');
  await git(repo,'worktree','remove',w.path);
 }
 await fs.rm(root,{recursive:true,force:true});
}

test('provider completion reports external link handoff and MCP cleanup evidence without changing its target',async()=>{
 const f=await fixture();await cleanupManagedWorktree(f.w,'','');const before=await snapshot(f.outside);
 const manager=new JobManager(path.join(f.root,'jobs'),async(_kind,input)=>{await fs.symlink(f.outside,path.join(input.cwd,'external'),'junction');return {error:null,text:'Fixture implementation completed'};});let worktree=f.w;
 try{
  const accepted=await manager.start('agent_implement',{cwd:f.repo,task:'fixture',completion_criteria:'retain link for parent review',workspace_mode:'isolated'});worktree=accepted.worktree!;
  const done=await manager.wait(accepted.job_id,25,true);assert.equal(done.status,'completed');assert.equal(done.result.handoff.requiresWorkspaceReview,true);assert.equal(done.result.handoff.worktreeLinkWarning.outsideWorktreeLinkCount,1);
  await assert.rejects(manager.cleanupWorktree(accepted.job_id,'HEAD','',{dryRun:true}),error=>{assert.equal((error as any).linkCount,1);assert.equal((error as any).links[0].outsideWorktree,true);return true;});assert.deepEqual(await snapshot(f.outside),before);
 }finally{await manager.close();await dispose(f.root,f.repo,worktree);}
});

for(const [name,type,relative] of [['root junction','junction','external'],['nested junction','junction','nested/external'],['directory symlink','dir','external']] as const){
 test('cleanup refuses '+name+' by default and opt-in preserves its temporary target',async t=>{
  const {root,repo,outside,w}=await fixture(),link=path.join(w.path,relative);
  try{
   await fs.mkdir(path.dirname(link),{recursive:true});
   try{await fs.symlink(outside,link,type);}catch(error:any){if(type==='dir'&&['EPERM','EACCES'].includes(error.code)){t.skip('Directory symlinks require Windows developer mode or privilege');return;}throw error;}
   const before=await snapshot(outside),inspection=await inspectManagedWorktree(w);
   assert.ok('links' in inspection);assert.deepEqual(inspection.links,[{path:link,target:outside,outsideWorktree:true}]);
   assert.equal(inspection.linksScanComplete,true);
   const refused=await cleanupManagedWorktree(w,'','',{dryRun:true,removeIgnoredArtifacts:false});
   assert.equal(refused.eligible,false);assert.equal(refused.linkCount,1);assert.equal(refused.links?.[0].path,link);assert.match(refused.reason!,/symlink or junction/);
   await assert.rejects(()=>cleanupManagedWorktree(w,'','',{removeIgnoredArtifacts:false}),(error:any)=>error.linkCount===1&&error.links[0].outsideWorktree===true);
   assert.deepEqual(await snapshot(outside),before);assert.ok(await fs.lstat(link));
   const preview=await cleanupManagedWorktree(w,'','',{dryRun:true,removeIgnoredArtifacts:false,unlinkLinks:true});
   assert.equal(preview.eligible,true,preview.reason);assert.ok(await fs.lstat(link));
   const result=await cleanupManagedWorktree(w,'','',{removeIgnoredArtifacts:false,unlinkLinks:true});
   assert.equal(result.state,'removed');assert.deepEqual(result.unlinkedPaths,[link]);assert.equal(result.linkTargetIntegrityVerified,true);
   assert.deepEqual(await snapshot(outside),before);assert.equal(await fs.lstat(w.path).catch(()=>undefined),undefined);
   assert.equal(await fs.readFile(path.join(outside,'nested','keep.txt'),'utf8'),'external nested file');
  }finally{await dispose(root,repo,w);}
 });
}

test('inspection bounds output, does not walk junction targets, and marks incomplete scans',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'link-inspection-test-')),worktree=path.join(root,'worktree'),outside=path.join(root,'outside');
 try{
  await fs.mkdir(worktree);await fs.mkdir(outside);await fs.writeFile(path.join(outside,'file.txt'),'kept');
  for(let i=0;i<25;i++)await fs.symlink(outside,path.join(worktree,'link-'+i),'junction');
  const summary=await inspectWorktreeLinks(worktree);assert.equal(summary.linkCount,25);assert.equal(summary.links.length,20);assert.equal(summary.linksTruncated,true);assert.equal(summary.entriesScanned,26);
  const full=await inspectWorktreeLinks(worktree,{verbose:true});assert.equal(full.links.length,25);assert.equal(full.linksTruncated,false);
  const bounded=await inspectWorktreeLinks(worktree,{maxEntries:2});assert.equal(bounded.linksScanComplete,false);assert.ok(bounded.linksScanErrors.length);
 }finally{
  for(const name of await fs.readdir(worktree))await fs.unlink(path.join(worktree,name));
  await fs.rm(root,{recursive:true,force:true});
 }
});

test('incomplete scan refuses mutation and returns the failing path',async t=>{
 const {root,repo,outside,w}=await fixture(),lstat=fs.lstat.bind(fs),blocked=path.join(w.path,'tracked.txt');
 try{
  t.mock.method(fs,'lstat',async(...args:any[])=>{if(String(args[0])===blocked)throw Object.assign(Error('fixture access denied'),{code:'EACCES'});return (lstat as any)(...args);});
  const result=await cleanupManagedWorktree(w,'','',{dryRun:true});assert.equal(result.eligible,false);assert.equal(result.linksScanComplete,false);assert.ok(result.linksScanErrors?.some(error=>error.includes(blocked)));
  await assert.rejects(()=>cleanupManagedWorktree(w,'',''),/Incomplete worktree link scan/);
  assert.equal(await fs.readFile(path.join(outside,'keep.txt'),'utf8'),'external root file');
 }finally{t.mock.restoreAll();await dispose(root,repo,w);}
});

test('link inspection refuses a redirected ancestor before enumerating its target',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'link-ancestor-test-')),actual=path.join(root,'actual'),alias=path.join(root,'alias');
 try{
  await fs.mkdir(path.join(actual,'checkout'),{recursive:true});await fs.writeFile(path.join(actual,'checkout','keep.txt'),'external fixture');
  await fs.symlink(actual,alias,'junction');
  const result=await inspectWorktreeLinks(path.join(alias,'checkout'));
  assert.equal(result.linksScanComplete,false);assert.equal(result.entriesScanned,0);assert.ok(result.linksScanErrors.some(error=>error.includes('ancestor')));
  await assert.rejects(()=>prepareWorktreeRemoval(path.join(alias,'checkout'),{unlinkLinks:true}),/Incomplete worktree link scan/);
  assert.equal(await fs.readFile(path.join(actual,'checkout','keep.txt'),'utf8'),'external fixture');
 }finally{await fs.unlink(alias).catch(()=>{});await fs.rm(root,{recursive:true,force:true});}
});

for(const recovery of [false,true])test('fresh final scan blocks a junction introduced immediately before '+(recovery?'recovery removal':'cleanup removal'),async()=>{
 const {root,repo,outside,w}=await fixture(),link=path.join(w.path,'external');
 let mutations=0;
 try{
  const before=await snapshot(outside);
  if(recovery)await fs.unlink(path.join(w.path,'tracked.txt'));
  const beforeMutation=async()=>{if(++mutations===(recovery?2:1))await fs.symlink(outside,link,'junction');};
  await assert.rejects(()=>recovery?recoverManagedWorktree(w,'Reviewed metadata-only fixture',{action:'remove',beforeMutation}):cleanupManagedWorktree(w,'','',{beforeMutation}),/symlink or junction/);
  assert.ok(await fs.lstat(w.path));assert.deepEqual(await snapshot(outside),before);
 }finally{await dispose(root,repo,w);}
});

test('recovery remove can explicitly unlink an untracked junction while retaining the branch and target',async()=>{
 const {root,repo,outside,w}=await fixture(),link=path.join(w.path,'external');
 try{
  await fs.unlink(path.join(w.path,'tracked.txt'));await fs.symlink(outside,link,'junction');const before=await snapshot(outside);
  const refused=await recoverManagedWorktree(w,'reviewed',{action:'remove',dryRun:true});assert.equal(refused.eligible,false);assert.equal(refused.linkCount,1);
  const preview=await recoverManagedWorktree(w,'reviewed',{action:'remove',dryRun:true,unlinkLinks:true});assert.equal(preview.eligible,true,preview.reason);
  const result=await recoverManagedWorktree(w,'reviewed missing fixture files',{action:'remove',unlinkLinks:true});assert.equal(result.state,'removed');assert.equal(result.recoveryBranchPreserved,true);
  assert.equal(await git(repo,'rev-parse',w.branch),w.baseCommit);assert.deepEqual(await snapshot(outside),before);
 }finally{await dispose(root,repo,w);}
});

test('unlink refuses to proceed when external target metadata changed',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'link-integrity-test-')),worktree=path.join(root,'worktree'),outside=path.join(root,'outside');
 try{
  await fs.mkdir(worktree);await fs.mkdir(outside);await fs.symlink(outside,path.join(worktree,'external'),'junction');
  await assert.rejects(()=>prepareWorktreeRemoval(worktree,{unlinkLinks:true,beforeMutation:async()=>{await fs.writeFile(path.join(outside,'concurrent.txt'),'other writer');}}),(error:any)=>/metadata changed/.test(error.message)&&error.unlinkedPaths.length===1);
  assert.ok(await fs.lstat(worktree));assert.equal(await fs.readFile(path.join(outside,'concurrent.txt'),'utf8'),'other writer');
 }finally{await fs.unlink(path.join(worktree,'external')).catch(()=>{});await fs.rm(root,{recursive:true,force:true});}
});
