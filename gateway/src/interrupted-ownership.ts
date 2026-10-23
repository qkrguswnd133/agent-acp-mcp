import path from 'node:path';
import fs from 'node:fs/promises';
import {readProcessInventory,validCreationTime,type ProcessInventory} from './process-inventory.js';

export interface ProcessSnapshotEntry {pid:number;parentPid:number;name:string;commandLine:string|null;cwd?:string;createdAt?:string|null;creationKey?:string|null;sessionId?:number|null}
export interface InterruptedOwnershipInput {ownerPid:number;workspacePaths:string[];startedAt?:string;trackedPids?:number[];rootPids?:number[]}
export interface OwnershipWarning {pid:number;imageName:string;createdAt:string;sessionId:number;reason:string}
export interface OwnershipSnapshotOptions {snapshot?:()=>Promise<ProcessInventory>;platform?:NodeJS.Platform;}

/** Read-only inventory of this account's Linux processes, equally applicable
 * to WSL. A disappearing process is absent; inaccessible live data is unknown. */
export async function linuxOwnershipSnapshot(procRoot='/proc',uid=process.getuid?.()):Promise<ProcessSnapshotEntry[]>{
 if(uid===undefined)throw Error('Linux process owner UID is unavailable');
 const directories=(await fs.readdir(procRoot)).filter(name=>/^\d+$/.test(name));
 const result:ProcessSnapshotEntry[]=[];let cursor=0;
 await Promise.all(Array.from({length:Math.min(12,directories.length)},async()=>{
  while(cursor<directories.length){const name=directories[cursor++],folder=path.join(procRoot,name);
   try{
    if((await fs.stat(folder)).uid!==uid)continue;
    const stat=await fs.readFile(path.join(folder,'stat'),'utf8'),end=stat.lastIndexOf(')'),start=stat.indexOf('('),fields=stat.slice(end+1).trim().split(/\s+/);
    if(start<0||end<start||!stat.startsWith(name+' (')||!/^\d+$/.test(fields[1]??''))throw Error('Invalid Linux process identity');
    // A zombie has no running userspace or open workspace files.
    if(fields[0]==='Z'||fields[0]==='X')continue;
    const commandLine=(await fs.readFile(path.join(folder,'cmdline'))).toString('utf8').replace(/\0/g,' ').trim();
    let cwd:string|undefined;
    try{cwd=await fs.readlink(path.join(folder,'cwd'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){if(!await fs.stat(folder).catch(()=>undefined))continue;}throw error;}
    result.push({pid:Number(name),parentPid:Number(fields[1]),name:stat.slice(start+1,end),commandLine:commandLine||null,cwd});
   }catch(error){
    const code=(error as NodeJS.ErrnoException).code;
    if(['ENOENT','ESRCH'].includes(code??'')&&!await fs.stat(folder).catch(()=>undefined))continue;
    if(code==='EACCES'||code==='EPERM')throw Object.assign(Error(`Linux process ownership inventory is unavailable: permission denied for PID ${name}; preserved`),{code:'PROCESS_OWNERSHIP_PERMISSION_DENIED',pid:Number(name)});
    throw Error('Linux process ownership inventory is unavailable or incomplete; preserved');
   }
  }
 }));
 if(!result.length)throw Error('Linux process ownership inventory is empty; preserved');
 return result;
}

/** Read-only OS inventory, matching the Windows updater's process source. */
export async function processOwnershipSnapshot(options:OwnershipSnapshotOptions={}):Promise<ProcessSnapshotEntry[]>{
 const platform=options.platform??process.platform;
 if(platform==='win32'){
  // This is the same CIM source used by distribution/Update.ps1. Keep workspace
  // paths out of the scan command itself so it cannot match its own arguments.
  const inventory=await (options.snapshot??(()=>readProcessInventory({platform})))();
  if(!inventory.complete||!inventory.processes.length)throw Error('Process inventory is unavailable or incomplete');
  return inventory.processes.map(value=>{
   if(!Number.isSafeInteger(value.pid)||!Number.isSafeInteger(value.parentPid)||typeof value.imageName!=='string'||(value.commandLine!==null&&typeof value.commandLine!=='string'))throw Error('Process inventory contains invalid ownership data');
   return {pid:value.pid,parentPid:value.parentPid!,name:value.imageName,commandLine:value.commandLine??null,cwd:value.cwd??undefined,createdAt:value.createdAt,creationKey:value.creationKey,sessionId:value.sessionId};
  });
 }
 if(platform==='linux')return linuxOwnershipSnapshot();
 throw Error('Interrupted worktree ownership inspection is unsupported on this platform; preserved');
}

/** Require absent owner, no surviving descendants, and no matching workspace use. */
export function assertInterruptedOwnershipAbsent(input:InterruptedOwnershipInput,processes:ProcessSnapshotEntry[],platform:NodeJS.Platform=process.platform,currentPid=process.pid,finished=false){
 if(!Number.isSafeInteger(input.ownerPid)||input.ownerPid<1||!processes.length)throw Error('Interrupted job owner or process inventory is unknown; preserved');
 if(processes.some(item=>!Number.isSafeInteger(item.pid)||item.pid<0||!Number.isSafeInteger(item.parentPid)||item.parentPid<0||typeof item.name!=='string'||(item.commandLine!==null&&typeof item.commandLine!=='string')))throw Error('Process inventory contains unknown ownership data; preserved');
 if(!finished&&processes.some(item=>item.pid===input.ownerPid))throw Error('Interrupted job owner process is still alive; preserved');
 const descendants=new Set([input.ownerPid]);let changed=true;
 while(changed){changed=false;for(const item of processes)if(descendants.has(item.parentPid)&&!descendants.has(item.pid)){descendants.add(item.pid);changed=true;}}
 if(!finished&&descendants.size>1)throw Error('Interrupted job has surviving child processes; preserved');
 const selfLineage=new Set<number>();let ancestor:number|undefined=currentPid;
 while(ancestor!==undefined&&!selfLineage.has(ancestor)){selfLineage.add(ancestor);ancestor=processes.find(item=>item.pid===ancestor)?.parentPid;}
 const normalize=(value:string)=>platform==='win32'?value.replace(/\\+/g,'/').toLowerCase():value;
 const targets=input.workspacePaths.filter(Boolean).map(value=>normalize(value).replace(/\/$/,''));
 if(!targets.length)throw Error('Interrupted job workspace identity is unknown; preserved');
 const references=(text:string)=>targets.some(target=>{
  const normalized=normalize(text);let offset=normalized.indexOf(target);
  while(offset!==-1){const before=normalized[offset-1],next=normalized[offset+target.length];if((before===undefined||/[\s='"\x00]/.test(before))&&(next===undefined||/[\s/'"\x00]/.test(next)))return true;offset=normalized.indexOf(target,offset+1);}return false;
 });
 const warnings:OwnershipWarning[]=[],start=validCreationTime(input.startedAt),currentSession=processes.find(item=>item.pid===currentPid)?.sessionId;
 const ownerCreated=validCreationTime(processes.find(item=>item.pid===input.ownerPid)?.createdAt),ownerReused=start!==undefined&&ownerCreated!==undefined&&ownerCreated>start;
 const anchors=new Set([...(ownerReused?[]:[input.ownerPid]),...(input.trackedPids??[]),...(input.rootPids??[])]),rows=new Map(processes.map(item=>[item.pid,item]));
 // A known, pre-existing service in Windows session 0 is outside this desktop
 // job only when a complete, generation-consistent ancestry also excludes all
 // provider anchors. Missing metadata alone is never permission to remove.
 const unrelatedService=(item:ProcessSnapshotEntry)=>{
  const created=validCreationTime(item.createdAt);
  if(platform!=='win32'||item.sessionId!==0||typeof currentSession!=='number'||currentSession<=0||start===undefined||created===undefined||created>=start||anchors.has(item.pid))return false;
  const visited=new Set<number>();let child=item;
  while(child.parentPid!==0){
   if(anchors.has(child.parentPid)||visited.has(child.pid))return false;visited.add(child.pid);
   const parent=rows.get(child.parentPid),parentCreated=validCreationTime(parent?.createdAt),childCreated=validCreationTime(child.createdAt);
   if(!parent||parentCreated===undefined||childCreated===undefined||parentCreated>childCreated||parent.sessionId!==0)return false;
   child=parent;
  }
  return true;
 };
 for(const item of processes){
  if(selfLineage.has(item.pid)||(finished&&!ownerReused&&item.pid===input.ownerPid))continue;
  if(item.cwd&&references(item.cwd)||item.commandLine&&references(item.commandLine))throw Error(`Process ${item.pid} still references the interrupted workspace; preserved`);
  if(!item.commandLine?.trim()&&/^(?:node|grok|claude|codex|pwsh|powershell|cmd|bash|sh|python(?:\d+(?:\.\d+)?)?|git|java|gradle)(?:\.exe)?$/i.test(item.name)){
   if(unrelatedService(item)){warnings.push({pid:item.pid,imageName:item.name,createdAt:item.createdAt!,sessionId:item.sessionId!,reason:'Pre-existing session-0 service with a complete independent process ancestry; no target workspace reference observed'});continue;}
   throw Object.assign(Error(`Process ${item.pid} has unreadable command data; interrupted workspace ownership is unknown`),{ownershipCheck:{pid:item.pid,imageName:item.name,createdAt:item.createdAt??null,sessionId:item.sessionId??null,decision:'unknown',workspacePaths:input.workspacePaths,reason:'No positive proof that this unreadable process is unrelated to the target worktree'}});
  }
 }
 return {processWarnings:warnings};
}

/** A terminal persisted job may belong to a live gateway serving other jobs.
 * JobManager checks terminal records/locks and child cleanup before this scan;
 * do not confuse the gateway's lifetime with this job's provider lifetime. */
export async function verifyFinishedOwnership(input:InterruptedOwnershipInput,options:OwnershipSnapshotOptions={}):Promise<{processScan:'passed';checkedAt:string;ownerMayServeOtherJobs:true;ownerAbsent?:true;processScanScope?:string;processWarnings?:OwnershipWarning[]}>{
 const snapshot=await processOwnershipSnapshot(options).catch(()=>{throw Error('Process ownership inventory unavailable; reviewed worktree preserved');});
 const platform=options.platform??process.platform,check=assertInterruptedOwnershipAbsent(input,snapshot,platform,process.pid,true);
 return {processScan:'passed' as const,checkedAt:new Date().toISOString(),ownerMayServeOtherJobs:true,processScanScope:platform==='linux'?'current_uid':'system_inventory',...check};
}

export async function verifyInterruptedOwnership(input:InterruptedOwnershipInput,options:OwnershipSnapshotOptions={}):Promise<{ownerAbsent:true;processScan:'passed';checkedAt:string;processScanScope?:string;processWarnings?:OwnershipWarning[]}>{
 if(!Number.isSafeInteger(input.ownerPid)||input.ownerPid<1)throw Error('Interrupted job owner identity is unknown; preserved');
 try{process.kill(input.ownerPid,0);throw Error('Interrupted job owner process is still alive; preserved');}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
 const snapshot=await processOwnershipSnapshot(options).catch(()=>{throw Error('Process ownership inventory is unavailable or incomplete on this platform; interrupted worktree preserved');});const check=assertInterruptedOwnershipAbsent(input,snapshot,options.platform??process.platform);
 // A PID reused during the inventory must not turn into permission to mutate.
 try{process.kill(input.ownerPid,0);throw Error('Interrupted job owner appeared during inspection; preserved');}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
 return {ownerAbsent:true as const,processScan:'passed' as const,checkedAt:new Date().toISOString(),processScanScope:(options.platform??process.platform)==='linux'?'current_uid':'system_inventory',...check};
}
