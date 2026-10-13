import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {listLegacyGradleHomes,cleanupLegacyGradleHome,type LegacyGradleOptions} from '../src/legacy-gradle.js';
import {persistJobPayload} from '../src/job-payload.js';

async function fixture(t:any){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'legacy-gradle-fixture-')),cacheId=randomUUID(),jobId=randomUUID(),gradleRoot=path.join(root,'legacy','gradle'),cache=path.join(gradleRoot,cacheId),jobs=path.join(root,'jobs');
 await fs.mkdir(path.join(cache,'wrapper'),{recursive:true});await fs.mkdir(jobs);await fs.writeFile(path.join(cache,'wrapper','distribution.zip'),'fixture zip');await fs.writeFile(path.join(cache,'artifact.jar'),'fixture jar');
 const record:any={job_id:jobId,status:'completed',ownerPid:400,startedAt:'2026-10-12T00:00:00.000Z',finishedAt:'2026-10-12T00:01:00.000Z',result:{results:[{provider:'codex',gradleUserHome:cache,processCleanup:{trackedPids:[],remainingPids:[],verified:true}}]}};
 const save=()=>fs.writeFile(path.join(jobs,jobId+'.json'),JSON.stringify(record));await save();
 const options:LegacyGradleOptions={jobsDirectory:jobs,roots:[gradleRoot],currentPid:999999,snapshot:async()=>[{pid:500,parentPid:1,name:'node',commandLine:'node gateway.js'}]};
 t.after(()=>fs.rm(root,{recursive:true,force:true}));return {root,cache,cacheId,jobId,gradleRoot,jobs,record,save,options};
}
test('legacy Gradle listing matches authoritative path, not cache UUID as job ID; default cleanup is read-only',async t=>{
 const f=await fixture(t);assert.notEqual(f.cacheId,f.jobId);const listed=await listLegacyGradleHomes(f.options);assert.equal(listed.caches.length,1);assert.deepEqual(listed.caches[0].jobIds,[f.jobId]);assert.equal(listed.caches[0].eligible,true);assert.equal(listed.caches[0].bytes,22);assert.equal(listed.caches[0].fileCount,2);
 const result=await cleanupLegacyGradleHome({...f.options,path:f.cache});assert.equal(result.status,'dry_run');assert.equal(result.removedBytes,0);assert.deepEqual(result.removedPaths,[]);assert.equal(await fs.readFile(path.join(f.cache,'artifact.jar'),'utf8'),'fixture jar');await assert.rejects(fs.stat(path.join(f.gradleRoot,'.legacy-gradle-cleanup.lock')));
});
test('explicit cleanup removes only validated owned files and returns actual removed bytes; job record survives',async t=>{
 const f=await fixture(t),jobBefore=await fs.readFile(path.join(f.jobs,f.jobId+'.json'));const result=await cleanupLegacyGradleHome({...f.options,path:f.cache,dryRun:false});assert.equal(result.status,'removed');assert.equal(result.removedBytes,22);assert.equal(result.removedPaths.length,2);await assert.rejects(fs.stat(f.cache));assert.deepEqual(await fs.readFile(path.join(f.jobs,f.jobId+'.json')),jobBefore);
});
test('unmatched UUID, nonterminal matched job and any ongoing job all block cleanup',async t=>{
 const f=await fixture(t);f.record.result.results[0].gradleUserHome=path.join(f.gradleRoot,randomUUID());await f.save();let result=await cleanupLegacyGradleHome({...f.options,path:f.cache,dryRun:false});assert.equal(result.status,'blocked');assert.match(result.blockingReasons.join(' '),/authoritative/);
 f.record.result.results[0].gradleUserHome=f.cache;f.record.status='running';await f.save();result=await cleanupLegacyGradleHome({...f.options,path:f.cache,dryRun:false});assert.equal(result.status,'blocked');assert.match(result.blockingReasons.join(' '),/ongoing jobs|still queued/);assert.ok(await fs.stat(f.cache));
 f.record.status='completed';await f.save();const other=randomUUID();await fs.writeFile(path.join(f.jobs,other+'.json'),JSON.stringify({job_id:other,status:'queued'}));result=await cleanupLegacyGradleHome({...f.options,path:f.cache,dryRun:false});assert.equal(result.status,'blocked');
});
test('busy Gradle process, unreadable process command and unavailable snapshot preserve cache',async t=>{
 const f=await fixture(t);for(const snapshot of [async()=>[{pid:800,parentPid:1,name:'java.exe',commandLine:`java -Dgradle.user.home="${f.cache}" GradleDaemon`}],async()=>[{pid:800,parentPid:1,name:'java',commandLine:null}],async()=>{throw Error('unavailable');}]){const result=await cleanupLegacyGradleHome({...f.options,path:f.cache,dryRun:false,snapshot});assert.equal(result.status,'blocked');assert.ok(await fs.stat(f.cache));}
});
test('interrupted job requires absent owner; terminal job may belong to idle live Gateway',async t=>{
 const f=await fixture(t);const snapshot=async()=>[{pid:400,parentPid:1,name:'node',commandLine:'node gateway.js'}];let result=await cleanupLegacyGradleHome({...f.options,path:f.cache,snapshot});assert.equal(result.status,'dry_run');
 f.record.status='interrupted';await f.save();result=await cleanupLegacyGradleHome({...f.options,path:f.cache,snapshot});assert.equal(result.status,'blocked');assert.match(result.blockingReasons.join(' '),/live owner|owner process is still alive/);
 result=await cleanupLegacyGradleHome({...f.options,path:f.cache});assert.equal(result.status,'dry_run');
});
test('links, shared hardlinks and explicitly shared Gradle homes are never eligible',async t=>{
 const f=await fixture(t);const outside=path.join(f.root,'outside.jar');await fs.writeFile(outside,'shared bytes');await fs.link(outside,path.join(f.cache,'hardlinked.jar'));let result=await listLegacyGradleHomes(f.options);assert.equal(result.caches[0].eligible,false);assert.match(result.caches[0].blockingReasons.join(' '),/hardlink/);await fs.unlink(path.join(f.cache,'hardlinked.jar'));
 await assert.rejects(cleanupLegacyGradleHome({...f.options,path:f.cache,dryRun:false,sharedUserHomes:[f.cache]}),/Shared user/);assert.equal(await fs.readFile(outside,'utf8'),'shared bytes');
 const link=path.join(f.cache,'linked');try{await fs.symlink(f.root,link,process.platform==='win32'?'junction':'dir');}catch(error){t.diagnostic('Symlink fixture unavailable: '+(error as Error).message);return;}result=await listLegacyGradleHomes(f.options);assert.equal(result.caches[0].eligible,false);assert.match(result.caches[0].blockingReasons.join(' '),/link/);
});
test('paths outside allowlist and nested/non-UUID paths fail before mutation',async t=>{
 const f=await fixture(t);for(const target of [path.join(f.root,randomUUID()),path.join(f.cache,randomUUID()),path.join(f.gradleRoot,'shared')])await assert.rejects(cleanupLegacyGradleHome({...f.options,path:target,dryRun:false}),/allowlisted|UUID/);assert.ok(await fs.stat(f.cache));
});
test('full payload hydration recovers ownership; missing artifact or corrupt job records block cleanup',async t=>{
 const f=await fixture(t);f.record.result.rawEvents='tool event\n'.repeat(20000);const stored=await persistJobPayload(f.record,f.jobs);assert.ok(stored.payload.artifact);await fs.writeFile(path.join(f.jobs,f.jobId+'.json'),JSON.stringify(stored));let result=await cleanupLegacyGradleHome({...f.options,path:f.cache});assert.equal(result.status,'dry_run');
 await fs.unlink(path.join(f.jobs,...stored.payload.artifact.path.split('/')));result=await cleanupLegacyGradleHome({...f.options,path:f.cache,dryRun:false});assert.equal(result.status,'blocked');assert.match(result.blockingReasons.join(' '),/Authoritative job/);assert.ok(await fs.stat(f.cache));
});
test('live tracked processes are rechecked and prevent cache removal',async t=>{
 const f=await fixture(t);f.record.result.results[0].processCleanup.trackedPids=[700];await f.save();let calls=0;
 const result=await cleanupLegacyGradleHome({...f.options,path:f.cache,dryRun:false,trackedProcessesAbsent:async job=>{calls++;assert.equal(job.job_id,f.jobId);throw Error('Tracked process 700 is alive');}});assert.equal(result.status,'blocked');assert.equal(calls,1);assert.ok(await fs.stat(f.cache));
});
test('fresh second process check detects a process appearing after the dry inventory',async t=>{
 const f=await fixture(t);let calls=0;const result=await cleanupLegacyGradleHome({...f.options,path:f.cache,dryRun:false,snapshot:async()=>++calls===1?[{pid:500,parentPid:1,name:'node',commandLine:'node gateway.js'}]:[{pid:800,parentPid:1,name:'java',commandLine:`java ${f.cache}`}]});assert.equal(result.status,'blocked');assert.equal(result.removedBytes,0);assert.ok(await fs.stat(f.cache));
});
test('existing cleanup lock is not stolen or deleted',async t=>{
 const f=await fixture(t),lock=path.join(f.gradleRoot,'.legacy-gradle-cleanup.lock');await fs.writeFile(lock,'existing owner');const result=await cleanupLegacyGradleHome({...f.options,path:f.cache,dryRun:false});assert.equal(result.status,'blocked');assert.match(result.blockingReasons.join(' '),/holds the lock/);assert.equal(await fs.readFile(lock,'utf8'),'existing owner');
});
test('parent idle guard is checked before inventory and again before any deletion',async t=>{
 const f=await fixture(t);let checks=0;const result=await cleanupLegacyGradleHome({...f.options,path:f.cache,dryRun:false,assertIdle:()=>{if(++checks===2)throw Error('Parent observed a newly queued job');}});assert.equal(result.status,'blocked');assert.equal(checks,2);assert.equal(result.removedBytes,0);assert.ok(await fs.stat(f.cache));
});
test('reused historical tracked PIDs do not block an owned idle cache forever',async t=>{
 const f=await fixture(t);f.record.result.results[0].processCleanup.trackedPids=[700];await f.save();let scans=0;const observedAt='2026-10-13T00:00:00.000Z';
 const result=await cleanupLegacyGradleHome({...f.options,path:f.cache,identitySnapshot:async()=>{scans++;return {complete:true,observedAt,processes:[{pid:700,parentPid:1,createdAt:'2026-10-12T05:00:00.000Z',imageName:'unrelated.exe',observedAt}]};}});assert.equal(result.status,'dry_run');assert.equal(scans,1);
});
test('a shared cache alias pointing into a legacy home protects the resolved target',async t=>{
 const f=await fixture(t),alias=path.join(f.root,'shared-cache-alias');try{await fs.symlink(f.cache,alias,process.platform==='win32'?'junction':'dir');}catch(error){t.skip('Symlink fixture unavailable: '+(error as Error).message);return;}
 await assert.rejects(cleanupLegacyGradleHome({...f.options,path:f.cache,dryRun:false,sharedUserHomes:[alias]}),/Shared user/);assert.ok(await fs.stat(f.cache));
});
