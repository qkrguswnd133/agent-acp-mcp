import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {acquireMaintenanceLock,releaseOwnedMaintenanceLocks,releaseOwnedMaintenanceLocksSync,type MaintenanceLockRecord} from '../src/maintenance-lock.js';
import type {ProcessInventory,RecordedProcessIdentity} from '../src/process-inventory.js';

const base=Date.parse('2026-10-17T10:00:00.000Z'),created='2026-10-17T09:00:00.000Z';
function row(pid:number,createdAt=created):RecordedProcessIdentity{return {pid,createdAt,creationKey:null,imageName:'node',observedAt:new Date(base).toISOString()};}
function inventory(others:RecordedProcessIdentity[]=[],complete=true):ProcessInventory{return {complete,observedAt:new Date(base).toISOString(),processes:[row(process.pid),...others]};}
function record(overrides:Partial<MaintenanceLockRecord>={}):MaintenanceLockRecord{return {version:1,ownerPid:999_999_999,ownerCreatedAt:created,ownerCreationKey:null,operation:'cleanup',acquiredAt:new Date(base-60_000).toISOString(),expiresAt:new Date(base+60_000).toISOString(),leaseToken:randomUUID(),...overrides};}
async function fixture(t:{after:(fn:()=>Promise<void>)=>void}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'maintenance-lock-')),file=path.join(root,'job.json.cleanup.lock');
 t.after(async()=>{await releaseOwnedMaintenanceLocks();await fs.rm(root,{recursive:true,force:true});});return {root,file};
}
const options=(others:RecordedProcessIdentity[]=[])=>({operation:'cleanup',jobId:'job',processInventory:async()=>inventory(others),now:()=>base});
const save=(file:string,value:unknown)=>fs.writeFile(file,JSON.stringify(value));

test('lease publishes owner identity, operation, timestamps and unique fencing token',async t=>{
 const {file}=await fixture(t),lease=await acquireMaintenanceLock(file,options());
 const value=JSON.parse(await fs.readFile(file,'utf8'));
 assert.equal(value.ownerPid,process.pid);assert.equal(value.ownerCreatedAt,created);assert.equal(value.operation,'cleanup');assert.equal(value.jobId,'job');
 assert.equal(value.leaseToken,lease.record.leaseToken);assert.ok(Date.parse(value.expiresAt)>Date.parse(value.acquiredAt));assert.deepEqual(lease.recovered,[]);
 await lease.assertOwned();await lease.release();await assert.rejects(fs.lstat(file),{code:'ENOENT'});await lease.release();
});
for(const [name,reason,previous,others] of [
 ['absent owner','owner_missing',record(),[]],
 ['reused PID','pid_reused',record({ownerPid:83}),[row(83,'2026-10-17T09:30:00.000Z')]],
 ['expired live owner','expired',record({ownerPid:84,expiresAt:new Date(base-1).toISOString()}),[row(84)]],
] as const){
 test(`recovers ${name} and returns complete recovery audit`,async t=>{
  const {file}=await fixture(t);await save(file,previous);
  const lease=await acquireMaintenanceLock(file,options([...others]));assert.equal(lease.recovered[0].reason,reason);assert.deepEqual(lease.recovered[0].previous,previous);
  assert.equal(lease.recovered[0].lockFile,file);assert.notEqual(lease.record.leaseToken,previous.leaseToken);await lease.release();
 });
}
test('creation keys distinguish a reused PID even when rounded timestamps match',async t=>{
 const {file}=await fixture(t),previous=record({ownerPid:83,ownerCreationKey:'windows:638962884000000001'});await save(file,previous);
 const lease=await acquireMaintenanceLock(file,{...options(),processInventory:async()=>inventory([{...row(83),creationKey:'windows:638962884000000002'}])});
 assert.equal(lease.recovered[0].reason,'pid_reused');await lease.release();
});
test('live valid other gateway owner remains protected',async t=>{
 const {file}=await fixture(t),previous=record({ownerPid:85});await save(file,previous);
 await assert.rejects(acquireMaintenanceLock(file,options([row(85)])),/already in progress/);assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),previous);
});
test('incomplete process inventory and unavailable creation identity fail closed',async t=>{
 const {file}=await fixture(t),previous=record();await save(file,previous);
 await assert.rejects(acquireMaintenanceLock(file,{...options(),processInventory:async()=>inventory([],false)}),/already in progress/);
 await assert.rejects(acquireMaintenanceLock(file,{...options(),processInventory:async()=>({complete:true,observedAt:new Date(base).toISOString(),processes:[]})}),/creation identity/);
 assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),previous);
});
test('old empty legacy lock is recovered only with no active local operation',async t=>{
 const {file}=await fixture(t);await fs.writeFile(file,'');await fs.utimes(file,new Date(base-31*60_000),new Date(base-31*60_000));
 await assert.rejects(acquireMaintenanceLock(file,{...options(),activeLocal:()=>true}),/already in progress/);assert.equal((await fs.stat(file)).size,0);
 const lease=await acquireMaintenanceLock(file,{...options(),activeLocal:()=>false});assert.equal(lease.recovered[0].reason,'legacy_empty');assert.equal('legacy' in lease.recovered[0].previous,true);await lease.release();
});
test('fresh empty, partial, malformed and unknown lock records are never reclaimed',async t=>{
 const {file}=await fixture(t);
 for(const raw of ['', '{"ownerPid":', ' ', JSON.stringify({...record(),expiresAt:'bad'}),JSON.stringify({...record(),version:2})]){
  await fs.writeFile(file,raw);await fs.utimes(file,new Date(base),new Date(base));
  await assert.rejects(acquireMaintenanceLock(file,options()),/already in progress/);assert.equal(await fs.readFile(file,'utf8'),raw);
 }
});
test('local activity also protects recoverable modern locks',async t=>{
 const {file}=await fixture(t),previous=record();await save(file,previous);
 await assert.rejects(acquireMaintenanceLock(file,{...options(),activeLocal:true}),/already in progress/);assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),previous);
});
test('simultaneous acquisition and stale recovery each admit exactly one holder',async t=>{
 const {file}=await fixture(t);
 for(const stale of [false,true]){
  if(stale)await save(file,record());
  const attempts=await Promise.allSettled(Array.from({length:12},()=>acquireMaintenanceLock(file,options()))),successes=attempts.filter(result=>result.status==='fulfilled');
  assert.equal(successes.length,1);assert.equal(attempts.filter(result=>result.status==='rejected').length,11);
  assert.equal(successes[0].value.recovered.length,stale?1:0);await successes[0].value.release();
 }
});
test('independent gateway processes cannot acquire the same lease concurrently',{timeout:30_000},async t=>{
 const {file}=await fixture(t),moduleUrl=new URL('../src/maintenance-lock.js',import.meta.url).href,inventoryUrl=new URL('../src/process-inventory.js',import.meta.url).href;
 const script=`import {acquireMaintenanceLock} from ${JSON.stringify(moduleUrl)};
 import {readProcessInventory} from ${JSON.stringify(inventoryUrl)};
 const snapshot=await readProcessInventory();process.send({ready:true});
 await new Promise(resolve=>process.once('message',resolve));
 try{const lease=await acquireMaintenanceLock(process.argv[1],{operation:'cleanup',processInventory:async()=>snapshot});
 process.send({acquired:true});await new Promise(resolve=>process.once('message',resolve));await lease.release();process.exit(0);
 }catch(error){process.send({acquired:false,error:String(error)});process.exit(0);}`;
 const children=Array.from({length:3},()=>spawn(process.execPath,['--input-type=module','-e',script,file],{windowsHide:true,stdio:['ignore','pipe','pipe','ipc']}));
 t.after(()=>{for(const child of children)if(child.exitCode===null)child.kill();});
 const results=children.map(child=>new Promise<{acquired:boolean;error?:string}>(resolve=>{child.on('message',value=>{if((value as {acquired?:boolean}).acquired!==undefined)resolve(value as {acquired:boolean;error?:string});});}));
 await Promise.all(children.map(child=>new Promise<void>((resolve,reject)=>{let output='';child.stderr?.on('data',chunk=>{output+=chunk;});child.on('message',value=>{if((value as {ready?:boolean}).ready)resolve();});child.once('error',reject);child.once('exit',code=>{if(code!==0)reject(Error(output||`Child exited ${code}`));});})));
 for(const child of children)child.send('start');const values=await Promise.all(results);
 assert.equal(values.filter(value=>value.acquired).length,1,JSON.stringify(values));
 for(const [index,value] of values.entries())if(value.acquired)children[index].send('release');else assert.match(value.error??'',/already in progress/);
 await Promise.all(children.filter(child=>child.exitCode===null).map(child=>new Promise<void>(resolve=>child.once('exit',()=>resolve()))));
});
test('rechecks the lock after asynchronous inventory so a replacement is preserved',async t=>{
 const {file}=await fixture(t);await save(file,record());let resume!:(value:ProcessInventory)=>void;
 const attempt=acquireMaintenanceLock(file,{...options(),processInventory:()=>new Promise(resolve=>{resume=resolve;})});
 const replacement=record({ownerPid:85});await save(file,replacement);resume(inventory([row(85)]));
 await assert.rejects(attempt,/already in progress/);assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),replacement);
});
test('a lease cannot renew after expiration even if its token is still present',async t=>{
 const {file}=await fixture(t);let time=base;
 const lease=await acquireMaintenanceLock(file,{...options(),leaseMs:1000,heartbeatMs:500,now:()=>time});time+=1001;
 await assert.rejects(lease.assertOwned(),/lost or expired/);await assert.rejects(lease.renew(),/lost or expired/);await lease.release();
});
test('renewal and release cannot overwrite or delete a replacement owner token',async t=>{
 const {file}=await fixture(t),lease=await acquireMaintenanceLock(file,options()),replacement=record({ownerPid:85});await save(file,replacement);
 await assert.rejects(lease.assertOwned(),/lost or expired/);await lease.release();assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),replacement);
});
test('automatic heartbeats extend long operations and release stops the timer',async t=>{
 const {file}=await fixture(t),lease=await acquireMaintenanceLock(file,{...options(),now:Date.now,leaseMs:600,heartbeatMs:30}),initial=Date.parse(lease.record.expiresAt);
 await new Promise(resolve=>setTimeout(resolve,150));assert.ok(Date.parse(lease.record.expiresAt)>initial);await lease.assertOwned();await lease.release();
 await new Promise(resolve=>setTimeout(resolve,60));await assert.rejects(fs.lstat(file),{code:'ENOENT'});
});
test('5000 mutation fences do not republish the lock, create guards, or query processes',async t=>{
 const {file}=await fixture(t);let queries=0;
 const lease=await acquireMaintenanceLock(file,{...options(),processInventory:async()=>{queries++;return inventory();}}),before=await fs.stat(file),guardBefore=await fs.stat(file+'.guard'),expires=lease.record.expiresAt;
 for(let i=0;i<5000;i++)await lease.assertOwned();
 const after=await fs.stat(file),guardAfter=await fs.stat(file+'.guard');assert.equal(after.ino,before.ino);assert.equal(after.mtimeMs,before.mtimeMs);assert.equal(guardAfter.mtimeMs,guardBefore.mtimeMs);
 assert.equal(lease.record.expiresAt,expires);assert.equal(queries,1);assert.deepEqual(await fs.readdir(file+'.guard'),[]);await lease.release();
});
test('a mutation fence extends a still-valid lease close to expiry',async t=>{
 const {file}=await fixture(t);let time=base;
 const lease=await acquireMaintenanceLock(file,{...options(),leaseMs:9000,heartbeatMs:3000,now:()=>time}),expires=lease.record.expiresAt;time+=7000;
 await lease.assertOwned();assert.ok(Date.parse(lease.record.expiresAt)>Date.parse(expires));await lease.release();
});
test('abandoned unique guard claims are recoverable without deleting a successor guard',async t=>{
 const {file}=await fixture(t),directory=file+'.guard',token='00000000-0000-0000-0000-000000000001';await fs.mkdir(directory);
 await save(path.join(directory,token+'.choosing.json'),{token,ownerPid:process.pid,ownerCreatedAt:created,ownerCreationKey:null,choosing:true,ticket:0});
 const lease=await acquireMaintenanceLock(file,options());assert.deepEqual(await fs.readdir(directory),[]);await lease.release();
});
test('malformed guard claims fail closed and preserve their evidence',async t=>{
 const {file}=await fixture(t),directory=file+'.guard',token=randomUUID();await fs.mkdir(directory);await fs.writeFile(path.join(directory,token+'.json'),'{');
 await assert.rejects(acquireMaintenanceLock(file,options()),/Incomplete maintenance guard/);assert.equal(await fs.readFile(path.join(directory,token+'.json'),'utf8'),'{');
});
test('shutdown helpers release only locks owned by this process and token',async t=>{
 const {root,file}=await fixture(t),other=path.join(root,'other.lock'),third=path.join(root,'third.lock');
 await acquireMaintenanceLock(file,options());await acquireMaintenanceLock(other,options());const replacement=record({ownerPid:85});await save(other,replacement);
 releaseOwnedMaintenanceLocksSync();await assert.rejects(fs.lstat(file),{code:'ENOENT'});assert.deepEqual(JSON.parse(await fs.readFile(other,'utf8')),replacement);
 await acquireMaintenanceLock(third,options());await releaseOwnedMaintenanceLocks();await assert.rejects(fs.lstat(third),{code:'ENOENT'});assert.deepEqual(JSON.parse(await fs.readFile(other,'utf8')),replacement);
});
test('lock and ancestor links/junctions are rejected without changing their target',async t=>{
 const {root,file}=await fixture(t),target=path.join(root,'target'),linked=path.join(root,'linked');await fs.mkdir(target);const targetFile=path.join(target,'lock');await fs.writeFile(targetFile,'untouched');
 await fs.symlink(target,linked,process.platform==='win32'?'junction':'dir');
 await assert.rejects(acquireMaintenanceLock(path.join(linked,'lock'),options()),/Unsafe maintenance lock path/);assert.equal(await fs.readFile(targetFile,'utf8'),'untouched');
 try{await fs.symlink(targetFile,file,'file');}catch(error){if(['EPERM','EACCES'].includes((error as NodeJS.ErrnoException).code??''))return;throw error;}
 await assert.rejects(acquireMaintenanceLock(file,options()),/Unsafe maintenance lock path/);assert.equal(await fs.readFile(targetFile,'utf8'),'untouched');
});
test('hardlinked locks and linked guard directories are rejected',async t=>{
 const {root,file}=await fixture(t),target=path.join(root,'target');await fs.mkdir(target);const targetFile=path.join(target,'source');await save(targetFile,record());await fs.link(targetFile,file);
 await assert.rejects(acquireMaintenanceLock(file,options()),/Unsafe maintenance lock file/);await fs.unlink(file);await fs.rmdir(file+'.guard');
 await fs.symlink(target,file+'.guard',process.platform==='win32'?'junction':'dir');await assert.rejects(acquireMaintenanceLock(file,options()),/Unsafe maintenance lock path/);
 assert.equal((await fs.readdir(target)).length,1);
});
