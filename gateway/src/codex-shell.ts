import fs from 'node:fs/promises';
import path from 'node:path';
import type {CommandExecution} from './command-telemetry.js';

const packagedPath=(value:string)=>/(?:^|[\\/])WindowsApps(?:[\\/]|$)/i.test(value);
const envValue=(env:NodeJS.ProcessEnv,key:string)=>Object.entries(env).find(([name])=>name.toUpperCase()===key)?.[1];
/** Only the Codex child environment changes. App execution aliases cannot be
 * launched reliably with a restricted Windows token. Never relax the sandbox. */
export async function codexShellEnvironment(env:NodeJS.ProcessEnv,platform:NodeJS.Platform=process.platform,isFile:(file:string)=>Promise<boolean>=async file=>{try{return (await fs.stat(file)).isFile();}catch{return false;}}){
 if(platform!=='win32')return {env:{...env},shell:undefined};
 const directories=(envValue(env,'PATH')??'').split(';').map(value=>value.trim().replace(/^"(.*)"$/,'$1')).filter(value=>value&&!packagedPath(value));
 const programFiles=envValue(env,'PROGRAMFILES')??'C:\\Program Files';
 const systemRoot=envValue(env,'SYSTEMROOT')??envValue(env,'WINDIR')??'C:\\Windows';
 const candidates=[path.win32.join(programFiles,'PowerShell','7','pwsh.exe'),...directories.filter(value=>path.win32.isAbsolute(value)).map(value=>path.win32.join(value,'pwsh.exe')),path.win32.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe')];
 let shell:string|undefined;
 for(const candidate of [...new Set(candidates)])if(!packagedPath(candidate)&&await isFile(candidate)){shell=candidate;break;}
 if(!shell)throw Error('CODEX_SHELL_UNAVAILABLE: No native PowerShell executable is available outside WindowsApps. Install a native PowerShell distribution or repair Windows PowerShell.');
 const child={...env};for(const key of Object.keys(child))if(['PATH','SHELL'].includes(key.toUpperCase()))delete child[key];
 child.PATH=[path.win32.dirname(shell),...directories].join(';');child.SHELL=shell;
 return {env:child,shell};
}

/** Only provider command events qualify; assistant prose and ordinary command
 * errors are not shell-launch evidence. Keep recovered failures as diagnostics. */
export function codexShellFailure(commands:CommandExecution[]){
 const failures=commands.flatMap((command,index)=>command.exitCode===-1&&command.source==='codex_json'&&typeof command.output==='string'&&/^(?:Failed to create unified exec process:|windows sandbox failed:)\s*CreateProcessAsUserW failed:\s*5\b/i.test(command.output.trim())?[{index,command:command.command,message:command.output}]:[]);
 const last=failures.at(-1);
 const recovered=!!last&&commands.slice(last.index+1).some(command=>command.exitCode===0);
 return {failures,recovered,error:last&&!recovered?'Codex could not start its shell (CreateProcessAsUserW failed: 5). Requested command execution remains blocked.':null};
}
