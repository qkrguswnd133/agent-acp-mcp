import test from 'node:test';
import assert from 'node:assert/strict';
import {codexShellEnvironment,codexShellFailure} from '../src/codex-shell.js';
import type {CommandExecution} from '../src/command-telemetry.js';
import {codexExecutionArgs} from '../src/providers/codex.js';

const shellOptions=(isFile:(file:string)=>Promise<boolean>,majorVersion=async()=>7)=>({isFile:async(file:string)=>file==='C:\\Gateway\\runtime\\codex-shell\\pwsh.exe'||await isFile(file),majorVersion,gatewayRoot:'C:\\Gateway'});

test('Windows child drops aliases and selects native PowerShell without mutating host env',async()=>{
 const env={Path:'C:\\Users\\sample\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Native PS;C:\\Git\\cmd',SHELL:'alias',SystemRoot:'C:\\Windows'};
 const result=await codexShellEnvironment(env,'win32',shellOptions(async file=>file==='C:\\Native PS\\pwsh.exe'));
 assert.equal(result.nativeShell,'C:\\Native PS\\pwsh.exe');assert.equal(result.env.SHELL,result.shell);
 assert.equal(result.env.CODEX_NATIVE_POWERSHELL_PATH,result.nativeShell);
 assert.equal(result.env.PATH,'C:\\Gateway\\runtime\\codex-shell;C:\\Native PS;C:\\Native PS;C:\\Git\\cmd');assert.equal(result.env.Path,undefined);
 assert.match(env.Path,/WindowsApps/);assert.equal(env.SHELL,'alias');
});
test('Store-only PowerShell uses bundled native PowerShell while preserving tool paths',async()=>{
 const result=await codexShellEnvironment({PATH:'"C:\\Program Files\\WindowsApps\\PS";C:\\Git\\cmd'},'win32',shellOptions(async file=>file==='C:\\Gateway\\runtime\\powershell7\\pwsh.exe'));
 assert.equal(result.nativeShell,'C:\\Gateway\\runtime\\powershell7\\pwsh.exe');
 assert.doesNotMatch(result.env.PATH!,/WindowsApps/);assert.match(result.env.PATH!,/Git\\cmd/);
});
test('native standard install wins; missing shell is explicit; POSIX is unchanged',async()=>{
 const result=await codexShellEnvironment({PATH:'C:\\Other',ProgramFiles:'D:\\Programs'},'win32',shellOptions(async file=>!file.startsWith('C:\\Gateway')));
 assert.equal(result.nativeShell,'D:\\Programs\\PowerShell\\7\\pwsh.exe');
 await assert.rejects(codexShellEnvironment({},'win32',shellOptions(async()=>false)),/CODEX_SHELL_UNAVAILABLE/);
 const env={PATH:'/bin:/tools',SHELL:'/bin/bash'};assert.deepEqual((await codexShellEnvironment(env,'linux')).env,env);
});
test('bundled native runtime wins over standard/PATH installs; configured runtime wins over bundle',async()=>{
 const options=shellOptions(async()=>true);
 assert.equal((await codexShellEnvironment({PATH:'C:\\Other'},'win32',options)).nativeShell,'C:\\Gateway\\runtime\\powershell7\\pwsh.exe');
 assert.equal((await codexShellEnvironment({CODEX_POWERSHELL_PATH:'D:\\Portable\\pwsh.exe'},'win32',options)).nativeShell,'D:\\Portable\\pwsh.exe');
 for(const explicit of ['pwsh.exe','C:\\WindowsApps\\PS\\pwsh.exe','C:\\Windows\\powershell.exe'])await assert.rejects(codexShellEnvironment({CODEX_POWERSHELL_PATH:explicit},'win32',options),/CODEX_POWERSHELL_PATH/);
 await assert.rejects(codexShellEnvironment({CODEX_POWERSHELL_PATH:'D:\\Missing\\pwsh.exe'},'win32',shellOptions(async()=>false)),/CODEX_POWERSHELL_PATH/);
});
test('a renamed PS5 executable or unusable runtime cannot pass the UTF-8 requirement',async()=>{
 await assert.rejects(codexShellEnvironment({},'win32',shellOptions(async()=>true,async()=>5)),/Windows PowerShell 5.1 is not a safe UTF-8 fallback/);
 const options={...shellOptions(async()=>true),majorVersion:async(file:string)=>file.startsWith('C:\\Gateway')?undefined:7};
 assert.equal((await codexShellEnvironment({},'win32',options)).nativeShell,'C:\\Program Files\\PowerShell\\7\\pwsh.exe');
 await assert.rejects(codexShellEnvironment({CODEX_POWERSHELL_PATH:'D:\\Broken\\pwsh.exe'},'win32',{...options,majorVersion:async()=>undefined}),/CODEX_POWERSHELL_PATH did not start/);
});
test('all Codex runs prohibit login/profile shells while preserving their sandbox policy',()=>{
 for(const platform of ['win32','linux','darwin'] as const)for(const writable of [false,true])for(const mode of ['read-only','workspace-write','danger-full-access']){
  const args=codexExecutionArgs(writable,platform,{CODEX_IMPLEMENT_SANDBOX:mode});
  assert.ok(args.includes('allow_login_shell=false'));
  assert.equal(args[args.indexOf('--sandbox')+1],writable?mode:'read-only');
  assert.ok(!args.some(value=>/bypass|dangerously/.test(value)));
 }
});
const command=(exitCode:number,output:string):CommandExecution=>({command:'git show HEAD',cwd:null,source:'codex_json',exitCode,output});
const failure=command(-1,'Failed to create unified exec process: CreateProcessAsUserW failed: 5 (Access denied)');
test('only actual failed launch evidence blocks completion; recovered attempts remain visible',()=>{
 assert.ok(codexShellFailure([failure]).error);
 assert.ok(codexShellFailure([command(0,'earlier success'),failure]).error);
 const recovered=codexShellFailure([failure,command(0,'commit')]);assert.equal(recovered.error,null);assert.equal(recovered.recovered,true);assert.equal(recovered.failures.length,1);
 for(const ordinary of [command(0,failure.output!),command(1,failure.output!),command(-1,'git failed'),command(-1,'Test fixture contains: '+failure.output)])assert.equal(codexShellFailure([ordinary]).error,null);
});
