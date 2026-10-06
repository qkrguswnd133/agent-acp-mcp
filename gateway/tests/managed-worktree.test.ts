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
import {createManagedWorktree,cleanupManagedWorktree,inspectManagedWorktree,managedWorktreeStorageRoot,migrateManagedWorktree,rollbackManagedWorktreeMigration,recoverManagedWorktree,type ManagedWorktree} from '../src/managed-worktree.js';
import {JobManager} from '../src/jobs.js';
const exec=promisify(execFile);
const testStorage=await fs.mkdtemp(path.join(os.tmpdir(),'managed-worktree-storage-test-'));
const priorStorage=process.env.AGENT_MCP_WORKTREE_DIR;
process.env.AGENT_MCP_WORKTREE_DIR=testStorage;
after(async()=>{if(priorStorage===undefined)delete process.env.AGENT_MCP_WORKTREE_DIR;else process.env.AGENT_MCP_WORKTREE_DIR=priorStorage;await fs.rm(testStorage,{recursive:true,force:true});});
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
  assert.equal(await fs.readFile(path.join(repo,'dirty.txt'),'utf8'),'original only');
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
test('failed isolated implementation preserves modified worktree and blocks managed cleanup',async()=>{
 const {root,repo}=await fixture();const m=new JobManager(path.join(root,'jobs'),async(_kind,input)=>{await fs.writeFile(path.join(input.cwd,'file.txt'),'partial work');return {error:'fixture failure',errorKind:'task_error'};});
 const job=await m.start('agent_implement',{cwd:repo,task:'fixture',workspace_mode:'isolated'});
 try{await finish(m,job.job_id);await assert.rejects(()=>m.cleanupWorktree(job.job_id,'HEAD','reviewed'),/modified, untracked or ignored/);assert.ok(await fs.stat(job.worktree!.path));}
 finally{await m.close();await git(job.worktree!.path,'restore','file.txt');await git(repo,'worktree','remove',job.worktree!.path);await git(repo,'branch','-D',job.worktree!.branch);await fs.rm(root,{recursive:true,force:true});}
});
test('auto creates worktree only on implementation conflict and cleanup requires completed verification',async()=>{
 const {root,repo}=await fixture();let release!:()=>void;
 const m=new JobManager(path.join(root,'jobs'),async(_kind,input)=>{
  if(input.task==='hold')await new Promise<void>(r=>{release=r;});
  else {await fs.writeFile(path.join(input.cwd,'file.txt'),'completed work');await git(input.cwd,'add','.');await git(input.cwd,'commit','-m','completed work');}
  return {error:null,cwd:input.cwd};
 });
 try{
  const first=await m.start('agent_implement',{cwd:repo,task:'hold',workspace_mode:'auto'});
  while(!release)await new Promise(r=>setTimeout(r,5));assert.equal(first.worktree,undefined);
  const second=await m.start('agent_implement',{cwd:repo,task:'isolated',workspace_mode:'auto'});
  assert.ok(second.worktree);assert.notEqual(second.cwd,repo);await finish(m,second.job_id);
  await git(repo,'merge','--ff-only',second.worktree!.branch);
  await assert.rejects(()=>m.cleanupWorktree(second.job_id,'HEAD','test verified',{verified:true}),/active job/);
  release();await finish(m,first.job_id);
  await assert.rejects(()=>m.cleanupWorktree(second.job_id,'HEAD',''),/summary/);
  const restarted=new JobManager(path.join(root,'jobs'),async()=>{throw Error('Must not rerun');});
  assert.equal((await restarted.worktreeStatus(second.job_id)).worktree.baseCommit,second.worktree?.baseCommit);
  assert.equal((await restarted.cleanupWorktree(second.job_id,'HEAD','no changes; fixture tests passed',{verified:true})).worktree.state,'removed');
  await restarted.close();
 }finally{release?.();await m.close();await fs.rm(root,{recursive:true,force:true});}
});

test('clean empty worktrees bypass integration and support non-mutating dry-run',async()=>{
 const {root,repo}=await fixture();const {worktree:w}=await createManagedWorktree({cwd:repo,task:'fixture'},randomUUID());
 try{
  await fs.writeFile(path.join(repo,'file.txt'),'unrelated tracked edit');await fs.writeFile(path.join(repo,'untracked.txt'),'unrelated new file');
  const preview=await cleanupManagedWorktree(w,'','',{dryRun:true,emptyOnly:true});
  assert.equal(preview.eligible,true);assert.equal(preview.empty,true);assert.equal(preview.state,'preserved');assert.ok(await fs.stat(w.path));
  assert.equal(await git(repo,'rev-parse',w.branch),w.baseCommit);
  const status=await inspectManagedWorktree(w,{includeDiskSize:true});
  assert.ok('createdAt' in status&&status.createdAt);assert.ok('tipCommit' in status&&status.tipCommit===w.baseCommit);
  assert.ok('commitCount' in status&&status.commitCount===0);assert.ok('changedFileCount' in status&&status.changedFileCount===0);
  assert.ok('integratedIntoOriginalHead' in status&&status.integratedIntoOriginalHead);assert.ok('diskBytes' in status&&status.diskBytes!==undefined&&status.diskBytes>0);assert.ok('diskBytesComplete' in status&&status.diskBytesComplete);
  assert.equal((await cleanupManagedWorktree(w,'not-a-ref','',{emptyOnly:true})).state,'removed');
  assert.equal(await fs.readFile(path.join(repo,'file.txt'),'utf8'),'unrelated tracked edit');assert.equal(await fs.readFile(path.join(repo,'untracked.txt'),'utf8'),'unrelated new file');
 }finally{if(await fs.stat(w.path).catch(()=>undefined))await git(repo,'worktree','remove',w.path);await fs.rm(root,{recursive:true,force:true});}
});

test('nonempty cleanup validates current HEAD, ancestry, empty-only and summary while preserving dry runs',async()=>{
 const {root,repo}=await fixture();const {worktree:w}=await createManagedWorktree({cwd:repo,task:'fixture'},randomUUID());
 try{
  await fs.writeFile(path.join(w.path,'file.txt'),'change');await git(w.path,'add','.');await git(w.path,'commit','-m','change');
  const tip=await git(w.path,'rev-parse','HEAD');
  await assert.rejects(()=>cleanupManagedWorktree(w,'HEAD','verified',{emptyOnly:true}),/Only empty/);
  const unmerged=await cleanupManagedWorktree(w,'HEAD','verified',{dryRun:true});assert.equal(unmerged.eligible,false);assert.match(unmerged.reason!,/not merged/);
  await assert.rejects(()=>cleanupManagedWorktree(w,tip,'verified'),/currently checked-out original HEAD/);
  const before=await inspectManagedWorktree(w);assert.ok('commitCount' in before&&before.commitCount===1);assert.ok('changedFileCount' in before&&before.changedFileCount===1);assert.ok('integratedIntoOriginalHead' in before&&!before.integratedIntoOriginalHead);
  await git(repo,'merge','--ff-only',w.branch);
  await assert.rejects(()=>cleanupManagedWorktree(w,'HEAD',''),/summary/);
  await fs.writeFile(path.join(repo,'file.txt'),'unrelated local edit');
  const preview=await cleanupManagedWorktree(w,'HEAD','',{dryRun:true});assert.equal(preview.eligible,true);assert.equal(preview.integrationCommit,tip);assert.ok(await fs.stat(w.path));
  assert.equal((await cleanupManagedWorktree(w,'HEAD','verified')).state,'removed');assert.equal(await fs.readFile(path.join(repo,'file.txt'),'utf8'),'unrelated local edit');
 }finally{if(await fs.stat(w.path).catch(()=>undefined))await git(repo,'worktree','remove',w.path);await fs.rm(root,{recursive:true,force:true});}
});

test('dirty, untracked, ignored, missing, and wrong-branch worktrees remain ineligible',async()=>{
 const {root,repo}=await fixture();const {worktree:w}=await createManagedWorktree({cwd:repo,task:'fixture'},randomUUID());
 try{
  for(const name of ['file.txt','untracked.txt']){
   await fs.writeFile(path.join(w.path,name),'keep');const preview=await cleanupManagedWorktree(w,'','',{dryRun:true});assert.equal(preview.eligible,false);assert.match(preview.reason!,/modified, untracked or ignored/);
   if(name==='file.txt')await git(w.path,'restore',name);else await fs.unlink(path.join(w.path,name));
  }
  await fs.writeFile(path.join(repo,'.git','info','exclude'),'ignored.txt\n');await fs.writeFile(path.join(w.path,'ignored.txt'),'keep');
  assert.equal((await cleanupManagedWorktree(w,'','',{dryRun:true})).eligible,false);await fs.unlink(path.join(w.path,'ignored.txt'));
  await git(w.path,'checkout','--detach');await assert.rejects(()=>cleanupManagedWorktree(w,'',''),/registration or branch changed/);await git(w.path,'checkout',w.branch);
  assert.equal((await cleanupManagedWorktree({...w,branch:'main'},'','',{dryRun:true})).eligible,false);
  await git(repo,'worktree','remove',w.path);
  const missing=await cleanupManagedWorktree(w,'','',{dryRun:true});assert.equal(missing.eligible,false);assert.match(missing.reason!,/path is missing/);
  const status=await inspectManagedWorktree(w);assert.ok('exists' in status&&!status.exists);assert.equal(status.state,'preserved');assert.equal(await git(repo,'rev-parse',w.branch),w.baseCommit);
 }finally{if(await fs.stat(w.path).catch(()=>undefined))await git(repo,'worktree','remove',w.path);await fs.rm(root,{recursive:true,force:true});}
});

test('idle clean empty jobs are automatically cleaned for completed, failed and cancelled results',async()=>{
 for(const result of [{error:null},{error:'failure',errorKind:'task_error'},{error:'cancelled',errorKind:'cancelled'}]){
  const {root,repo}=await fixture();const m=new JobManager(path.join(root,'jobs'),async()=>result);
  try{const job=await m.start('agent_implement',{cwd:repo,task:'empty',workspace_mode:'isolated'});const done=await finish(m,job.job_id);assert.equal(done.worktree?.state,'removed');assert.equal(await fs.stat(job.worktree!.path).catch(()=>undefined),undefined);}
  finally{await m.close();await fs.rm(root,{recursive:true,force:true});}
 }
});

test('inspection disk estimate does not follow a directory junction outside the worktree',async()=>{
 const {root,repo}=await fixture();const {worktree:w}=await createManagedWorktree({cwd:repo,task:'fixture'},randomUUID());
 const outside=path.join(root,'outside'),link=path.join(w.path,'external');
 try{
  await fs.mkdir(outside);await fs.writeFile(path.join(outside,'large.bin'),Buffer.alloc(1024*1024));await fs.symlink(outside,link,'junction');
  const status=await inspectManagedWorktree(w,{includeDiskSize:true});assert.ok('diskBytes' in status&&status.diskBytes!==undefined&&status.diskBytes<1024*1024);assert.ok('diskBytesComplete' in status&&status.diskBytesComplete);
  await fs.unlink(link);assert.equal((await cleanupManagedWorktree(w,'','')).state,'removed');assert.equal((await fs.stat(path.join(outside,'large.bin'))).size,1024*1024);
 }finally{if(await fs.lstat(link).catch(()=>undefined))await fs.unlink(link);if(await fs.stat(w.path).catch(()=>undefined))await git(repo,'worktree','remove',w.path);await fs.rm(root,{recursive:true,force:true});}
});

test('empty isolation is cleaned while another job still owns the original workspace',async()=>{
 const {root,repo}=await fixture();let release!:()=>void;
 const m=new JobManager(path.join(root,'jobs'),async(_kind,input)=>{if(input.task==='hold')await new Promise<void>(r=>{release=r;});return {error:null};});
 try{
  const first=await m.start('agent_implement',{cwd:repo,task:'hold'});while(!release)await new Promise(r=>setTimeout(r,5));
  const second=await m.start('agent_implement',{cwd:repo,task:'empty',workspace_mode:'auto'});const done=await finish(m,second.job_id);
  assert.equal(done.worktree?.state,'removed');assert.equal((await m.status(first.job_id)).status,'running');release();await finish(m,first.job_id);
 }finally{release?.();await m.close();await fs.rm(root,{recursive:true,force:true});}
});

test('persistent storage is configurable and recorded for later ownership checks',async()=>{
 const saved=process.env.AGENT_MCP_WORKTREE_DIR;
 try{
  delete process.env.AGENT_MCP_WORKTREE_DIR;
  const persistent=managedWorktreeStorageRoot();
  assert.ok(path.isAbsolute(persistent));assert.notEqual(persistent,path.join(os.tmpdir(),'agent-acp-worktrees'));
  if(process.platform==='win32')assert.equal(persistent,path.join(process.env.USERPROFILE??os.homedir(),'.agent-acp','worktrees'));
  process.env.AGENT_MCP_WORKTREE_DIR='relative';assert.throws(()=>managedWorktreeStorageRoot(),/absolute/);
 }finally{process.env.AGENT_MCP_WORKTREE_DIR=saved;}
 const {root,repo}=await fixture();const {worktree:w}=await createManagedWorktree({cwd:repo,task:'storage'},randomUUID());
 try{
  assert.equal(w.storageRoot,await fs.realpath(testStorage));
  process.env.AGENT_MCP_WORKTREE_DIR=path.join(root,'other-storage');
  const status=await inspectManagedWorktree(w);assert.equal('diskBytes' in status,false);
  assert.equal((await cleanupManagedWorktree(w,'','')).state,'removed');
 }finally{process.env.AGENT_MCP_WORKTREE_DIR=saved;if(await fs.stat(w.path).catch(()=>undefined))await git(repo,'worktree','remove',w.path);await fs.rm(root,{recursive:true,force:true});}
});

test('migration preserves dirty files, branch and UUID/repository layout without changing original',async()=>{
 const {root,repo}=await fixture('Project With Spaces');let {worktree:w}=await createManagedWorktree({cwd:repo,task:'migration'},randomUUID());
 const targetRoot=path.join(root,'persistent');const old=w.path,original={...w};
 try{
  await fs.writeFile(path.join(w.path,'file.txt'),'dirty data');await fs.writeFile(path.join(w.path,'extra.txt'),'untracked');
  const preview=await migrateManagedWorktree(w,{targetRoot,dryRun:true});assert.equal(preview.eligible,true);assert.equal(preview.path,old);assert.equal(await fs.stat(targetRoot).catch(()=>undefined),undefined);
  w=await migrateManagedWorktree(w,{targetRoot});assert.equal(w.path,preview.destinationPath);assert.equal(w.storageRoot,targetRoot);assert.equal(path.basename(w.path),path.basename(repo));assert.equal(path.basename(path.dirname(w.path)),w.branch.slice('agent-acp/'.length));
  assert.equal(await fs.stat(old).catch(()=>undefined),undefined);assert.equal(await fs.readFile(path.join(w.path,'file.txt'),'utf8'),'dirty data');assert.equal(await fs.readFile(path.join(w.path,'extra.txt'),'utf8'),'untracked');assert.equal(await fs.readFile(path.join(repo,'file.txt'),'utf8'),'base');
  assert.equal(await git(w.path,'symbolic-ref','HEAD'),'refs/heads/'+w.branch);assert.equal((await inspectManagedWorktree(w)).state,'preserved');
  assert.equal((await migrateManagedWorktree(w,{targetRoot,dryRun:true})).eligible,false);
  w=await rollbackManagedWorktreeMigration(original,w);assert.equal(w.path,old);assert.equal(await fs.readFile(path.join(w.path,'file.txt'),'utf8'),'dirty data');assert.equal(await fs.readFile(path.join(w.path,'extra.txt'),'utf8'),'untracked');
  await git(w.path,'restore','file.txt');await fs.unlink(path.join(w.path,'extra.txt'));await cleanupManagedWorktree(w,'','');
 }finally{if(await fs.stat(w.path).catch(()=>undefined)){await git(w.path,'restore','file.txt');await fs.unlink(path.join(w.path,'extra.txt')).catch(()=>{});await git(repo,'worktree','remove',w.path);}await fs.rm(root,{recursive:true,force:true});}
});

test('migration rejects destination collision, unsafe roots and missing checkouts',async()=>{
 const {root,repo}=await fixture();const {worktree:w}=await createManagedWorktree({cwd:repo,task:'migration'},randomUUID());
 try{
  const targetRoot=path.join(root,'target');await fs.mkdir(path.join(targetRoot,w.branch.slice('agent-acp/'.length)),{recursive:true});
  assert.match((await migrateManagedWorktree(w,{targetRoot,dryRun:true})).reason!,/collision/);
  for(const invalid of ['relative',repo,w.path,path.join(w.path,'nested')])assert.equal((await migrateManagedWorktree(w,{targetRoot:invalid,dryRun:true})).eligible,false);
  await git(repo,'worktree','remove',w.path);assert.match((await migrateManagedWorktree(w,{targetRoot,dryRun:true})).reason!,/missing/);
 }finally{if(await fs.stat(w.path).catch(()=>undefined))await git(repo,'worktree','remove',w.path);await fs.rm(root,{recursive:true,force:true});}
});

test('metadata-only checkout is damaged, not clean empty; explicit recovery retains branch',async()=>{
 for(const action of ['restore','remove'] as const){
  const {root,repo}=await fixture();const {worktree:w}=await createManagedWorktree({cwd:repo,task:'recovery'},randomUUID());
  try{
   await fs.unlink(path.join(w.path,'file.txt'));
   const status=await inspectManagedWorktree(w);assert.ok('checkoutState' in status&&status.checkoutState==='git-metadata-only');assert.ok('missingTrackedFileCount' in status&&status.missingTrackedFileCount===1);assert.ok('commitEmpty' in status&&status.commitEmpty);assert.ok('cleanEmpty' in status&&!status.cleanEmpty);
   assert.match((await cleanupManagedWorktree(w,'','',{dryRun:true})).reason!,/damaged/);assert.match((await migrateManagedWorktree(w,{targetRoot:path.join(root,'target'),dryRun:true})).reason!,/damaged/);
   const preview=await recoverManagedWorktree(w,'',{dryRun:true,action});assert.equal(preview.eligible,true);assert.equal(await fs.stat(path.join(w.path,'file.txt')).catch(()=>undefined),undefined);
   await assert.rejects(()=>recoverManagedWorktree(w,'',{action}),/summary/);
   const result=await recoverManagedWorktree(w,'Reviewed missing files and preserved commits',{action});assert.equal(result.state,action==='remove'?'removed':'preserved');assert.equal(result.recoveryBranchPreserved,true);assert.equal(await git(repo,'rev-parse',w.branch),w.baseCommit);
   if(action==='restore'){assert.equal(await fs.readFile(path.join(w.path,'file.txt'),'utf8'),'base');await cleanupManagedWorktree(w,'','');}
  }finally{if(await fs.stat(w.path).catch(()=>undefined)){await git(w.path,'restore','file.txt');await git(repo,'worktree','remove',w.path);}await fs.rm(root,{recursive:true,force:true});}
 }
});

test('partial and staged-deletion checkouts cannot use recovery cleanup',async()=>{
 const {root,repo}=await fixture();await fs.writeFile(path.join(repo,'second.txt'),'second');await git(repo,'add','.');await git(repo,'commit','-m','second');
 const {worktree:w}=await createManagedWorktree({cwd:repo,task:'partial'},randomUUID());
 try{
  await fs.unlink(path.join(w.path,'file.txt'));
  assert.equal((await recoverManagedWorktree(w,'',{dryRun:true})).eligible,false);assert.equal((await cleanupManagedWorktree(w,'','',{dryRun:true})).eligible,false);
  await git(w.path,'add','file.txt');await fs.unlink(path.join(w.path,'second.txt'));
  assert.match((await recoverManagedWorktree(w,'',{dryRun:true})).reason!,/staged/);
 }finally{await git(w.path,'restore','--source=HEAD','--staged','--worktree','.');await git(repo,'worktree','remove',w.path);await fs.rm(root,{recursive:true,force:true});}
});

test('recovery refreshes the unchanged index across EOL conversions and preserves committed tips',async()=>{
 for(const eol of ['lf','crlf'])for(const action of ['restore','remove'] as const){
  const {root,repo}=await fixture();await git(repo,'config','core.autocrlf','true');
  const {worktree:w}=await createManagedWorktree({cwd:repo,task:'EOL recovery'},randomUUID());
  try{
   await fs.writeFile(path.join(w.path,'.gitattributes'),`*.txt text eol=${eol}\n`);
   await fs.writeFile(path.join(w.path,'file.txt'),'committed\r\n한글 내용\r\n');await git(w.path,'add','.');await git(w.path,'commit','-m','EOL commit');
   const tip=await git(w.path,'rev-parse','HEAD'),tree=await git(w.path,'write-tree');
   for(const name of ['file.txt','.gitattributes'])await fs.unlink(path.join(w.path,name));
   const result=await recoverManagedWorktree(w,'Reviewed missing checkout; preserve branch',{action});
   assert.equal(result.state,action==='remove'?'removed':'preserved');assert.equal(await git(repo,'rev-parse',w.branch),tip);
   if(action==='restore'){
    assert.equal(await git(w.path,'write-tree'),tree);assert.equal(await git(w.path,'status','--porcelain'),'');
    assert.equal((await fs.readFile(path.join(w.path,'file.txt'),'utf8')).replaceAll('\r\n','\n'),'committed\n한글 내용\n');
   }
  }finally{if(await fs.stat(w.path).catch(()=>undefined))await git(repo,'worktree','remove',w.path);await fs.rm(root,{recursive:true,force:true});}
 }
});

test('Windows default storage ignores package-virtualized LOCALAPPDATA', {skip:process.platform!=='win32'},()=>{
 const saved=process.env.AGENT_MCP_WORKTREE_DIR,local=process.env.LOCALAPPDATA;
 try{delete process.env.AGENT_MCP_WORKTREE_DIR;process.env.LOCALAPPDATA=path.join(os.tmpdir(),'Packages','Fixture','LocalCache');
  assert.equal(managedWorktreeStorageRoot(),path.join(process.env.USERPROFILE??os.homedir(),'.agent-acp','worktrees'));
 }finally{if(saved===undefined)delete process.env.AGENT_MCP_WORKTREE_DIR;else process.env.AGENT_MCP_WORKTREE_DIR=saved;if(local===undefined)delete process.env.LOCALAPPDATA;else process.env.LOCALAPPDATA=local;}
});

test('first-mkdir redirection is rejected before creating or moving a Git worktree',async t=>{
 const {root,repo}=await fixture(),saved=process.env.AGENT_MCP_WORKTREE_DIR;
 let w:ManagedWorktree|undefined;
 const mkdir=fs.mkdir.bind(fs),redirect=path.join(root,'virtual-root'),actual=path.join(root,'package-private');
 try{
  await mkdir(actual);
  t.mock.method(fs,'mkdir',async(...args:any[])=>{
   if(String(args[0])===redirect){await fs.symlink(actual,redirect,'junction');return undefined;}
   return (mkdir as any)(...args);
  });
  process.env.AGENT_MCP_WORKTREE_DIR=redirect;
  await assert.rejects(()=>createManagedWorktree({cwd:repo,task:'redirected create'},randomUUID()),/WORKTREE_STORAGE_REDIRECTED:.*AGENT_MCP_WORKTREE_DIR/);
  assert.deepEqual(await fs.readdir(actual),[]);assert.equal((await git(repo,'worktree','list','--porcelain')).split('worktree ').length-1,1);
  await fs.unlink(redirect);process.env.AGENT_MCP_WORKTREE_DIR=testStorage;
  w=(await createManagedWorktree({cwd:repo,task:'source'},randomUUID())).worktree;
  await assert.rejects(()=>migrateManagedWorktree(w!,{targetRoot:redirect}),/WORKTREE_STORAGE_REDIRECTED/);
  assert.equal((await fs.readFile(path.join(w.path,'file.txt'),'utf8')),'base');assert.deepEqual(await fs.readdir(actual),[]);
  // A subsequent call sees the existing redirected directory and fails early too.
  assert.match((await migrateManagedWorktree(w,{targetRoot:redirect,dryRun:true})).reason!,/AGENT_MCP_WORKTREE_DIR/);
 }finally{
  t.mock.restoreAll();if(saved===undefined)delete process.env.AGENT_MCP_WORKTREE_DIR;else process.env.AGENT_MCP_WORKTREE_DIR=saved;
  if(w&&await fs.stat(w.path).catch(()=>undefined))await git(repo,'worktree','remove',w.path);await fs.rm(root,{recursive:true,force:true});
 }
});

test('patch-equivalent cleanup requires opt-in, parent verification and current-tree equivalence',async()=>{
 for(const reverted of [false,true]){
  const {root,repo}=await fixture();const {worktree:w}=await createManagedWorktree({cwd:repo,task:'patch'},randomUUID());
  try{
   await fs.writeFile(path.join(w.path,'file.txt'),'change');await git(w.path,'add','.');await git(w.path,'commit','-m','source change');
   await fs.writeFile(path.join(repo,'unrelated.txt'),'unrelated');await git(repo,'add','.');await git(repo,'commit','-m','original diverges');await git(repo,'cherry-pick',w.branch);
   if(reverted)await git(repo,'revert','--no-edit','HEAD');
   await assert.rejects(()=>cleanupManagedWorktree(w,'HEAD','verified'),/not merged/);
   assert.match((await cleanupManagedWorktree(w,'HEAD','',{dryRun:true,allowPatchEquivalent:true})).reason!,/summary/);
   const preview=await cleanupManagedWorktree(w,'HEAD','parent tests passed',{dryRun:true,allowPatchEquivalent:true});
   if(reverted){assert.equal(preview.eligible,false);assert.match(preview.reason!,/current tree differs/);}
   else {assert.equal(preview.eligible,true,preview.reason);assert.equal(preview.integrationMethod,'patch-equivalent');assert.equal((await cleanupManagedWorktree(w,'HEAD','parent tests passed',{allowPatchEquivalent:true})).state,'removed');}
  }finally{if(await fs.stat(w.path).catch(()=>undefined))await git(repo,'worktree','remove',w.path);await fs.rm(root,{recursive:true,force:true});}
 }
});

test('recovery refuses sparse checkout and skip-worktree even when only Git metadata remains',async()=>{
 const {root,repo}=await fixture();const {worktree:w}=await createManagedWorktree({cwd:repo,task:'sparse'},randomUUID());
 try{
  await git(w.path,'update-index','--skip-worktree','file.txt');await fs.unlink(path.join(w.path,'file.txt'));
  assert.match((await recoverManagedWorktree(w,'',{dryRun:true})).reason!,/skip-worktree/);
  await git(w.path,'update-index','--no-skip-worktree','file.txt');await git(w.path,'config','core.sparseCheckout','true');
  assert.match((await recoverManagedWorktree(w,'',{dryRun:true})).reason!,/sparse/);
 }finally{await git(w.path,'config','core.sparseCheckout','false');await git(w.path,'update-index','--no-skip-worktree','file.txt');await git(w.path,'restore','file.txt');await git(repo,'worktree','remove',w.path);await fs.rm(root,{recursive:true,force:true});}
});

test('patch equivalence refuses uncovered commits and merge histories',async()=>{
 for(const merge of [false,true]){
  const {root,repo}=await fixture();const {worktree:w}=await createManagedWorktree({cwd:repo,task:'coverage'},randomUUID());
  try{
   await fs.writeFile(path.join(w.path,'file.txt'),'change');await git(w.path,'add','.');await git(w.path,'commit','-m','first');const first=await git(w.path,'rev-parse','HEAD');
   await fs.writeFile(path.join(repo,'original.txt'),'original');await git(repo,'add','.');await git(repo,'commit','-m','diverge');
   if(merge){await git(w.path,'merge','--no-ff','-m','merge original','--',await git(repo,'rev-parse','HEAD'));}
   else {await fs.writeFile(path.join(w.path,'other.txt'),'not integrated');await git(w.path,'add','.');await git(w.path,'commit','-m','uncovered');}
   await git(repo,'cherry-pick',first);
   const preview=await cleanupManagedWorktree(w,'HEAD','parent verified',{dryRun:true,allowPatchEquivalent:true});assert.equal(preview.eligible,false);assert.match(preview.reason!,merge?/merge or root/:/no equivalent patch/);
  }finally{if(await fs.stat(w.path).catch(()=>undefined))await git(repo,'worktree','remove',w.path);await fs.rm(root,{recursive:true,force:true});}
 }
});
