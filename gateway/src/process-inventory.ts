import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';

export interface RecordedProcessIdentity {pid:number;createdAt:string|null;imageName:string|null;observedAt:string;parentPid?:number|null;creationKey?:string|null;commandLine?:string|null;cwd?:string|null;}
export interface ProcessInventory {processes:RecordedProcessIdentity[];observedAt:string;complete:boolean;}
type Execute=(file:string,args:string[])=>Promise<string>;
const execute:Execute=(file,args)=>new Promise((resolve,reject)=>execFile(file,args,{windowsHide:true,timeout:10000,maxBuffer:16*1024*1024,encoding:'utf8'},(error,stdout)=>error?reject(error):resolve(stdout)));
let clockTicks:Promise<number>|undefined;
function ticksPerSecond(run:Execute){
 const pending=clockTicks??=(async()=>{const value=Number((await run('getconf',['CLK_TCK'])).trim());if(!Number.isSafeInteger(value)||value<1)throw Error('Linux clock ticks unavailable');return value;})();
 pending.catch(()=>{if(clockTicks===pending)clockTicks=undefined;});return pending;
}
export function parseWindowsInventory(text:string,observedAt:string):ProcessInventory {
 const data=JSON.parse(text.replace(/^\uFEFF/,'')),rows=Array.isArray(data)?data:[data];
 if(!rows.length||rows.some(row=>!row||!Number.isSafeInteger(row.ProcessId)||row.ProcessId<0||!Number.isSafeInteger(row.ParentProcessId)))throw Error('Invalid Windows process inventory');
 return {complete:true,observedAt,processes:rows.map(row=>({pid:row.ProcessId,parentPid:row.ParentProcessId,
  createdAt:typeof row.CreatedAt==='string'&&Number.isFinite(Date.parse(row.CreatedAt))?row.CreatedAt:null,
  creationKey:typeof row.CreationKey==='string'&&/^\d+$/.test(row.CreationKey)?'windows:'+row.CreationKey:null,
  imageName:typeof row.Name==='string'?row.Name:null,commandLine:typeof row.CommandLine==='string'?row.CommandLine:null,observedAt}))};
}
/** One Windows CIM query returns both candidates and all available ancestors. */
export async function readProcessInventory(options:{platform?:NodeJS.Platform;procRoot?:string;execute?:Execute;clockTicks?:number;now?:()=>number}={}):Promise<ProcessInventory>{
 const platform=options.platform??process.platform,run=options.execute??execute,observedAt=new Date((options.now??Date.now)()).toISOString();
 if(platform==='win32'){
  const script="$ErrorActionPreference='Stop';[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);@(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{n='CreatedAt';e={if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}else{$null}}},@{n='CreationKey';e={if($_.CreationDate){$_.CreationDate.ToUniversalTime().Ticks.ToString()}else{$null}}}) | ConvertTo-Json -Compress";
  return parseWindowsInventory(await run(path.join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',script]),observedAt);
 }
 if(platform!=='linux')throw Error('Creation-identity process inventory unsupported on this platform');
 const proc=options.procRoot??'/proc';
 const [bootId,bootStat,hz]=await Promise.all([fs.readFile(path.join(proc,'sys/kernel/random/boot_id'),'utf8'),fs.readFile(path.join(proc,'stat'),'utf8'),options.clockTicks??ticksPerSecond(run)]);
 const boot=bootId.trim(),bootSeconds=Number(/^btime\s+(\d+)$/m.exec(bootStat)?.[1]);
 if(!/^[a-f0-9-]{36}$/i.test(boot)||!Number.isSafeInteger(bootSeconds)||!Number.isSafeInteger(hz)||hz<1)throw Error('Linux boot/creation clock unavailable');
 const names=(await fs.readdir(proc)).filter(name=>/^\d+$/.test(name)),processes:RecordedProcessIdentity[]=[];let cursor=0;
 if(!names.length)throw Error('Linux process inventory is empty');
 await Promise.all(Array.from({length:Math.min(16,names.length)},async()=>{while(cursor<names.length){
  const name=names[cursor++],pid=Number(name),base={pid,createdAt:null,imageName:null,observedAt,parentPid:null,creationKey:null};
  try{
   const text=await fs.readFile(path.join(proc,name,'stat'),'utf8'),end=text.lastIndexOf(')'),start=text.indexOf('('),fields=text.slice(end+1).trim().split(/\s+/);
   if(start<0||end<start||!text.startsWith(name+' (')||!/^\d+$/.test(fields[1]??'')||!/^\d+$/.test(fields[19]??''))throw Error('Invalid proc identity');
   const ticks=Number(fields[19]);if(!Number.isSafeInteger(ticks))throw Error('Invalid Linux start ticks');
   const [commandLine,cwd]=await Promise.all([fs.readFile(path.join(proc,name,'cmdline'),'utf8').then(value=>value.replace(/\0/g,' ').trim()||null).catch(()=>null),fs.readlink(path.join(proc,name,'cwd')).catch(()=>null)]);
   processes.push({...base,parentPid:Number(fields[1]),imageName:text.slice(start+1,end),createdAt:new Date(bootSeconds*1000+ticks/hz*1000).toISOString(),creationKey:`linux:${boot}:${fields[19]}`,commandLine,cwd});
  }catch(error){if(['ENOENT','ESRCH'].includes((error as NodeJS.ErrnoException).code??''))continue;processes.push(base);}
 }}));
 return {processes,observedAt,complete:true};
}

export function sameProcessCreation(a:RecordedProcessIdentity,b:RecordedProcessIdentity):boolean|undefined {
 const key=/^(?:windows:\d{15,20}|linux:[a-f0-9-]{36}:\d+)$/i;
 if(typeof a.creationKey==='string'&&typeof b.creationKey==='string'&&key.test(a.creationKey)&&key.test(b.creationKey))return a.creationKey.split(':')[0]===b.creationKey.split(':')[0]?a.creationKey===b.creationKey:undefined;
 if(validCreationTime(a.createdAt)!==undefined&&validCreationTime(b.createdAt)!==undefined)return a.createdAt===b.createdAt||Date.parse(a.createdAt!)===Date.parse(b.createdAt!);
 return undefined;
}
export function validCreationTime(value:unknown):number|undefined {
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))return undefined;
 const time=Date.parse(value);return Number.isFinite(time)?time:undefined;
}
