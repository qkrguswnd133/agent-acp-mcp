import './isolated-environment.js';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {randomUUID} from 'node:crypto';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {MaintenanceOperations} from '../src/maintenance-operations.js';import {JobManager} from '../src/jobs.js';import {createManagedWorktree} from '../src/managed-worktree.js';import {boundedToolPayload} from '../src/tool-payload.js';
const exec=promisify(execFile),delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function finish(m:MaintenanceOperations,id:string){for(let i=0;i<1800;i++){const s=await m.status(id);if(!['queued','running'].includes(s.status))return s;await delay(50);}throw Error('Maintenance timeout');}
test('accepted maintenance survives drain and records errors without replay',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'operation-fixture-')),m=new MaintenanceOperations(root);try{let complete!:()=>void;const j=await m.start('fixture',{},async()=>{await new Promise<void>(r=>{complete=r;});return {ok:true};});while(!complete)await delay(10);let drained=false;const drain=m.drain().then(()=>{drained=true;});await delay(30);assert.equal(drained,false);complete();await drain;assert.equal((await m.status(j.operation_id)).status,'completed');await assert.rejects(m.start('new',{},async()=>{}),/draining/);}finally{await m.drain();await fs.rm(root,{recursive:true,force:true});}
});
test('5000 ignored files cleanup acknowledges under 5s while unrelated job status and startup remain responsive',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'background-cleanup-')),repo=path.join(root,'repo'),jobsDir=path.join(root,'jobs'),other=path.join(root,'other'),storage=path.join(root,'worktrees'),old=process.env.AGENT_MCP_WORKTREE_DIR;process.env.AGENT_MCP_WORKTREE_DIR=storage;
 await fs.mkdir(repo);await fs.mkdir(jobsDir);await fs.mkdir(other);const git=async(...args:string[])=>(await exec('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid',...args],{cwd:repo,windowsHide:true})).stdout.trim();
 const m=new JobManager(jobsDir,async(_kind,_input,signal)=>new Promise(resolve=>{const done=()=>resolve({error:'cancelled',errorKind:'cancelled'});signal.addEventListener('abort',done,{once:true});if(signal.aborted)done();})),ops=new MaintenanceOperations(path.join(root,'operations'));
 try{
  await git('init');await fs.writeFile(path.join(repo,'.gitignore'),'artifacts/\n');await fs.writeFile(path.join(repo,'base'),'base');await git('add','.');await git('commit','-m','base');const id=randomUUID(),w=(await createManagedWorktree({cwd:repo,task:'fixture'},id)).worktree;
  await fs.mkdir(path.join(w.path,'artifacts'));for(let i=0;i<5000;i++)await fs.writeFile(path.join(w.path,'artifacts',i+'.txt'),'build output');
  await fs.writeFile(path.join(jobsDir,id+'.json'),JSON.stringify({job_id:id,ownerPid:process.pid,status:'completed',startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),lastActivityAt:new Date().toISOString(),kind:'agent_implement',cwd:w.path,worktree:w,result:{error:null,childCleanedUp:true}}));
  const began=performance.now(),accepted=await ops.start('cleanup',{job_id:id},phase=>m.cleanupWorktree(id,'HEAD','fixture',{removeIgnoredArtifacts:true,onPhase:phase}));const acknowledgeMs=performance.now()-began;assert(acknowledgeMs<5000);
  const start=performance.now(),reader=await m.start('agent_ask',{cwd:other,task:'fixture'});assert(performance.now()-start<2500);assert(['queued','running'].includes((await m.status(reader.job_id)).status));
  const result=await finish(ops,accepted.operation_id);assert.equal(result.status,'completed',JSON.stringify(result));assert.equal(result.result.worktree.state,'removed');assert.equal((await m.status(reader.job_id)).status,'running');await m.cancel(reader.job_id);
  const response=await boundedToolPayload(result,path.join(root,'details'));assert(Buffer.byteLength(JSON.stringify(response))<20*1024);t.diagnostic(JSON.stringify({acknowledgeMs,timings:result.timings}));
 }finally{await ops.drain();await m.close();if(old===undefined)delete process.env.AGENT_MCP_WORKTREE_DIR;else process.env.AGENT_MCP_WORKTREE_DIR=old;await fs.rm(root,{recursive:true,force:true});}
});
