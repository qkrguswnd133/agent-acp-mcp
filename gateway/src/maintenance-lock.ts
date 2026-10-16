import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readProcessInventory,sameProcessCreation,validCreationTime,type ProcessInventory,type RecordedProcessIdentity} from './process-inventory.js';

const DEFAULT_LEASE_MS=120_000,LEGACY_STALE_MS=30*60_000;
const busy=()=>Error('Worktree maintenance already in progress');
const lost=()=>Error('Worktree maintenance lease lost or expired; refusing further mutations');
type InventoryReader=()=>Promise<ProcessInventory>;
export interface MaintenanceLockRecord {
 version:1;ownerPid:number;ownerCreatedAt:string;ownerCreationKey:string|null;
 operation:string;jobId?:string;acquiredAt:string;expiresAt:string;leaseToken:string;
}
export interface MaintenanceLockRecovery {
 lockFile:string;reason:'owner_missing'|'pid_reused'|'expired'|'legacy_empty';recoveredAt:string;
 previous:MaintenanceLockRecord|{legacy:true;modifiedAt:string};
}
export interface MaintenanceLockOptions {
 operation:string;jobId?:string;activeLocal?:boolean|(()=>boolean);
 /** Supply the operation's shared inventory. Heartbeats do not reuse this snapshot. */
 processInventory?:InventoryReader;leaseMs?:number;heartbeatMs?:number;legacyStaleMs?:number;now?:()=>number;
}
export interface MaintenanceLease {
 readonly file:string;readonly record:MaintenanceLockRecord;readonly recovered:MaintenanceLockRecovery[];
 /** Reads the fencing token/expiry; extends only when nearing expiration. */
 assertOwned():Promise<void>;renew():Promise<void>;release():Promise<void>;
}
interface OwnedLease extends MaintenanceLease {releaseSync():void;}
interface GuardClaim {token:string;ownerPid:number;ownerCreatedAt:string;ownerCreationKey:string|null;choosing:boolean;ticket:number;}
interface Guard {directory:string;file:string;selectingFile:string;claim:GuardClaim;}
interface Snapshot {raw:string;stat:fs.Stats;}
const owned=new Set<OwnedLease>(),localClaims=new Set<string>();
let cachedSelf:RecordedProcessIdentity|undefined,selfInventory:Promise<ProcessInventory>|undefined;
const key=(file:string)=>process.platform==='win32'?path.resolve(file).toLowerCase():path.resolve(file);
const missing=(error:unknown)=>(error as NodeJS.ErrnoException).code==='ENOENT';
const identity=(owner:{ownerPid:number;ownerCreatedAt:string;ownerCreationKey:string|null}):RecordedProcessIdentity=>({pid:owner.ownerPid,createdAt:owner.ownerCreatedAt,creationKey:owner.ownerCreationKey,imageName:null,observedAt:owner.ownerCreatedAt});
function validOwner(value:any):boolean{return !!value&&Number.isSafeInteger(value.ownerPid)&&value.ownerPid>0&&validCreationTime(value.ownerCreatedAt)!==undefined&&(value.ownerCreationKey===null||typeof value.ownerCreationKey==='string');}
function validRecord(value:any):value is MaintenanceLockRecord {
 return validOwner(value)&&value.version===1&&typeof value.operation==='string'&&!!value.operation.trim()&&typeof value.leaseToken==='string'&&/^[a-f0-9-]{36}$/i.test(value.leaseToken)
  &&validCreationTime(value.acquiredAt)!==undefined&&validCreationTime(value.expiresAt)!==undefined&&Date.parse(value.expiresAt)>Date.parse(value.acquiredAt)
  &&(value.jobId===undefined||typeof value.jobId==='string');
}
/** Walk ancestors with lstat: neither lock paths nor guard paths may traverse links/junctions. */
function assertSafePath(file:string,allowMissingLeaf=false):void {
 const absolute=path.resolve(file),root=path.parse(absolute).root,parts=absolute.slice(root.length).split(path.sep).filter(Boolean);let current=root;
 for(let i=0;i<parts.length;i++){
  current=path.join(current,parts[i]);let stat:fs.Stats;
  try{stat=fs.lstatSync(current);}catch(error){if(allowMissingLeaf&&i===parts.length-1&&missing(error))return;throw error;}
  if(stat.isSymbolicLink()||(i<parts.length-1&&!stat.isDirectory()))throw Error(`Unsafe maintenance lock path: ${current}`);
 }
}
function snapshot(file:string):Snapshot|undefined {
 assertSafePath(file,true);let stat:fs.Stats;try{stat=fs.lstatSync(file);}catch(error){if(missing(error))return;throw error;}
 if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>64*1024)throw Error(`Unsafe maintenance lock file: ${file}`);
 const handle=fs.openSync(file,'r');try{
  const opened=fs.fstatSync(handle);if(opened.dev!==stat.dev||opened.ino!==stat.ino)throw busy();
  const raw=fs.readFileSync(handle,'utf8');return {raw,stat:opened};
 }finally{fs.closeSync(handle);}
}
function parseRecord(value:Snapshot|undefined):MaintenanceLockRecord|undefined {
 if(!value)return;try{const record=JSON.parse(value.raw);return validRecord(record)?record:undefined;}catch{return;}
}
function unchanged(file:string,previous:Snapshot):boolean {
 const next=snapshot(file);return !!next&&next.stat.dev===previous.stat.dev&&next.stat.ino===previous.stat.ino&&next.raw===previous.raw;
}
/** Fully initialize before publication, so a crash never exposes an empty/partial JSON lock. */
function publish(file:string,value:unknown,create:boolean):void {
 assertSafePath(file,true);const temporary=path.join(path.dirname(file),`.maintenance-${randomUUID()}.tmp`);
 try{fs.writeFileSync(temporary,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});if(create)fs.linkSync(temporary,file);else fs.renameSync(temporary,file);}
 finally{try{fs.unlinkSync(temporary);}catch(error){if(!missing(error))throw error;}}
}
async function replace<T>(file:string,makeValue:()=>T):Promise<T>{
 for(let attempt=0;;attempt++)try{const value=makeValue();publish(file,value,false);return value;}catch(error){
  if(attempt>=9||!['EPERM','EACCES','EBUSY'].includes((error as NodeJS.ErrnoException).code??''))throw error;
  // Windows scanners can briefly hold an otherwise valid destination handle.
  await new Promise(resolve=>setTimeout(resolve,10));
 }
}
function readClaims(directory:string):GuardClaim[] {
 assertSafePath(directory);const result=new Map<string,GuardClaim>();
 for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
  if(entry.name.startsWith('.maintenance-')&&entry.name.endsWith('.tmp'))continue;
  if(!/^[a-f0-9-]{36}(?:\.choosing)?\.json$/i.test(entry.name)||!entry.isFile()||entry.isSymbolicLink())throw Error('Unsafe maintenance guard entry');
  let value:unknown;try{value=JSON.parse(fs.readFileSync(path.join(directory,entry.name),'utf8'));}catch(error){if(missing(error))continue;throw Error('Incomplete maintenance guard; refusing recovery');}
  const claim=value as GuardClaim;
  const selecting=entry.name.endsWith('.choosing.json');
  if(!validOwner(claim)||claim.token+(selecting?'.choosing.json':'.json')!==entry.name||typeof claim.choosing!=='boolean'||!Number.isSafeInteger(claim.ticket)||claim.ticket<0||claim.choosing!==selecting)throw Error('Malformed maintenance guard; refusing recovery');
  if(!result.has(claim.token)||!claim.choosing)result.set(claim.token,claim);
 }
 return [...result.values()];
}
/**
 * Bakery ordering uses unique, never-reused claim names. Unlike a reusable guard
 * pathname, reclaiming a crashed claimant cannot delete a successor's guard.
 * Selection and the protected filesystem mutation are synchronous and short.
 */
function beginGuard(file:string,owner:MaintenanceLockRecord):Guard {
 const directory=file+'.guard';assertSafePath(directory,true);try{fs.mkdirSync(directory,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
 assertSafePath(directory);if(!fs.lstatSync(directory).isDirectory())throw Error('Unsafe maintenance guard directory');
 const token=randomUUID(),claim:GuardClaim={token,ownerPid:owner.ownerPid,ownerCreatedAt:owner.ownerCreatedAt,ownerCreationKey:owner.ownerCreationKey,choosing:true,ticket:0};
 const guard={directory,file:path.join(directory,token+'.json'),selectingFile:path.join(directory,token+'.choosing.json'),claim};localClaims.add(token);
 try{
  publish(guard.selectingFile,claim,true);claim.ticket=1+Math.max(0,...readClaims(directory).map(row=>row.ticket));claim.choosing=false;publish(guard.file,claim,true);return guard;
 }catch(error){endGuard(guard);throw error;}
}
function endGuard(guard:Guard):void {
 localClaims.delete(guard.claim.token);
 for(const file of [guard.file,guard.selectingFile])try{
  assertSafePath(file,true);const value=JSON.parse(fs.readFileSync(file,'utf8')) as GuardClaim;
  if(value.token===guard.claim.token)fs.unlinkSync(file);
 }catch(error){if(!missing(error))throw error;}
}
function blockers(guard:Guard):GuardClaim[]{return readClaims(guard.directory).filter(row=>row.token!==guard.claim.token&&(row.choosing||row.ticket<guard.claim.ticket||(row.ticket===guard.claim.ticket&&row.token<guard.claim.token)));}
function assertGuard(guard:Guard):void {
 assertSafePath(guard.file);const current=JSON.parse(fs.readFileSync(guard.file,'utf8')) as GuardClaim;
 if(current.token!==guard.claim.token||current.choosing||current.ticket!==guard.claim.ticket)throw busy();
}
async function withGuard<T>(file:string,owner:MaintenanceLockRecord,action:()=>T|Promise<T>):Promise<T>{
 const guard=beginGuard(file,owner),deadline=Date.now()+1500;
 try{
  while(true){
   const pending=blockers(guard);if(!pending.length)break;
   let inventory:ProcessInventory|undefined;
   for(const peer of pending){
    let abandoned=false;
    if(peer.ownerPid===process.pid&&sameProcessCreation(identity(peer),identity(owner))===true)abandoned=!localClaims.has(peer.token);
    else {
     inventory??=await readProcessInventory();const processRow=inventory.processes.find(row=>row.pid===peer.ownerPid);
     abandoned=processRow?sameProcessCreation(identity(peer),processRow)===false:inventory.complete;
    }
    if(abandoned){
     for(const suffix of ['.json','.choosing.json']){
      const peerFile=path.join(guard.directory,peer.token+suffix);assertSafePath(peerFile,true);
      // UUID paths are never reused, including after a crash or PID reuse.
      try{const current=JSON.parse(fs.readFileSync(peerFile,'utf8')) as GuardClaim;if(current.token===peer.token)fs.unlinkSync(peerFile);}catch(error){if(!missing(error))throw error;}
     }
    }
   }
   if(!blockers(guard).length)break;if(Date.now()>=deadline)throw busy();
   await new Promise(resolve=>setTimeout(resolve,10));
  }
  assertGuard(guard);return await action();
 }finally{endGuard(guard);}
}
function withGuardSync(file:string,owner:MaintenanceLockRecord,action:()=>void):void {
 const guard=beginGuard(file,owner);try{if(blockers(guard).length)return;assertGuard(guard);action();}finally{endGuard(guard);}
}
function active(options:MaintenanceLockOptions):boolean{return typeof options.activeLocal==='function'?options.activeLocal():options.activeLocal===true;}
function recoveryReason(existing:Snapshot,record:MaintenanceLockRecord|undefined,inventory:ProcessInventory,now:number,options:MaintenanceLockOptions):MaintenanceLockRecovery['reason']|undefined {
 if(active(options))return;
 if(existing.raw.length===0)return now-existing.stat.mtimeMs>=(options.legacyStaleMs??LEGACY_STALE_MS)?'legacy_empty':undefined;
 if(!record)return; // Partial, malformed, and unknown formats are never stolen.
 if([...owned].some(lease=>lease.record.leaseToken===record.leaseToken))return;
 const processRow=inventory.processes.find(row=>row.pid===record.ownerPid);
 if(!processRow&&inventory.complete)return 'owner_missing';
 if(processRow&&sameProcessCreation(identity(record),processRow)===false)return 'pid_reused';
 if(Date.parse(record.expiresAt)<=now)return 'expired';
 return;
}
export async function acquireMaintenanceLock(file:string,options:MaintenanceLockOptions):Promise<MaintenanceLease>{
 file=path.resolve(file);assertSafePath(file,true);
 if(!options.operation.trim())throw Error('Maintenance operation is required');
 if([...owned].some(lease=>key(lease.file)===key(file)))throw busy();
 const leaseMs=options.leaseMs??DEFAULT_LEASE_MS,heartbeatMs=options.heartbeatMs??Math.max(1,Math.floor(leaseMs/3)),now=options.now??Date.now;
 if(!Number.isFinite(leaseMs)||leaseMs<1||!Number.isFinite(heartbeatMs)||heartbeatMs<1||heartbeatMs>=leaseMs)throw Error('Invalid maintenance lease/heartbeat duration');
 let inventory:ProcessInventory|undefined;
 const getInventory=async()=>inventory??=await (options.processInventory??readProcessInventory)();
 let self:RecordedProcessIdentity|undefined;
 if(options.processInventory)self=(await getInventory()).processes.find(row=>row.pid===process.pid);
 else if(cachedSelf)self=cachedSelf;
 else {
  // Our own creation identity cannot change during this gateway's lifetime.
  // Concurrent first acquisitions also share the single initial CIM query.
  selfInventory??=readProcessInventory().finally(()=>{selfInventory=undefined;});
  inventory=await selfInventory;self=inventory.processes.find(row=>row.pid===process.pid);
  if(self&&validCreationTime(self.createdAt)!==undefined)cachedSelf={...self};
 }
 if(!self||validCreationTime(self.createdAt)===undefined)throw Error('Cannot establish maintenance lock process creation identity');
 const acquired=now();let record:MaintenanceLockRecord={version:1,ownerPid:process.pid,ownerCreatedAt:self.createdAt!,ownerCreationKey:self.creationKey??null,operation:options.operation,...(options.jobId?{jobId:options.jobId}:{}),acquiredAt:new Date(acquired).toISOString(),expiresAt:new Date(acquired+leaseMs).toISOString(),leaseToken:randomUUID()};
 const recovered:MaintenanceLockRecovery[]=[];
 await withGuard(file,record,async()=>{
  const existing=snapshot(file);
  if(existing){
   const previous=parseRecord(existing);
   // A concurrently started owner can be absent from the operation's earlier
   // snapshot. Never turn that stale absence (or PID identity) into recovery.
   const initialInventory=await getInventory();
   const recoveryInventory=previous&&Date.parse(previous.acquiredAt)>Date.parse(initialInventory.observedAt)&&Date.parse(previous.expiresAt)>now()?await readProcessInventory():initialInventory;
   const reason=recoveryReason(existing,previous,recoveryInventory,now(),options);if(!reason)throw busy();
   if(!unchanged(file,existing))throw busy();
   fs.unlinkSync(file);recovered.push({lockFile:file,reason,recoveredAt:new Date(now()).toISOString(),previous:previous??{legacy:true,modifiedAt:existing.stat.mtime.toISOString()}});
  }
  const start=now();record={...record,acquiredAt:new Date(start).toISOString(),expiresAt:new Date(start+leaseMs).toISOString()};
  try{publish(file,record,true);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw busy();throw error;}
 });
 let released=false,invalid=false,timer:NodeJS.Timeout,renewal:Promise<void>|undefined;
 const removeOwned=()=>{released=true;clearInterval(timer);owned.delete(lease);};
 const removeFile=()=>{const existing=snapshot(file),current=parseRecord(existing);if(current?.leaseToken===record.leaseToken&&sameProcessCreation(identity(current),identity(record))===true)fs.unlinkSync(file);removeOwned();};
 const renew=():Promise<void>=>{
  if(released||invalid)return Promise.reject(lost());
  if(renewal)return renewal;
  renewal=withGuard(file,record,async()=>{
   const existing=snapshot(file),current=parseRecord(existing),time=now();
   if(!current||current.leaseToken!==record.leaseToken||sameProcessCreation(identity(current),identity(record))!==true||Date.parse(current.expiresAt)<=time)throw lost();
   record=await replace(file,()=>{
    const renewedAt=now();if(Date.parse(current.expiresAt)<=renewedAt)throw lost();
    return {...current,expiresAt:new Date(renewedAt+leaseMs).toISOString()};
   });
  }).catch(error=>{invalid=true;clearInterval(timer);throw error;}).finally(()=>{renewal=undefined;});return renewal;
 };
 const assertOwned=async():Promise<void>=>{
  if(released||invalid)throw lost();
  try{
   const current=parseRecord(snapshot(file)),time=now();
   if(!current||current.leaseToken!==record.leaseToken||sameProcessCreation(identity(current),identity(record))!==true||Date.parse(current.expiresAt)<=time)throw lost();
   if(Date.parse(current.expiresAt)-time<=leaseMs/3)await renew();
  }catch(error){invalid=true;clearInterval(timer);throw error;}
 };
 const lease:OwnedLease={file,get record(){return {...record};},recovered,assertOwned,renew,
  async release(){if(released)return;clearInterval(timer);await renewal?.catch(()=>{});await withGuard(file,record,removeFile);},
  releaseSync(){if(released)return;clearInterval(timer);withGuardSync(file,record,removeFile);}
 };
 owned.add(lease);timer=setInterval(()=>{void renew().catch(()=>{});},heartbeatMs);timer.unref();return lease;
}
/** Invoke after in-flight maintenance has drained. Each lease verifies its own token. */
export async function releaseOwnedMaintenanceLocks():Promise<void>{await Promise.allSettled([...owned].map(lease=>lease.release()));}
/** Best effort for process exit, when asynchronous filesystem work cannot run. */
export function releaseOwnedMaintenanceLocksSync():void{for(const lease of [...owned])try{lease.releaseSync();}catch{/* Preserve ambiguous locks for later audited recovery. */}}
