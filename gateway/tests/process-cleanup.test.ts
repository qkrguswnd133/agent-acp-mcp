import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {classifyProcessCleanup,applyProcessCleanupPolicy,verifyTrackedProcessesAbsent,withRootExitEvidence} from '../src/process-cleanup.js';
import {trackProcessTree} from '../src/process-tree.js';
import {linuxOwnershipSnapshot,assertInterruptedOwnershipAbsent} from '../src/interrupted-ownership.js';

test('cleanup classification separates verified, positively remaining and unknown without manufacturing PIDs',()=>{
 assert.equal(classifyProcessCleanup({childCleanedUp:true,processCleanup:{verified:true,trackedPids:[1],remainingPids:[]}}).state,'verified');
 assert.equal(classifyProcessCleanup({childCleanedUp:false,processCleanup:{verified:false,trackedPids:[1],remainingPids:[]}}).state,'unverified');
 assert.equal(classifyProcessCleanup({processCleanup:{verified:false,unverifiedPids:[1],remainingPids:[]}}).state,'unverified');
 assert.equal(classifyProcessCleanup({processCleanup:{verified:true,remainingPids:[1]}}).state,'remaining');
 assert.deepEqual(classifyProcessCleanup({results:[{processCleanup:{trackedPids:[1],unverifiedPids:[2],remainingPids:[3],verified:false}}]}).trackedPids,[1,3,2]);
 assert.equal(classifyProcessCleanup({processCleanup:{verified:true,trackedPids:['not-a-pid']}}).invalidPids,true);
});
test('all providers preserve successful text and usage on unknown cleanup; known survivors remain implementation failures',()=>{
 for(const provider of ['grok','claude','codex'] as const){
  const result={provider,text:'implementation completed',error:null,sessionId:'session',usage:{totalTokens:10},childCleanedUp:false,processCleanup:{verified:false,trackedPids:[999],remainingPids:[]}};
  const unknown=applyProcessCleanupPolicy(result,true);assert.equal(unknown.error,null);assert.equal(unknown.text,result.text);assert.deepEqual(unknown.usage,result.usage);assert.equal(unknown.processCleanupState,'unverified');assert.match(unknown.processCleanupWarning!,/no remaining process was observed/);
  const live=applyProcessCleanupPolicy({...result,processCleanup:{verified:false,remainingPids:[999]}},true);assert.equal(live.errorKind,'process_cleanup_unconfirmed');assert.match(live.error!,/999/);
  const failed=applyProcessCleanupPolicy({...result,error:'rate limited',errorKind:'rate_limited'},true);assert.equal(failed.error,'rate limited');assert.equal(failed.errorKind,'rate_limited');
 }
});
test('root without exit notification uses fresh liveness proof rather than assuming it survived',()=>{
 const original={verified:false,trackedPids:[],remainingPids:[]};
 assert.deepEqual(withRootExitEvidence(original,99,()=> 'absent').remainingPids,[]);
 assert.deepEqual(withRootExitEvidence(original,99,()=> 'alive').remainingPids,[99]);
 const unknown=withRootExitEvidence(original,99,()=> 'unknown');assert.deepEqual(unknown.remainingPids,[]);assert.deepEqual(unknown.unverifiedPids,[99]);
});
test('fresh tracked-PID check refuses live, permission-unknown, malformed and re-used PIDs without killing',async()=>{
 assert.deepEqual((await verifyTrackedProcessesAbsent([1,1,2],()=> 'absent')).absentPids,[1,2]);
 await assert.rejects(verifyTrackedProcessesAbsent([1,2],pid=>pid===2?'alive':'absent'),/PIDs: 2/);
 await assert.rejects(verifyTrackedProcessesAbsent([1],()=> 'unknown'),/unverified/);
 await assert.rejects(verifyTrackedProcessesAbsent([0],()=> 'absent'),/invalid/);
 await assert.rejects(verifyTrackedProcessesAbsent([process.pid]),/still alive/);
});
test('failed descendant snapshot reports unverified PIDs without claiming they are observed alive',async()=>{
 let scans=0;
 const tracker=trackProcessTree(12345,()=>true,{snapshot:async()=>{if(++scans===1)return [{pid:12345,parentPid:1,created:'root'},{pid:23456,parentPid:12345,created:'child'}];throw Error('inventory unavailable');}});
 await new Promise(resolve=>setTimeout(resolve,0));
 const result=await tracker.cleanup();assert.deepEqual(result.trackedPids,[23456]);assert.deepEqual(result.remainingPids,[]);assert.deepEqual(result.unverifiedPids,[23456]);assert.equal(result.verified,false);
});
test('Linux ownership inventory reads cwd and command line, ignores zombies and fails closed on incomplete live data',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'linux-owner-inventory-')),workspace=path.join(root,'workspace');await fs.mkdir(workspace);
 try{
  for(const [pid,state] of [[101,'S'],[102,'Z']] as const){const dir=path.join(root,String(pid));await fs.mkdir(dir);await fs.writeFile(path.join(dir,'stat'),`${pid} (node worker) ${state} 1 0 0`);await fs.writeFile(path.join(dir,'cmdline'),'node\0worker.js\0');if(state!=='Z')await fs.symlink(workspace,path.join(dir,'cwd'),process.platform==='win32'?'junction':'dir');}
  const uid=(await fs.stat(root)).uid,rows=await linuxOwnershipSnapshot(root,uid);assert.equal(rows.length,1);assert.equal(rows[0].pid,101);assert.equal(rows[0].commandLine,'node worker.js');
  assert.throws(()=>assertInterruptedOwnershipAbsent({ownerPid:999,workspacePaths:[workspace]},rows,'linux',500),/references/);
  await fs.unlink(path.join(root,'101','cmdline'));await assert.rejects(linuxOwnershipSnapshot(root,uid),/unavailable or incomplete/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('Linux ownership inventory preserves explicit permission-denial evidence',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'linux-owner-permission-')),dir=path.join(root,'101');await fs.mkdir(dir);
 try{
  await fs.writeFile(path.join(dir,'stat'),'101 (node worker) S 1 0');await fs.writeFile(path.join(dir,'cmdline'),'node\0worker.js');
  t.mock.method(fs,'readlink',async()=>{throw Object.assign(Error('Permission denied'),{code:'EACCES'});});
  await assert.rejects(linuxOwnershipSnapshot(root,(await fs.stat(root)).uid),(error:any)=>error.code==='PROCESS_OWNERSHIP_PERMISSION_DENIED'&&error.pid===101);
 }finally{t.mock.restoreAll();await fs.rm(root,{recursive:true,force:true});}
});
test('native Linux ownership inventory includes this process or explicitly reports protected live process data',{skip:process.platform!=='linux'},async t=>{
 try{const rows=await linuxOwnershipSnapshot();assert.ok(rows.some(row=>row.pid===process.pid&&row.commandLine));}
 catch(error){assert.equal((error as any).code,'PROCESS_OWNERSHIP_PERMISSION_DENIED');assert.ok(Number.isSafeInteger((error as any).pid));t.diagnostic('Current host protects some same-user process metadata; reviewed cleanup remains blocked, as required.');}
});
