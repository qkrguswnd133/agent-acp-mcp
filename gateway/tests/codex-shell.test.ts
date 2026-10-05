import test from 'node:test';
import assert from 'node:assert/strict';
import {codexShellEnvironment,codexShellFailure} from '../src/codex-shell.js';
import type {CommandExecution} from '../src/command-telemetry.js';

test('Windows child drops aliases and selects native PowerShell without mutating host env',async()=>{
 const env={Path:'C:\\Users\\sample\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Native PS;C:\\Git\\cmd',SHELL:'alias',SystemRoot:'C:\\Windows'};
 const result=await codexShellEnvironment(env,'win32',async file=>file==='C:\\Native PS\\pwsh.exe');
 assert.equal(result.shell,'C:\\Native PS\\pwsh.exe');assert.equal(result.env.SHELL,result.shell);
 assert.equal(result.env.PATH,'C:\\Native PS;C:\\Native PS;C:\\Git\\cmd');assert.equal(result.env.Path,undefined);
 assert.match(env.Path,/WindowsApps/);assert.equal(env.SHELL,'alias');
});
test('Store-only PowerShell uses Windows PowerShell while preserving tool paths',async()=>{
 const result=await codexShellEnvironment({PATH:'"C:\\Program Files\\WindowsApps\\PS";C:\\Git\\cmd'},'win32',async file=>file.endsWith('WindowsPowerShell\\v1.0\\powershell.exe'));
 assert.equal(result.shell,'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
 assert.doesNotMatch(result.env.PATH!,/WindowsApps/);assert.match(result.env.PATH!,/Git\\cmd/);
});
test('native standard install wins; missing shell is explicit; POSIX is unchanged',async()=>{
 const result=await codexShellEnvironment({PATH:'C:\\Other',ProgramFiles:'D:\\Programs'},'win32',async()=>true);
 assert.equal(result.shell,'D:\\Programs\\PowerShell\\7\\pwsh.exe');
 await assert.rejects(codexShellEnvironment({},'win32',async()=>false),/CODEX_SHELL_UNAVAILABLE/);
 const env={PATH:'/bin:/tools',SHELL:'/bin/bash'};assert.deepEqual((await codexShellEnvironment(env,'linux')).env,env);
});
const command=(exitCode:number,output:string):CommandExecution=>({command:'git show HEAD',cwd:null,source:'codex_json',exitCode,output});
const failure=command(-1,'Failed to create unified exec process: CreateProcessAsUserW failed: 5 (Access denied)');
test('only actual failed launch evidence blocks completion; recovered attempts remain visible',()=>{
 assert.ok(codexShellFailure([failure]).error);
 assert.ok(codexShellFailure([command(0,'earlier success'),failure]).error);
 const recovered=codexShellFailure([failure,command(0,'commit')]);assert.equal(recovered.error,null);assert.equal(recovered.recovered,true);assert.equal(recovered.failures.length,1);
 for(const ordinary of [command(0,failure.output!),command(1,failure.output!),command(-1,'git failed'),command(-1,'Test fixture contains: '+failure.output)])assert.equal(codexShellFailure([ordinary]).error,null);
});
