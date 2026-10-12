import {execFile} from 'node:child_process';
import path from 'node:path';

export interface ProcessIdentity {pid:number;parentPid:number;created:string;}
export interface ProcessCleanup {trackedPids:number[];remainingPids:number[];verified:boolean;scope?:'observed_descendants';note?:string;}
const command=(file:string,args:string[],timeout=2500)=>new Promise<string>((resolve,reject)=>execFile(file,args,{windowsHide:true,timeout,maxBuffer:8*1024*1024},(e,out)=>e?reject(e):resolve(out)));
/** Creation identity is checked again immediately before a kill. Cwd alone
 * never grants ownership of a process (shared Java/Node processes are common). */
export async function processSnapshot():Promise<ProcessIdentity[]>{
 if(process.platform==='win32'){
  const out=await command(path.join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command','Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{n="Created";e={$_.CreationDate.ToUniversalTime().ToString("o")}} | ConvertTo-Json -Compress']);
  const parsed=JSON.parse(out||'[]');return (Array.isArray(parsed)?parsed:[parsed]).flatMap(row=>typeof row.Created==='string'?[{pid:Number(row.ProcessId),parentPid:Number(row.ParentProcessId),created:row.Created}]:[]);
 }
 const out=await command('ps',['-eo','pid=,ppid=,lstart=']);
 return out.split(/\r?\n/).flatMap(line=>{const match=line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);return match?[{pid:Number(match[1]),parentPid:Number(match[2]),created:match[3]}]:[];});
}
export function ownedDescendants(rows:ProcessIdentity[],owners:Map<number,ProcessIdentity>):ProcessIdentity[]{
 const live=new Map(rows.map(row=>[row.pid,row]));const owned=new Map<number,ProcessIdentity>();
 for(const [pid,identity] of owners)if(live.get(pid)?.created===identity.created)owned.set(pid,identity);
 let changed=true;while(changed){changed=false;for(const row of rows)if(!owned.has(row.pid)&&owned.has(row.parentPid)){owned.set(row.pid,row);changed=true;}}
 return [...owned.values()];
}
export function trackProcessTree(rootPid:number,rootAlive=()=>true){
 const owners=new Map<number,ProcessIdentity>();let rootKnown=false,unavailable=false,stopped=false,cleanupCancelled=false,pending:Promise<void>|undefined;
 const sample=()=>{
  if(pending)return pending;
  pending=(async()=>{try{if(!rootKnown&&!rootAlive()){unavailable=true;return;}const rows=await processSnapshot();if(!rootKnown){const root=rows.find(row=>row.pid===rootPid);if(!root||!rootAlive()){unavailable=true;return;}owners.set(rootPid,root);rootKnown=true;}for(const row of ownedDescendants(rows,owners))owners.set(row.pid,row);}catch{unavailable=true;}})().finally(()=>{pending=undefined;});return pending;
 };
 void sample();const timer=setInterval(()=>{if(!stopped)void sample();},2000);timer.unref();
 return {knownPids:()=>[...owners.keys()],cancelCleanup:()=>{cleanupCancelled=true;},async cleanup():Promise<ProcessCleanup>{
  const deadline=Date.now()+6500;
  stopped=true;clearInterval(timer);await sample();
  const trackedPids=[...owners.keys()].filter(pid=>pid!==rootPid);let remainingPids:number[]=[];
  try{
   // Re-query each candidate. A PID can be recycled between samples.
   for(const pid of trackedPids){if(cleanupCancelled||Date.now()>=deadline){unavailable=true;break;}const identity=owners.get(pid)!;const current=(await processSnapshot()).find(row=>row.pid===pid);if(cleanupCancelled||Date.now()>=deadline-1500){unavailable=true;break;}if(current?.created!==identity.created)continue;
    try{if(process.platform==='win32')await command(path.join(process.env.SystemRoot??'C:/Windows','System32/taskkill.exe'),['/PID',String(pid),'/T','/F'],1500);else process.kill(pid,'SIGKILL');}catch{}
   }
   const after=new Map((await processSnapshot()).map(row=>[row.pid,row]));remainingPids=trackedPids.filter(pid=>after.get(pid)?.created===owners.get(pid)?.created);
  }catch{unavailable=true;remainingPids=trackedPids;}
  return {trackedPids,remainingPids,verified:rootKnown&&!unavailable&&remainingPids.length===0,scope:'observed_descendants',note:unavailable?'Some process ownership/exit checks were unavailable; detached children that exited the observed tree before a snapshot cannot be attributed.':'Cleanup covers observed descendants only; children that detached before a snapshot may not be attributable.'};
 }};
}
