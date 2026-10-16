import {execFile} from 'node:child_process';
import path from 'node:path';
import {readProcessInventory,validCreationTime,type RecordedProcessIdentity} from './process-inventory.js';

export interface ProcessIdentity {pid:number;parentPid:number;created:string;createdAt?:string|null;imageName?:string|null;observedAt?:string;creationKey?:string|null;}
export interface ProcessCleanup {trackedPids:number[];remainingPids:number[];unverifiedPids?:number[];trackedProcesses?:RecordedProcessIdentity[];rootPid?:number;rootProcess?:RecordedProcessIdentity;rootProcesses?:RecordedProcessIdentity[];observedAt?:string;verified:boolean;scope?:'observed_descendants';note?:string;}
const command=(file:string,args:string[],timeout=2500)=>new Promise<string>((resolve,reject)=>execFile(file,args,{windowsHide:true,timeout,maxBuffer:8*1024*1024},(e,out)=>e?reject(e):resolve(out)));
/** Creation identity is checked again immediately before a kill. Cwd alone
 * never grants ownership of a process (shared Java/Node processes are common). */
export async function processSnapshot():Promise<ProcessIdentity[]>{
 const inventory=await readProcessInventory();if(!inventory.complete)throw Error('Process inventory incomplete');
 return inventory.processes.map(row=>({...row,parentPid:row.parentPid??-1,created:row.creationKey??row.createdAt??''}));
}
function bornNoEarlier(child:ProcessIdentity,parent:ProcessIdentity):boolean {
 const childKey=child.creationKey??child.created,parentKey=parent.creationKey??parent.created;
 const windows=/^windows:(\d{15,20})$/,linux=/^linux:([a-f0-9-]{36}):(\d+)$/i;
 const cw=windows.exec(childKey),pw=windows.exec(parentKey);
 if(cw&&pw)return BigInt(cw[1])>=BigInt(pw[1]);
 const cl=linux.exec(childKey),pl=linux.exec(parentKey);
 if(cl&&pl)return cl[1]===pl[1]&&BigInt(cl[2])>=BigInt(pl[2]);
 const c=validCreationTime(child.createdAt??child.created),p=validCreationTime(parent.createdAt??parent.created);
 return c!==undefined&&p!==undefined&&c>=p;
}
export function sameObservedCreation(a:ProcessIdentity|undefined,b:ProcessIdentity|undefined):boolean {
 if(!a?.created||!b?.created)return false;
 return a.creationKey&&b.creationKey?a.creationKey===b.creationKey:a.created===b.created;
}
export function ownedDescendants(rows:ProcessIdentity[],owners:Map<number,ProcessIdentity>,runRoot?:ProcessIdentity,startedAt?:string):ProcessIdentity[]{
 const live=new Map(rows.map(row=>[row.pid,row]));const owned=new Map<number,ProcessIdentity>();
 const start=validCreationTime(startedAt);
 const afterStart=(row:ProcessIdentity)=>{const born=validCreationTime(row.createdAt??row.created);return start===undefined||born!==undefined&&born>=start;};
 for(const [pid,identity] of owners)if(sameObservedCreation(live.get(pid),identity)&&afterStart(identity)&&(!runRoot||bornNoEarlier(identity,runRoot)))owned.set(pid,identity);
 let changed=true;while(changed){changed=false;for(const row of rows){const parent=owned.get(row.parentPid);if(row.created&&!owned.has(row.pid)&&parent&&bornNoEarlier(row,parent)&&afterStart(row)&&(!runRoot||bornNoEarlier(row,runRoot))){owned.set(row.pid,row);changed=true;}}}
 return [...owned.values()];
}
export interface ProcessTracker {knownPids:()=>number[];knownProcesses?:()=>RecordedProcessIdentity[];rootProcess?:()=>RecordedProcessIdentity|undefined;cancelCleanup:()=>void;cleanup:()=>Promise<ProcessCleanup>;}
export function trackProcessTree(rootPid:number,rootAlive=()=>true,options:{snapshot?:()=>Promise<ProcessIdentity[]>;startedAt?:string;terminate?:(pid:number)=>Promise<void>}={}):ProcessTracker{
 const snapshot=options.snapshot??processSnapshot;
 const owners=new Map<number,ProcessIdentity>();let rootKnown=false,unavailable=false,stopped=false,cleanupCancelled=false,pending:Promise<void>|undefined;
 const saved=(row:ProcessIdentity):RecordedProcessIdentity=>({pid:row.pid,parentPid:row.parentPid,createdAt:row.createdAt??(Number.isFinite(Date.parse(row.created))?row.created:null),imageName:row.imageName??null,observedAt:row.observedAt??new Date().toISOString(),creationKey:row.creationKey??null});
 const sample=()=>{
  if(pending)return pending;
  pending=(async()=>{try{if(!rootKnown&&!rootAlive()){unavailable=true;return;}const rows=await snapshot();if(!rootKnown){const root=rows.find(row=>row.pid===rootPid);if(!root?.created||!bornNoEarlier(root,root)||!rootAlive()){unavailable=true;return;}owners.set(rootPid,root);rootKnown=true;}for(const row of ownedDescendants(rows,owners,owners.get(rootPid),options.startedAt))owners.set(row.pid,row);if(rows.some(row=>{const parent=owners.get(row.parentPid);return parent&&!bornNoEarlier(row,parent)&&!bornNoEarlier(parent,row);}))unavailable=true;}catch{unavailable=true;}})().finally(()=>{pending=undefined;});return pending;
 };
 void sample();const timer=setInterval(()=>{if(!stopped)void sample();},2000);timer.unref();
 return {knownPids:()=>[...owners.keys()],knownProcesses:()=>[...owners.values()].map(saved),rootProcess:()=>owners.has(rootPid)?saved(owners.get(rootPid)!):undefined,cancelCleanup:()=>{cleanupCancelled=true;},async cleanup():Promise<ProcessCleanup>{
  const deadline=Date.now()+6500;
  stopped=true;clearInterval(timer);await sample();
  const trackedPids=[...owners.keys()].filter(pid=>pid!==rootPid);let remainingPids:number[]=[],unverifiedPids:number[]=[];
  try{
   // Re-query each candidate. A PID can be recycled between samples.
   for(const pid of trackedPids){if(cleanupCancelled||Date.now()>=deadline){unavailable=true;break;}const identity=owners.get(pid)!;const current=(await snapshot()).find(row=>row.pid===pid);if(cleanupCancelled||Date.now()>=deadline-1500){unavailable=true;break;}if(current&&!current.created){unavailable=true;unverifiedPids.push(pid);continue;}if(!sameObservedCreation(current,identity))continue;
    // Never use taskkill /T: its PPID-only recursion can kill a pre-existing
    // process whose historical parent PID was reused by this run.
    try{if(options.terminate)await options.terminate(pid);else if(process.platform==='win32')await command(path.join(process.env.SystemRoot??'C:/Windows','System32/taskkill.exe'),['/PID',String(pid),'/F'],1500);else process.kill(pid,'SIGKILL');}catch{}
   }
   const after=new Map((await snapshot()).map(row=>[row.pid,row]));remainingPids=trackedPids.filter(pid=>sameObservedCreation(after.get(pid),owners.get(pid)));for(const pid of trackedPids)if(after.has(pid)&&!after.get(pid)?.created){unavailable=true;unverifiedPids.push(pid);}unverifiedPids=[...new Set(unverifiedPids)];
  }catch{unavailable=true;unverifiedPids=trackedPids;}
  return {trackedPids,trackedProcesses:[...owners.values()].filter(row=>row.pid!==rootPid).map(saved),rootPid,rootProcess:owners.has(rootPid)?saved(owners.get(rootPid)!):undefined,observedAt:new Date().toISOString(),remainingPids,...(unverifiedPids.length?{unverifiedPids}:{}),verified:rootKnown&&!unavailable&&remainingPids.length===0,scope:'observed_descendants',note:unavailable?'Some process ownership/exit checks were unavailable; detached children that exited the observed tree before a snapshot cannot be attributed.':'Cleanup covers observed descendants only; children that detached before a snapshot may not be attributable.'};
 }};
}
