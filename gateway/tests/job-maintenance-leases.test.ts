import './isolated-environment.js';
import test,{after,before,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {spawn,execFile,type ChildProcess} from 'node:child_process';
import {promisify} from 'node:util';
import {JobManager} from '../src/jobs.js';
import {createManagedWorktree} from '../src/managed-worktree.js';
import {resolveGitExecutable} from '../src/git-read-policy.js';
import {readProcessInventory,type RecordedProcessIdentity} from '../src/process-inventory.js';
import type {MaintenanceLockRecord,MaintenanceLockRecovery} from '../src/maintenance-lock.js';

const execute=promisify(execFile),storage=await fs.mkdtemp(path.join(os.tmpdir(),'job-maintenance-leases-worktrees-'));
const previousStorage=process.env.AGENT_MCP_WORKTREE_DIR;
process.env.AGENT_MCP_WORKTREE_DIR=storage;
let self:RecordedProcessIdentity,foreign:RecordedProcessIdentity,foreignProcess:ChildProcess;
before(async()=>{
 foreignProcess=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
 await new Promise<void>((resolve,reject)=>{foreignProcess.once('spawn',resolve);foreignProcess.once('error',reject);});
 const inventory=await readProcessInventory();self=inventory.processes.find(row=>row.pid===process.pid)!;foreign=inventory.processes.find(row=>row.pid===foreignProcess.pid)!;
 assert.ok(self?.createdAt);assert.ok(foreign?.createdAt);assert.equal(inventory.processes.some(row=>row.pid===2147483647),false);
});
after(async()=>{
 if(foreignProcess&&foreignProcess.exitCode===null){const exited=new Promise<void>(resolve=>foreignProcess.once('exit',()=>resolve()));foreignProcess.kill();await exited;}
 if(previousStorage===undefined)delete process.env.AGENT_MCP_WORKTREE_DIR;else process.env.AGENT_MCP_WORKTREE_DIR=previousStorage;
 await fs.rm(storage,{recursive:true,force:true});
});
async function git(cwd:string,...args:string[]){return (await execute(await resolveGitExecutable(),['-c','user.name=Fixture','-c','user.email=fixture@example.invalid',...args],{cwd,windowsHide:true})).stdout.trim();}
const historicalAudit:MaintenanceLockRecovery={lockFile:'earlier-maintenance.lock',reason:'legacy_empty',recoveredAt:'2020-01-01T00:00:00.000Z',previous:{legacy:true,modifiedAt:'2019-12-31T23:00:00.000Z'}};
async function fixture(t:TestContext,stubRunner?:(cwd:string,jobs:string)=>Promise<unknown>){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'job-maintenance-leases-')),repo=path.join(root,'repo'),jobs=path.join(root,'jobs');await fs.mkdir(repo);await fs.mkdir(jobs);
 await git(repo,'init');await fs.writeFile(path.join(repo,'base.txt'),'original fixture data');await git(repo,'add','.');await git(repo,'commit','-m','fixture base');
 const id=randomUUID(),created=await createManagedWorktree({cwd:repo,task:'lease recovery fixture'},id),file=path.join(jobs,id+'.json'),lockFile=file+'.cleanup.lock';let scans=0,runnerCalls=0;
 const record={job_id:id,kind:'agent_implement',cwd:created.input.cwd,ownerPid:process.pid,status:'completed',startedAt:'2020-01-01T00:00:00.000Z',lastActivityAt:'2020-01-01T00:00:01.000Z',finishedAt:'2020-01-01T00:00:01.000Z',worktree:created.worktree,maintenanceLockRecovery:[historicalAudit],result:{error:null,text:'Completed fixture; preserve this history',usage:{totalTokens:7}}};
 await fs.writeFile(file,JSON.stringify(record));
 const manager=new JobManager(jobs,async(_kind,input)=>{runnerCalls++;if(stubRunner)return stubRunner(input.cwd,jobs);throw Error('Fixture must never execute a provider');},undefined,undefined,async()=>{scans++;return {processScan:'passed',checkedAt:new Date().toISOString(),ownerMayServeOtherJobs:true};});
 const worktreePaths=[created.worktree.path];
 t.after(async()=>{
  await manager.close();
  for(const worktreePath of worktreePaths)if(await fs.lstat(worktreePath).catch(()=>undefined)){
   assert.ok(path.resolve(worktreePath).startsWith(path.resolve(storage)+path.sep));
   await git(repo,'worktree','remove',worktreePath);
  }
  await fs.rm(root,{recursive:true,force:true});
 });
 return {repo,id,file,lockFile,record,manager,worktree:created.worktree,scans:()=>scans,runnerCalls:()=>runnerCalls,trackWorktree:(worktreePath:string)=>{worktreePaths.push(worktreePath);}};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
type RecoveryReason=MaintenanceLockRecovery['reason'];
function lock(owner:RecordedProcessIdentity,overrides:Partial<MaintenanceLockRecord>={}):MaintenanceLockRecord {
 const now=Date.now();return {version:1,ownerPid:owner.pid,ownerCreatedAt:owner.createdAt!,ownerCreationKey:owner.creationKey??null,operation:'cleanup',acquiredAt:new Date(now-60_000).toISOString(),expiresAt:new Date(now+60_000).toISOString(),leaseToken:randomUUID(),...overrides};
}
async function plantRecoverableLock(f:Fixture,reason:RecoveryReason):Promise<MaintenanceLockRecord|{legacy:true;modifiedAt:string}>{
 if(reason==='legacy_empty'){
  const old=new Date(Date.now()-31*60_000);await fs.writeFile(f.lockFile,'');await fs.utimes(f.lockFile,old,old);
  return {legacy:true,modifiedAt:(await fs.stat(f.lockFile)).mtime.toISOString()};
 }
 const previous=reason==='owner_missing'?lock(self,{ownerPid:2147483647})
  :reason==='pid_reused'?lock(self,{ownerCreatedAt:'1970-01-01T00:00:00.000Z',ownerCreationKey:null})
  :lock(self,{expiresAt:new Date(Date.now()-1000).toISOString()});
 await fs.writeFile(f.lockFile,JSON.stringify(previous));return previous;
}
async function prepareForget(f:Fixture){
 await git(f.repo,'worktree','remove',f.worktree.path);await git(f.repo,'update-ref','-d','refs/heads/'+f.worktree.branch,f.worktree.baseCommit);
}
async function invoke(f:Fixture,action:'cleanup'|'forget',dryRun=false){
 return action==='cleanup'?f.manager.cleanupWorktree(f.id,'HEAD','Reviewed fixture and verified no remaining writers',{verified:true,dryRun})
  :f.manager.worktreeMaintenance(f.id,'forget',{verified:true,summary:'Path, branch and registration absent; preserve history',dryRun});
}
for(const action of ['cleanup','forget'] as const)for(const reason of ['owner_missing','pid_reused','expired','legacy_empty'] as const){
 test(`JobManager ${action} recovers ${reason} and preserves response and job audit`,async t=>{
  const f=await fixture(t);if(action==='forget')await prepareForget(f);
  const refsBefore=await git(f.repo,'show-ref'),previous=await plantRecoverableLock(f,reason),started=Date.now();
  const response=await invoke(f,action);assert.ok('lockRecovery' in response);const recovered=response.lockRecovery as MaintenanceLockRecovery[];
  assert.equal(recovered.length,1);assert.equal(recovered[0].reason,reason);assert.equal(recovered[0].lockFile,f.lockFile);assert.deepEqual(recovered[0].previous,previous);
  assert.ok(Date.parse(recovered[0].recoveredAt)>=started);assert.ok(Date.parse(recovered[0].recoveredAt)<=Date.now());assert.equal(response.worktree.state,'removed');
  const saved=JSON.parse(await fs.readFile(f.file,'utf8'));assert.deepEqual(saved.maintenanceLockRecovery,[historicalAudit,...recovered]);
  assert.deepEqual(saved.result,f.record.result);assert.equal(saved.status,f.record.status);assert.equal(saved.job_id,f.id);assert.equal(saved.worktree.state,'removed');
  const status=await f.manager.status(f.id,true);assert.deepEqual(status.maintenanceLockRecovery,saved.maintenanceLockRecovery);
  await assert.rejects(fs.lstat(f.lockFile),{code:'ENOENT'});await assert.rejects(fs.lstat(f.worktree.path),{code:'ENOENT'});assert.equal(f.runnerCalls(),0);
  assert.equal(await fs.readFile(path.join(f.repo,'base.txt'),'utf8'),'original fixture data');
  if(action==='cleanup')assert.equal(f.scans(),1);
  else {assert.equal(saved.worktree.recordDisposition,'forgotten');assert.deepEqual(saved.worktree.forgetAudit.lockRecovery,recovered);assert.equal(await git(f.repo,'show-ref'),refsBefore);assert.equal(f.scans(),0);}
 });
}
for(const action of ['cleanup','forget'] as const){
 test(`JobManager ${action} refuses a valid foreign process lease without changing job history`,async t=>{
  const f=await fixture(t);if(action==='forget')await prepareForget(f);
  const previous=lock(foreign),before=await fs.readFile(f.file,'utf8');await fs.writeFile(f.lockFile,JSON.stringify(previous));
  await assert.rejects(invoke(f,action),/Worktree maintenance already in progress/);
  assert.equal(await fs.readFile(f.file,'utf8'),before);assert.deepEqual(JSON.parse(await fs.readFile(f.lockFile,'utf8')),previous);assert.equal(f.runnerCalls(),0);assert.equal(f.scans(),0);
  assert.equal(await fs.readFile(path.join(f.repo,'base.txt'),'utf8'),'original fixture data');
  if(action==='cleanup')assert.equal((await fs.stat(f.worktree.path)).isDirectory(),true);
 });
}
test('automatic cleanup recovery survives the active job final persistence',async t=>{
 let previous:MaintenanceLockRecord|undefined,lockFile:string|undefined;
 const f=await fixture(t,async(cwd,jobs)=>{
  const id=path.basename(path.dirname(cwd));lockFile=path.join(jobs,id+'.json.cleanup.lock');previous=lock(self,{ownerPid:2147483647});
  await fs.writeFile(lockFile,JSON.stringify(previous));return {error:null,text:'Local stub completed; no provider was invoked'};
 });
 const started=await f.manager.start('agent_implement',{cwd:f.repo,task:'Automatic cleanup lease fixture',workspace_mode:'isolated'});assert.ok(started.worktree);f.trackWorktree(started.worktree.path);
 const completed=await f.manager.wait(started.job_id,25,true);assert.equal(completed.status,'completed');assert.equal(completed.worktree.state,'removed');assert.equal(completed.completionPending,undefined);
 const saved=JSON.parse(await fs.readFile(path.join(path.dirname(f.file),started.job_id+'.json'),'utf8'));
 assert.equal(saved.maintenanceLockRecovery?.length,1);assert.equal(saved.maintenanceLockRecovery[0].reason,'owner_missing');assert.deepEqual(saved.maintenanceLockRecovery[0].previous,previous);
 assert.deepEqual(completed.maintenanceLockRecovery,saved.maintenanceLockRecovery);assert.equal(saved.result.text,'Local stub completed; no provider was invoked');assert.equal(f.runnerCalls(),1);assert.equal(f.scans(),1);
 await assert.rejects(fs.lstat(lockFile!),{code:'ENOENT'});await assert.rejects(fs.lstat(started.worktree.path),{code:'ENOENT'});assert.equal(await fs.readFile(path.join(f.repo,'base.txt'),'utf8'),'original fixture data');
});
