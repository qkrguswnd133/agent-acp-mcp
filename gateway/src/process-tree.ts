import {execFile} from 'node:child_process';
import path from 'node:path';
import {readProcessInventory,type RecordedProcessIdentity} from './process-inventory.js';

export interface ProcessIdentity {pid:number;parentPid:number;created:string;createdAt?:string|null;imageName?:string|null;observedAt?:string;creationKey?:string|null;}
export interface ProcessCleanup {trackedPids:number[];remainingPids:number[];unverifiedPids?:number[];trackedProcesses?:RecordedProcessIdentity[];rootPid?:number;rootProcess?:RecordedProcessIdentity;rootProcesses?:RecordedProcessIdentity[];observedAt?:string;verified:boolean;scope?:'observed_descendants';note?:string;}
const command=(file:string,args:string[],timeout=2500)=>new Promise<string>((resolve,reject)=>execFile(file,args,{windowsHide:true,timeout,maxBuffer:8*1024*1024},(e,out)=>e?reject(e):resolve(out)));
/** Creation identity is checked again immediately before a kill. Cwd alone
 * never grants ownership of a process (shared Java/Node processes are common). */
export async function processSnapshot():Promise<ProcessIdentity[]>{
 const inventory=await readProcessInventory();if(!inventory.complete)throw Error('Process inventory incomplete');
 return inventory.processes.map(row=>({...row,parentPid:row.parentPid??-1,created:row.creationKey??row.createdAt??''}));
}
export function ownedDescendants(rows:ProcessIdentity[],owners:Map<number,ProcessIdentity>):ProcessIdentity[]{
 const live=new Map(rows.map(row=>[row.pid,row]));const owned=new Map<number,ProcessIdentity>();
 for(const [pid,identity] of owners)if(identity.created&&live.get(pid)?.created===identity.created)owned.set(pid,identity);
 let changed=true;while(changed){changed=false;for(const row of rows)if(row.created&&!owned.has(row.pid)&&owned.has(row.parentPid)){owned.set(row.pid,row);changed=true;}}
 return [...owned.values()];
}
export interface ProcessTracker {knownPids:()=>number[];knownProcesses?:()=>RecordedProcessIdentity[];rootProcess?:()=>RecordedProcessIdentity|undefined;cancelCleanup:()=>void;cleanup:()=>Promise<ProcessCleanup>;}
export function trackProcessTree(rootPid:number,rootAlive=()=>true,options:{snapshot?:()=>Promise<ProcessIdentity[]>}={}):ProcessTracker{
 const snapshot=options.snapshot??processSnapshot;
 const owners=new Map<number,ProcessIdentity>();let rootKnown=false,unavailable=false,stopped=false,cleanupCancelled=false,pending:Promise<void>|undefined;
 const saved=(row:ProcessIdentity):RecordedProcessIdentity=>({pid:row.pid,parentPid:row.parentPid,createdAt:row.createdAt??(Number.isFinite(Date.parse(row.created))?row.created:null),imageName:row.imageName??null,observedAt:row.observedAt??new Date().toISOString(),creationKey:row.creationKey??null});
 const sample=()=>{
  if(pending)return pending;
  pending=(async()=>{try{if(!rootKnown&&!rootAlive()){unavailable=true;return;}const rows=await snapshot();if(!rootKnown){const root=rows.find(row=>row.pid===rootPid);if(!root?.created||!rootAlive()){unavailable=true;return;}owners.set(rootPid,root);rootKnown=true;}for(const row of ownedDescendants(rows,owners))owners.set(row.pid,row);if(rows.some(row=>!row.created&&owners.has(row.parentPid)))unavailable=true;}catch{unavailable=true;}})().finally(()=>{pending=undefined;});return pending;
 };
 void sample();const timer=setInterval(()=>{if(!stopped)void sample();},2000);timer.unref();
 return {knownPids:()=>[...owners.keys()],knownProcesses:()=>[...owners.values()].map(saved),rootProcess:()=>owners.has(rootPid)?saved(owners.get(rootPid)!):undefined,cancelCleanup:()=>{cleanupCancelled=true;},async cleanup():Promise<ProcessCleanup>{
  const deadline=Date.now()+6500;
  stopped=true;clearInterval(timer);await sample();
  const trackedPids=[...owners.keys()].filter(pid=>pid!==rootPid);let remainingPids:number[]=[],unverifiedPids:number[]=[];
  try{
   // Re-query each candidate. A PID can be recycled between samples.
   for(const pid of trackedPids){if(cleanupCancelled||Date.now()>=deadline){unavailable=true;break;}const identity=owners.get(pid)!;const current=(await snapshot()).find(row=>row.pid===pid);if(cleanupCancelled||Date.now()>=deadline-1500){unavailable=true;break;}if(current&&!current.created){unavailable=true;unverifiedPids.push(pid);continue;}if(current?.created!==identity.created)continue;
    try{if(process.platform==='win32')await command(path.join(process.env.SystemRoot??'C:/Windows','System32/taskkill.exe'),['/PID',String(pid),'/T','/F'],1500);else process.kill(pid,'SIGKILL');}catch{}
   }
   const after=new Map((await snapshot()).map(row=>[row.pid,row]));remainingPids=trackedPids.filter(pid=>after.get(pid)?.created===owners.get(pid)?.created);for(const pid of trackedPids)if(after.has(pid)&&!after.get(pid)?.created){unavailable=true;unverifiedPids.push(pid);}unverifiedPids=[...new Set(unverifiedPids)];
  }catch{unavailable=true;unverifiedPids=trackedPids;}
  return {trackedPids,trackedProcesses:[...owners.values()].filter(row=>row.pid!==rootPid).map(saved),rootPid,rootProcess:owners.has(rootPid)?saved(owners.get(rootPid)!):undefined,observedAt:new Date().toISOString(),remainingPids,...(unverifiedPids.length?{unverifiedPids}:{}),verified:rootKnown&&!unavailable&&remainingPids.length===0,scope:'observed_descendants',note:unavailable?'Some process ownership/exit checks were unavailable; detached children that exited the observed tree before a snapshot cannot be attributed.':'Cleanup covers observed descendants only; children that detached before a snapshot may not be attributable.'};
 }};
}
