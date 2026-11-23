import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {withCliUpdateLock,withProviderCliUse,processUsesCli} from '../src/cli-update-lock.js';
import type {RecordedProcessIdentity,ProcessInventory} from '../src/process-inventory.js';

const row=(pid:number,other:Partial<RecordedProcessIdentity>={}):RecordedProcessIdentity=>({
 pid,createdAt:null,imageName:null,observedAt:'',...other
});
const inventory=(...rows:RecordedProcessIdentity[]):ProcessInventory=>({observedAt:'',processes:rows,complete:true});
async function fixture(){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agent-provider-guard-'));
 return {dir,options:{leaseDir:path.join(dir,'locks'),installRoot:path.join(dir,'gateway'),stateDirectory:path.join(dir,'state'),inventory:async()=>inventory()}};
}
test('independent process writer rejects competing writers and Gateway use; other provider and next use succeed',async()=>{
 const {dir,options}=await fixture();
 const code=`import {withCliUpdateLock} from ${JSON.stringify(new URL('../src/cli-update-lock.js',import.meta.url).href)};
 await withCliUpdateLock('codex',async()=>{process.send('entered');await new Promise(r=>process.on('message',r));}, {...${JSON.stringify(options)},inventory:async()=>({complete:true,processes:[]})});process.disconnect();`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});
 const exited=once(child,'exit');
 try{
  await Promise.race([once(child,'message'),exited.then(code=>{throw Error('worker exited: '+code);})]);
  await assert.rejects(withCliUpdateLock('codex',async()=>assert.fail(),options),{code:'CLI_UPDATE_BUSY'});
  await assert.rejects(withProviderCliUse('codex',async()=>assert.fail(),undefined,options),{code:'CLI_UPDATE_BUSY'});
  assert.equal(await withProviderCliUse('claude',async()=>1,undefined,options),1);
  child.send('done');await exited;
  assert.equal(await withProviderCliUse('codex',async()=>2,undefined,options),2);
 }finally{if(child.exitCode===null&&child.signalCode===null){child.kill();await exited;}await fs.rm(dir,{recursive:true,force:true});}
});
test('running reader excludes writer; generations invalidate exactly once including a failed update',async()=>{
 const {dir,options}=await fixture();let cleared=0;
 const read=()=>withProviderCliUse('claude',async()=>{},()=>{cleared++;},options);
 try{
  await withProviderCliUse('claude',async()=>{
   await assert.rejects(withCliUpdateLock('claude',async()=>assert.fail(),options),{code:'CLI_UPDATE_BUSY'});
  },undefined,options);
  await read();await read();assert.equal(cleared,1);
  await assert.rejects(withCliUpdateLock('claude',async()=>{throw Error('partial replacement');},options),/partial replacement/);
  await read();await read();assert.equal(cleared,2);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('parallel provider updates serialize only when they share an npm installation',async()=>{
 const {dir,options}=await fixture();
 const scope=(name:string,prefix:string)=>({...options,processPaths:[path.join(dir,prefix,'node_modules',name)]});
 try{
  await withCliUpdateLock('codex',async()=>{
   await assert.rejects(withCliUpdateLock('claude',async()=>assert.fail(),scope('@anthropic-ai/claude-code','shared')),{code:'CLI_UPDATE_BUSY'});
   assert.equal(await withCliUpdateLock('claude',async()=>1,scope('@anthropic-ai/claude-code','separate')),1);
  },scope('@openai/codex','shared'));
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('active Gateway jobs and matching external sessions exclude the writer',async()=>{
 const {dir,options}=await fixture(),jobDir=path.join(options.stateDirectory,'jobs');
 const id=randomUUID(),job={status:'queued',provider:'auto',ownerPid:4321,startedAt:'2026-10-01T00:00:00Z'};
 const candidate=path.join(dir,'bin','codex');
 try{
  await fs.mkdir(jobDir,{recursive:true});const jobFile=path.join(jobDir,id+'.json');
  await fs.writeFile(jobFile,JSON.stringify(job));
  await assert.rejects(withCliUpdateLock('codex',async()=>assert.fail(),{...options,inventory:async()=>inventory(row(4321))}),/queued/);
  await fs.writeFile(jobFile,JSON.stringify({...job,status:'completed'}));
  await assert.rejects(withCliUpdateLock('codex',async()=>assert.fail(),{...options,targetPath:candidate,inventory:async()=>inventory(row(4321,{executablePath:candidate}))}),/4321/);
  await assert.rejects(withCliUpdateLock('codex',async()=>assert.fail(),{...options,inventory:async()=>{throw Error('denied');}}),{code:'CLI_UPDATE_BUSY'});
  assert.equal(await withCliUpdateLock('codex',async()=>1,options),1);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('external session detection handles native paths and npm script paths with spaces, ignores decoy arguments and separate desktop binary',()=>{
 const packageRoot='C:/Users/User Name/npm/node_modules/@openai/codex',node='C:/bin/node.exe';
 const target='C:/Users/User Name/Programs/OpenAI/Codex/bin/codex.exe';
 const script=packageRoot+'/bin/codex.js';
 assert.equal(processUsesCli(row(101,{imageName:'node.exe',executablePath:node,commandLine:'node.exe "'+script+'" exec'}),'codex',[packageRoot],'win32'),true);
 assert.equal(processUsesCli(row(101,{imageName:'node.exe',executablePath:node,commandLine:'node.exe C:/other/script.js "'+script+'"'}),'codex',[packageRoot],'win32'),false);
 assert.equal(processUsesCli(row(102,{imageName:'codex.exe',executablePath:'C:/Program Files/WindowsApps/OpenAI/app/resources/codex.exe'}),'codex',[target],'win32'),false);
 assert.equal(processUsesCli(row(102,{imageName:'codex.exe'}),'codex',[target],'win32'),true);
 assert.equal(processUsesCli(row(103,{imageName:'node',argv:['node','/home/user name/pkg/cli.js','exec']}),'claude',['/home/user name/pkg'],'linux'),true);
 assert.equal(processUsesCli(row(103,{imageName:'node',cwd:'/home/test/pkg',argv:['node','--require','/elsewhere/support.js','./cli.js']}),'claude',['/home/test/pkg'],'linux'),true);
 assert.equal(processUsesCli(row(103,{imageName:'node',argv:['node','-e','CODE',script]}),'codex',[packageRoot],'win32'),false);
 assert.equal(processUsesCli(row(103,{imageName:'claude',argv:['claude'],executablePath:'/usr/bin/node'}),'claude',['/home/test/pkg'],'linux'),true);
});
test('native process inventory blocks an independently launched CLI script and permits retry after exit',async()=>{
 const {dir,options}=await fixture(),packageDir=path.join(dir,'fixture package'),script=path.join(packageDir,'cli.cjs');
 await fs.mkdir(packageDir);await fs.writeFile(script,"process.send('ready');process.on('message',()=>process.disconnect());");
 const child=spawn(process.execPath,[script],{stdio:['ignore','ignore','pipe','ipc'],windowsHide:true}),exited=once(child,'exit');
 const actual={...options,inventory:undefined,targetPath:script,processPaths:[packageDir]};
 try{
  await Promise.race([once(child,'message'),exited.then(()=>{throw Error('External CLI fixture exited early');})]);
  await assert.rejects(withCliUpdateLock('codex',async()=>assert.fail(),actual),new RegExp('PID '+child.pid+'\\b'));
  child.send('done');await exited;
  assert.equal(await withCliUpdateLock('codex',async()=>1,actual),1);
 }finally{if(child.exitCode===null&&child.signalCode===null){child.kill();await exited;}await fs.rm(dir,{recursive:true,force:true});}
});
test('existing Linux application updater lock blocks CLI updates',{skip:process.platform!=='linux'},async()=>{
 const {dir,options}=await fixture();
 try{
  await fs.mkdir(options.stateDirectory,{recursive:true});await fs.writeFile(path.join(options.stateDirectory,'update.lock'),'');
  await assert.rejects(withCliUpdateLock('grok',async()=>assert.fail(),options),{code:'CLI_UPDATE_BUSY'});
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('actual Windows FileShare.None application lock blocks CLI updates and unlock allows retry',{skip:process.platform!=='win32'},async()=>{
 const {dir,options}=await fixture();
 const file=options.installRoot+'.update.lock',shell=path.join(process.env.SystemRoot!,'System32/WindowsPowerShell/v1.0/powershell.exe');
 const script="$ErrorActionPreference='Stop'; $f=[IO.File]::Open($env:FIXTURE_APP_LOCK,'OpenOrCreate','ReadWrite','None');try{[Console]::WriteLine('ready');[Console]::In.ReadLine()|Out-Null}finally{$f.Dispose()}";
 const child=spawn(shell,['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,env:{...process.env,FIXTURE_APP_LOCK:file}});
 const exited=once(child,'exit');
 try{
  await Promise.race([once(child.stdout,'data'),exited.then(()=>{throw Error('Fixture exited without holding a lock');})]);
  await assert.rejects(withCliUpdateLock('grok',async()=>assert.fail(),options),{code:'CLI_UPDATE_BUSY'});
  child.stdin.end('\n');await exited;
  assert.equal(await withCliUpdateLock('grok',async()=>1,options),1);
 }finally{
  if(child.exitCode===null&&child.signalCode===null){child.kill();await exited;}
  await fs.rm(dir,{recursive:true,force:true});
 }
});

