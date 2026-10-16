import fs from 'node:fs';
import {readProcessInventory,type ProcessInventory} from './process-inventory.js';

export interface IdentityOptions {platform?:NodeJS.Platform;procRoot?:string;uid?:number;}
/** /proc stat comm can contain spaces and parentheses; field 22 is starttime. */
export function linuxStartTicks(stat:string):string|undefined {
  const end=stat.lastIndexOf(')');
  if(end<0)return undefined;
  const fields=stat.slice(end+1).trim().split(/\s+/);
  return /^\d+$/.test(fields[19]??'')?fields[19]:undefined;
}
/** Shell-free Linux registry identity; Windows callers use the async variant. */
export function processIdentity(pid:number,options:IdentityOptions={}):string|undefined {
  if(!Number.isSafeInteger(pid)||pid<1)return undefined;
  const platform=options.platform??process.platform;
  try{
    if(platform==='linux'){
      const root=options.procRoot??'/proc',uid=options.uid??process.getuid?.();
      if(uid===undefined)return undefined;
      const status=fs.readFileSync(`${root}/${pid}/status`,'utf8');
      const owner=/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(status);
      if(!owner||owner.slice(1).some(value=>Number(value)!==uid))return undefined;
      const stat=fs.readFileSync(`${root}/${pid}/stat`,'utf8');
      if(!stat.startsWith(`${pid} (`))return undefined;
      const ticks=linuxStartTicks(stat),boot=fs.readFileSync(`${root}/sys/kernel/random/boot_id`,'utf8').trim();
      if(!ticks||!/^[0-9a-f-]{36}$/i.test(boot))return undefined;
      return `linux:${boot}:${ticks}:${uid}`;
    }
  }catch{}
  return undefined;
}

let pendingWindowsInventory:Promise<ProcessInventory>|undefined;
/** Win32_Process.CreationDate has microsecond precision, while the existing
 * updater writes Get-Process.StartTime ticks (100 ns). Compare that native
 * record at CIM's exact resolution, never with an elapsed-time tolerance.
 * Adjacent microseconds still identify different process generations. */
export function matchesWindowsCimCreation(observed:string|undefined,recorded:string):boolean {
  const ticks=/^\d{15,20}$/;
  if(typeof observed!=='string'||!ticks.test(observed)||!ticks.test(recorded))return false;
  if(observed===recorded)return true;
  const current=BigInt(observed);
  return current%10n===0n&&current===BigInt(recorded)/10n*10n;
}
/** Async Windows callers share an in-flight inventory, never a stale PID cache. */
export async function processIdentityAsync(pid:number,options:IdentityOptions&{snapshot?:()=>Promise<ProcessInventory>}={}):Promise<string|undefined>{
  if(!Number.isSafeInteger(pid)||pid<1)return undefined;
  if((options.platform??process.platform)!=='win32')return processIdentity(pid,options);
  try{
    let inventory:ProcessInventory;
    if(options.snapshot)inventory=await options.snapshot();
    else{
      const pending=pendingWindowsInventory??=readProcessInventory({platform:'win32'});
      try{inventory=await pending;}finally{if(pendingWindowsInventory===pending)pendingWindowsInventory=undefined;}
    }
    const key=inventory.processes.find(row=>row.pid===pid)?.creationKey;
    return typeof key==='string'&&/^windows:\d{15,20}$/.test(key)?key.slice('windows:'.length):undefined;
  }catch{return undefined;}
}
