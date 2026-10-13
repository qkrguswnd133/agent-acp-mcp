import fs from 'node:fs';
import {execFileSync} from 'node:child_process';

export interface IdentityOptions {platform?:NodeJS.Platform;procRoot?:string;uid?:number;}
/** /proc stat comm can contain spaces and parentheses; field 22 is starttime. */
export function linuxStartTicks(stat:string):string|undefined {
  const end=stat.lastIndexOf(')');
  if(end<0)return undefined;
  const fields=stat.slice(end+1).trim().split(/\s+/);
  return /^\d+$/.test(fields[19]??'')?fields[19]:undefined;
}
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
    if(platform==='win32')return execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`],{encoding:'utf8',timeout:3000,windowsHide:true}).trim();
  }catch{}
  return undefined;
}
