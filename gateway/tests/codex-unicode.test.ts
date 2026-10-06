import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import readline from 'node:readline';
import {codexShellEnvironment} from '../src/codex-shell.js';
import {safeChildEnv,terminateProcess} from '../src/process.js';

const quote=(value:string)=>`'${value.replace(/'/g,"''")}'`;
function run(file:string,args:string[],env:NodeJS.ProcessEnv,cwd:string,detached=false){
 return new Promise<{code:number|null;stdout:string;stderr:string}>((resolve,reject)=>{
  const child=spawn(file,args,{env,cwd,detached,windowsHide:true,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
  child.stdout.setEncoding('utf8').on('data',value=>stdout+=value);child.stderr.setEncoding('utf8').on('data',value=>stderr+=value);child.stdin.end();
  const timer=setTimeout(()=>{void terminateProcess(child);reject(Error('Shell test timed out'));},30000);
  child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});
 });
}
async function sandboxCommand(file:string,command:string[],env:NodeJS.ProcessEnv,cwd:string){
 const child=spawn(file,['app-server','-c','windows.sandbox="unelevated"','-c','allow_login_shell=false','-c','mcp_servers={}','-c','features.plugins=false'],{env,cwd,windowsHide:true,stdio:['pipe','pipe','pipe']});
 const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();let id=0;
 const fail=(error:Error)=>{for(const item of pending.values())item.reject(error);pending.clear();};
 child.on('error',fail);child.stdin.on('error',fail);child.on('exit',()=>fail(Error('App server exited')));child.stderr.on('data',()=>{});
 const lines=readline.createInterface({input:child.stdout});
 lines.on('line',line=>{try{const message=JSON.parse(line),item=pending.get(message.id);if(item){pending.delete(message.id);if(message.error)item.reject(Error(JSON.stringify(message.error)));else item.resolve(message.result);}}catch{}});
 const request=(method:string,params:any)=>new Promise<any>((resolve,reject)=>{const requestId=++id;pending.set(requestId,{resolve,reject});child.stdin.write(JSON.stringify({id:requestId,method,params})+'\n');});
 const timer=setTimeout(()=>fail(Error('Sandbox command timed out')),30000);
 try{
  await request('initialize',{clientInfo:{name:'unicode-sandbox-test',version:'1'},capabilities:{experimentalApi:true}});
  child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
  const result=await request('command/exec',{command,cwd,sandboxPolicy:{type:'readOnly'},timeoutMs:20000});
  return {code:result.exitCode,stdout:result.stdout as string,stderr:result.stderr as string};
 }finally{clearTimeout(timer);lines.close();child.stdin.end();await terminateProcess(child);}
}

// Opt-in integration check: no model/authentication calls, no changes to a real
// user profile or CLI installation. Copy the runtime so a poisonous profile can
// establish that -NoProfile really suppresses startup execution.
test('native PowerShell preserves Korean UTF-8 and suppresses profiles inside the read-only Codex sandbox',{
 skip:process.platform!=='win32'||!process.env.CODEX_UTF8_SANDBOX_CLI,
 timeout:120000,
},async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'codex-unicode-'));
 try{
  const initial=await codexShellEnvironment(safeChildEnv({CODEX_POWERSHELL_PATH:process.env.CODEX_POWERSHELL_PATH}));
  assert.ok(initial.nativeShell);
  const runtime=path.join(root,'runtime');
  await fs.cp(path.dirname(initial.nativeShell),runtime,{recursive:true});
  const shell=path.join(runtime,'pwsh.exe');
  const profile='PROFILE_SHOULD_NOT_RUN';
  await fs.writeFile(path.join(runtime,'Microsoft.PowerShell_profile.ps1'),`[Console]::Error.WriteLine('${profile}')`,'utf8');
  const codexHome=path.join(root,'codex-home');await fs.mkdir(codexHome);
  const environment=await codexShellEnvironment(safeChildEnv({CODEX_POWERSHELL_PATH:shell,CODEX_HOME:codexHome}));
  const baseline=await run(shell,['-NoLogo','-NonInteractive','-ExecutionPolicy','Bypass','-Command',"'profile control'"],environment.env,root);
  assert.equal(baseline.code,0,JSON.stringify(baseline));assert.match(baseline.stderr,new RegExp(profile));
  const fileText='// 한글 주석: 사용자 이름을 그대로 읽습니다.\nconst 메시지 = "안녕하세요 세계";\n';
  const nativeText='네이티브 출력: 한글 경로와 값 보존';
  const source=path.join(root,'한글-소스.ts'),native=path.join(root,'native.cjs'),blocked=path.join(root,'must-not-write.txt'),writeProbe=path.join(root,'write-probe.cjs');
  await fs.writeFile(source,fileText,'utf8');
  await fs.writeFile(native,`process.stdout.write(${JSON.stringify(nativeText)});`,'utf8');
  await fs.writeFile(writeProbe,`try {require('node:fs').writeFileSync(${JSON.stringify(blocked)},'forbidden');process.exit(27);}catch(error){if(!['EACCES','EPERM'].includes(error.code))throw error;process.stdout.write('READ_ONLY_BLOCKED');}`,'utf8');
  const argvProbe=path.join(root,'argv.cjs'),fileProbe=path.join(root,'argv.ps1');
  await fs.writeFile(argvProbe,'process.stdout.write(JSON.stringify(process.argv.slice(2)));','utf8');
  await fs.writeFile(fileProbe,`& ${quote(process.execPath)} ${quote(argvProbe)} @args\nexit 37`,'utf8');
  const values=['한글 공백','a"b','C:\\path with space\\','$HOME','semi; & operator',''];
  const direct=await run(environment.shell!,['-File',fileProbe,...values],environment.env,root);
  assert.equal(direct.code,37,JSON.stringify(direct));assert.deepEqual(JSON.parse(direct.stdout),values);
  assert.doesNotMatch(direct.stderr,/PROFILE_SHOULD_NOT_RUN|CODEX_UTF8_INIT_FAILED/);
  const headless=await run(environment.shell!,['-File',fileProbe,...values],environment.env,root,true);
  assert.equal(headless.code,37,JSON.stringify(headless));assert.deepEqual(JSON.parse(headless.stdout),values);
  // App-server command/exec runs argv directly. Reproduce the unconditional UTF-8
  // prelude added by the actual 0.159.3 unified-exec tool (not by the model):
  // https://github.com/openai/codex/blob/rust-v0.159.3/codex-rs/core/src/tools/runtimes/unified_exec.rs#L566-L569
  // https://github.com/openai/codex/blob/rust-v0.159.3/codex-rs/shell-command/src/powershell.rs#L10-L12
  const prelude='try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n';
  const script=prelude+`$ErrorActionPreference='Stop'; Get-Content -LiteralPath ${quote(source)} -Raw; & ${quote(process.execPath)} ${quote(native)}; & ${quote(process.execPath)} ${quote(writeProbe)}; if ($LASTEXITCODE -ne 0) { throw 'READ_ONLY_BYPASSED' }`;
  const result=await sandboxCommand(process.env.CODEX_UTF8_SANDBOX_CLI!,[environment.shell!,'-NoLogo','-NoProfile','-Command',script],environment.env,root);
  assert.equal(result.code,0,JSON.stringify(result));
  assert.ok(result.stdout.includes(fileText),result.stdout);
  assert.ok(result.stdout.includes(nativeText),result.stdout);
  assert.match(result.stdout,/READ_ONLY_BLOCKED/);
  assert.doesNotMatch(result.stdout+result.stderr,/\uFFFD|PROFILE_SHOULD_NOT_RUN/);
  await assert.rejects(fs.stat(blocked),{code:'ENOENT'});
 }finally{
  // Confirm the exact mkdtemp result remains within the intended temp directory.
  assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('codex-unicode-'));
  await fs.rm(root,{recursive:true,force:true});
 }
});
