import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import type {CommandExecution} from './command-telemetry.js';

const packagedPath=(value:string)=>/(?:^|[\\/])WindowsApps(?:[\\/]|$)/i.test(value);
const envValue=(env:NodeJS.ProcessEnv,key:string)=>Object.entries(env).find(([name])=>name.toUpperCase()===key)?.[1];
const gatewayRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const versions=new Map<string,Promise<number|undefined>>();
async function powerShellMajor(file:string,env:NodeJS.ProcessEnv){
 const stat=await fs.stat(file).catch(()=>undefined);if(!stat?.isFile())return undefined;
 const key=`${file.toLowerCase()}:${stat.size}:${stat.mtimeMs}`;
 let result=versions.get(key);
 if(!result){
  result=new Promise<number|undefined>(resolve=>execFile(file,['-NoLogo','-NoProfile','-NonInteractive','-Command','$PSVersionTable.PSVersion.Major'],{windowsHide:true,timeout:5000,env},(error,stdout)=>resolve(!error&&/^\d+$/.test(stdout.trim())?Number(stdout.trim()):undefined)));
  versions.set(key,result);
  if(versions.size>32)versions.delete(versions.keys().next().value!);
 }
 return result;
}
interface ShellOptions{
 gatewayRoot?:string;
 isFile?:(file:string)=>Promise<boolean>;
 majorVersion?:(file:string,env:NodeJS.ProcessEnv)=>Promise<number|undefined>;
}
/** Only the Codex child environment changes. App execution aliases cannot be
 * launched reliably with a restricted Windows token. Windows PowerShell 5.1
 * also decodes BOM-less UTF-8 files using the ANSI code page; changing console
 * encoding cannot fix that. Require native pwsh instead of silently corrupting
 * source text. Never relax the sandbox to make a shell launch. */
export async function codexShellEnvironment(env:NodeJS.ProcessEnv,platform:NodeJS.Platform=process.platform,options:ShellOptions={}){
 if(platform!=='win32')return {env:{...env},shell:undefined};
 const isFile=options.isFile??(async(file:string)=>{try{return (await fs.stat(file)).isFile();}catch{return false;}});
 const majorVersion=options.majorVersion??powerShellMajor;
 const directories=(envValue(env,'PATH')??'').split(';').map(value=>value.trim().replace(/^"(.*)"$/,'$1')).filter(value=>value&&!packagedPath(value));
 const programFiles=envValue(env,'PROGRAMFILES')??'C:\\Program Files';
 const explicit=envValue(env,'CODEX_POWERSHELL_PATH')?.trim();
 if(explicit&&(!path.win32.isAbsolute(explicit)||packagedPath(explicit)||path.win32.basename(explicit).toLowerCase()!=='pwsh.exe'||!await isFile(explicit)))throw Error('CODEX_SHELL_UNAVAILABLE: CODEX_POWERSHELL_PATH must point to an existing native pwsh.exe outside WindowsApps.');
 const candidates=explicit?[explicit]:[path.win32.join(options.gatewayRoot??gatewayRoot,'runtime','powershell7','pwsh.exe'),path.win32.join(programFiles,'PowerShell','7','pwsh.exe'),...directories.filter(value=>path.win32.isAbsolute(value)).map(value=>path.win32.join(value,'pwsh.exe'))];
 let shell:string|undefined;
 for(const candidate of [...new Set(candidates)])if(!packagedPath(candidate)&&await isFile(candidate)&&(await majorVersion(candidate,env)??0)>=7){shell=candidate;break;}
 if(!shell)throw Error(`CODEX_SHELL_UNAVAILABLE: ${explicit?'CODEX_POWERSHELL_PATH did not start PowerShell 7 or newer. ':'Bundled/native PowerShell 7 (pwsh.exe) is unavailable. '}Repair the bundled runtime, install native PowerShell 7, or set CODEX_POWERSHELL_PATH to a working absolute path outside WindowsApps. Windows PowerShell 5.1 is not a safe UTF-8 fallback.`);
 const launcher=path.win32.join(options.gatewayRoot??gatewayRoot,'runtime','codex-shell','pwsh.exe');
 if(!await isFile(launcher))throw Error('CODEX_SHELL_UNAVAILABLE: The bundled Codex UTF-8 shell launcher is missing. Repair the gateway runtime.');
 const child={...env};for(const key of Object.keys(child))if(['PATH','SHELL','CODEX_NATIVE_POWERSHELL_PATH'].includes(key.toUpperCase()))delete child[key];
 child.PATH=[path.win32.dirname(launcher),path.win32.dirname(shell),...directories].join(';');child.SHELL=launcher;child.CODEX_NATIVE_POWERSHELL_PATH=shell;
 return {env:child,shell:launcher,nativeShell:shell};
}

/** Only provider command events qualify; assistant prose and ordinary command
 * errors are not shell-launch evidence. Keep recovered failures as diagnostics. */
export function codexShellFailure(commands:CommandExecution[]){
 const failures=commands.flatMap((command,index)=>command.exitCode===-1&&command.source==='codex_json'&&typeof command.output==='string'&&/^(?:Failed to create unified exec process:|windows sandbox failed:)\s*CreateProcessAsUserW failed:\s*5\b/i.test(command.output.trim())?[{index,command:command.command,message:command.output}]:[]);
 const last=failures.at(-1);
 const recovered=!!last&&commands.slice(last.index+1).some(command=>command.exitCode===0);
 return {failures,recovered,error:last&&!recovered?'Codex could not start its shell (CreateProcessAsUserW failed: 5). Requested command execution remains blocked.':null};
}
