import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {safeChildEnv} from './process.js';

const execute=promisify(execFile);
export interface ProcessSnapshotEntry {pid:number;parentPid:number;name:string;commandLine:string|null;cwd?:string}
export interface InterruptedOwnershipInput {ownerPid:number;workspacePaths:string[]}

/** Read-only OS inventory, matching the Windows updater's process source. */
export async function processOwnershipSnapshot():Promise<ProcessSnapshotEntry[]>{
 if(process.platform==='win32'){
  // This is the same CIM source used by distribution/Update.ps1. Keep workspace
  // paths out of the scan command itself so it cannot match its own arguments.
  const script="$ErrorActionPreference='Stop';[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);@(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,Name,CommandLine) | ConvertTo-Json -Compress";
  const executable=path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const {stdout}=await execute(executable,['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,env:safeChildEnv(),timeout:10000,maxBuffer:8*1024*1024,encoding:'utf8'});
  const parsed:unknown=JSON.parse(stdout.replace(/^\uFEFF/,'').trim());
  if(!Array.isArray(parsed)||!parsed.length)throw Error('Process inventory is unavailable or incomplete');
  return parsed.map(value=>{
   if(!value||typeof value!=='object'||!Number.isSafeInteger(value.ProcessId)||!Number.isSafeInteger(value.ParentProcessId)||typeof value.Name!=='string'||(value.CommandLine!==null&&typeof value.CommandLine!=='string'))throw Error('Process inventory contains invalid ownership data');
   return {pid:value.ProcessId,parentPid:value.ParentProcessId,name:value.Name,commandLine:value.CommandLine};
  });
 }
 throw Error('Interrupted worktree ownership inspection is unsupported on this platform; preserved');
}

/** Require absent owner, no surviving descendants, and no matching workspace use. */
export function assertInterruptedOwnershipAbsent(input:InterruptedOwnershipInput,processes:ProcessSnapshotEntry[],platform:NodeJS.Platform=process.platform,currentPid=process.pid){
 if(!Number.isSafeInteger(input.ownerPid)||input.ownerPid<1||!processes.length)throw Error('Interrupted job owner or process inventory is unknown; preserved');
 if(processes.some(item=>!Number.isSafeInteger(item.pid)||item.pid<0||!Number.isSafeInteger(item.parentPid)||item.parentPid<0||typeof item.name!=='string'||(item.commandLine!==null&&typeof item.commandLine!=='string')))throw Error('Process inventory contains unknown ownership data; preserved');
 if(processes.some(item=>item.pid===input.ownerPid))throw Error('Interrupted job owner process is still alive; preserved');
 const descendants=new Set([input.ownerPid]);let changed=true;
 while(changed){changed=false;for(const item of processes)if(descendants.has(item.parentPid)&&!descendants.has(item.pid)){descendants.add(item.pid);changed=true;}}
 if(descendants.size>1)throw Error('Interrupted job has surviving child processes; preserved');
 const selfLineage=new Set<number>();let ancestor:number|undefined=currentPid;
 while(ancestor!==undefined&&!selfLineage.has(ancestor)){selfLineage.add(ancestor);ancestor=processes.find(item=>item.pid===ancestor)?.parentPid;}
 const normalize=(value:string)=>platform==='win32'?value.replace(/\\+/g,'/').toLowerCase():value;
 const targets=input.workspacePaths.filter(Boolean).map(value=>normalize(value).replace(/\/$/,''));
 if(!targets.length)throw Error('Interrupted job workspace identity is unknown; preserved');
 const references=(text:string)=>targets.some(target=>{
  const normalized=normalize(text);let offset=normalized.indexOf(target);
  while(offset!==-1){const next=normalized[offset+target.length];if(next===undefined||/[\s/'"\x00]/.test(next))return true;offset=normalized.indexOf(target,offset+1);}return false;
 });
 for(const item of processes){
  if(selfLineage.has(item.pid))continue;
  if(item.cwd&&references(item.cwd)||item.commandLine&&references(item.commandLine))throw Error(`Process ${item.pid} still references the interrupted workspace; preserved`);
  if(!item.commandLine?.trim()&&/^(?:node|grok|claude|codex|pwsh|powershell|cmd|bash|sh|python(?:\d+(?:\.\d+)?)?|git)(?:\.exe)?$/i.test(item.name))throw Error(`Process ${item.pid} has unreadable command data; interrupted workspace ownership is unknown`);
 }
}

export async function verifyInterruptedOwnership(input:InterruptedOwnershipInput){
 if(!Number.isSafeInteger(input.ownerPid)||input.ownerPid<1)throw Error('Interrupted job owner identity is unknown; preserved');
 try{process.kill(input.ownerPid,0);throw Error('Interrupted job owner process is still alive; preserved');}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
 const snapshot=await processOwnershipSnapshot().catch(()=>{throw Error('Process ownership inventory is unavailable or incomplete on this platform; interrupted worktree preserved');});assertInterruptedOwnershipAbsent(input,snapshot);
 // A PID reused during the inventory must not turn into permission to mutate.
 try{process.kill(input.ownerPid,0);throw Error('Interrupted job owner appeared during inspection; preserved');}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
 return {ownerAbsent:true as const,processScan:'passed' as const,checkedAt:new Date().toISOString()};
}
