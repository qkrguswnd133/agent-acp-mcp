// Full Windows release smoke through the packaged Electron update button.
// Every installation, profile, and process launched here is a disposable fixture.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Client} from '../gateway/node_modules/@modelcontextprotocol/client/dist/index.mjs';
import {StdioClientTransport} from '../gateway/node_modules/@modelcontextprotocol/client/dist/stdio.mjs';

const exec=promisify(execFile),self=fileURLToPath(import.meta.url),repository=path.resolve(path.dirname(self),'..');
const write=async(file,value)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(value));};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function read(file){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch{return null;}}
async function events(file){try{return (await fs.readFile(file,'utf8')).split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));}catch{return [];}}
async function waitFor(fn,timeout=120000,label='isolated update'){
  const end=Date.now()+timeout;
  while(Date.now()<end){const value=await fn();if(value)return value;await sleep(300);}
  throw Error(`Timed out waiting for ${label}`);
}
async function powershell(script){return exec('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:30000});}
async function monitorPids(exe){
  const escaped=exe.replaceAll("'","''");
  const {stdout}=await powershell(`@(Get-CimInstance Win32_Process -Filter "Name = 'Agent Monitor.exe'" | Where-Object { $_.ExecutablePath -eq '${escaped}' } | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress`);
  if(!stdout.trim())return [];
  const value=JSON.parse(stdout);return value==null?[]:Array.isArray(value)?value:[value];
}
async function injectFixtureHarness(monitor,root){
  const monitorRequire=createRequire(path.join(repository,'monitor/package.json'));
  const asar=await import(pathToFileURL(monitorRequire.resolve('@electron/asar')).href);
  const archive=path.join(monitor,'resources','app.asar'),extracted=path.join(root,'instrumented-app');
  asar.extractAll(archive,extracted);
  await fs.copyFile(path.join(repository,'tests','Smoke-Electron-Harness.cjs'),path.join(extracted,'smoke-harness.cjs'));
  const main=path.join(extracted,'main.cjs');
  await fs.writeFile(main,"require('./smoke-harness.cjs');\n"+(await fs.readFile(main,'utf8')));
  await fs.rm(archive);
  await asar.createPackage(extracted,archive);
  await fs.rm(extracted,{recursive:true,force:true});
}

if(process.platform!=='win32')throw Error('This packaged Electron smoke requires native Windows.');
if(!process.argv[2])throw Error('Usage: node tests/Smoke-Release.mjs <built-release-artifact-directory>');
const artifacts=path.resolve(process.argv[2]),payload=path.join(artifacts,'payload');
const manifest=await read(path.join(artifacts,'update-manifest.json'));
assert.ok(manifest?.version&&manifest?.asset?.name,'Signed release artifacts are missing');
assert.ok(await fs.stat(path.join(artifacts,manifest.asset.name)).then(s=>s.isFile()).catch(()=>false),'Release ZIP is missing');

const root=await fs.mkdtemp(path.join(os.tmpdir(),'agent-release-e2e-'));
const gateway=path.join(root,'gateway'),monitor=path.join(root,'monitor'),data=path.join(root,'data'),exe=path.join(monitor,'Agent Monitor.exe');
const eventFile=path.join(root,'electron-events.jsonl');
let client,original,success=false;
try {
  await fs.cp(path.join(payload,'gateway'),gateway,{recursive:true});
  await fs.cp(path.join(payload,'monitor'),monitor,{recursive:true});
  await injectFixtureHarness(monitor,root);
  const receipt={schemaVersion:1,version:'0.0.0',components:{gateway:'0.0.0',monitor:'0.0.0'},installedAt:new Date().toISOString()};
  await write(path.join(gateway,'release-receipt.json'),receipt);
  await write(path.join(monitor,'release-receipt.json'),receipt);
  const providerEnv={GROK_ENABLED:'false',CLAUDE_ENABLED:'false',CODEX_ENABLED:'false'};
  const settings={gatewayRoot:gateway,nodeExecutable:process.execPath,env:providerEnv};
  await write(path.join(monitor,'agent-monitor.config.json'),settings);
  await write(path.join(gateway,'configuration','fixture.json'),{preserved:true});
  await write(path.join(gateway,'state','fixture.json'),{preserved:true});
  await write(path.join(data,'window.json'),{x:100,y:100,pinned:false});
  client=new Client({name:'codex-release-smoke',version:'1.0.0'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(gateway,'dist/src/index.js')],cwd:gateway,env:{...process.env,...providerEnv},stderr:'pipe'}));
  await client.listTools();
  const monitorEnv={...process.env,...providerEnv,AGENT_SMOKE_ARTIFACTS:artifacts,AGENT_SMOKE_EVENTS:eventFile};
  delete monitorEnv.ELECTRON_RUN_AS_NODE;
  original=spawn(exe,[`--data-dir=${data}`],{env:monitorEnv,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const appendDiagnostic=(name,chunk)=>{void fs.appendFile(path.join(root,name),chunk).catch(()=>{});};
  original.stdout.on('data',chunk=>appendDiagnostic('electron-stdout.log',chunk));
  original.stderr.on('data',chunk=>appendDiagnostic('electron-stderr.log',chunk));
  let originalExitedAt=0;
  original.once('exit',(code,signal)=>{originalExitedAt=Date.now();void fs.appendFile(eventFile,JSON.stringify({event:'original-monitor-exit',code,signal,at:new Date().toISOString()})+'\n').catch(()=>{});});
  original.once('error',error=>{void fs.appendFile(eventFile,JSON.stringify({event:'monitor-spawn-error',message:error.message})+'\n').catch(()=>{});});
  await waitFor(async()=>!!await read(path.join(data,'latest-status.json')),120000,'initial monitor status');
  await waitFor(async()=>{const log=await events(eventFile);return log.find(item=>item.event==='bar-update-click');},120000,'actual update button click');
  const pendingFile=path.join(data,'updates','pending-install.json');
  const operation=await waitFor(async()=>{
    const pending=await read(pendingFile);if(pending?.operationId)return pending;
    const log=await events(eventFile);const started=log.find(item=>item.event==='install-returned'&&item.started);
    if(started?.operationId)return started;
    if(originalExitedAt)throw Error('Original Electron process exited before dispatching the installer');
    return null;
  },180000,'installer dispatch from Electron UI');
  assert.ok(operation.operationId);
  await waitFor(async()=>{
    if(originalExitedAt)return originalExitedAt;
    const early=await read(path.join(data,'updates','install-result.json'));
    if(early?.operationId===operation.operationId&&early.status!=='success')throw Error(`Installer returned ${early.status} before original monitor exited: ${early.message||''}`);
    return null;
  },120000,'original monitor shutdown');
  const pending=await read(pendingFile);
  if(pending?.helperPid)assert.doesNotThrow(()=>process.kill(pending.helperPid,0),'WMI installer stopped with original Electron process');
  const result=await waitFor(async()=>{const value=await read(path.join(data,'updates','install-result.json'));return value?.operationId===operation.operationId?value:null;},240000,'independent installer result');
  assert.equal(result.status,'success',JSON.stringify(result));
  assert.ok(Date.parse(result.finishedAt)>=originalExitedAt-1000,'Installer did not outlive original monitor');
  assert.equal((await read(path.join(gateway,'release-receipt.json'))).version,manifest.version);
  assert.equal((await read(path.join(monitor,'release-receipt.json'))).version,manifest.version);
  assert.deepEqual(await read(path.join(monitor,'agent-monitor.config.json')),settings);
  assert.deepEqual(await read(path.join(gateway,'configuration/fixture.json')),{preserved:true});
  assert.deepEqual(await read(path.join(gateway,'state/fixture.json')),{preserved:true});
  const restarted=await waitFor(async()=>{const pids=await monitorPids(exe);return pids.find(pid=>pid!==original.pid);},120000,'monitor restart');
  const history=await read(path.join(data,'updates','history.json'));
  assert.ok(Array.isArray(history)&&history.some(item=>item.operationId===operation.operationId&&item.status==='success'),'Successful update history is missing');
  const windowState=await read(path.join(data,'window.json'));
  assert.equal(windowState?.pinned,false,'Window pin preference was lost');
  assert.ok(Number.isFinite(windowState.x)&&Number.isFinite(windowState.y),'Window position was lost');
  const log=await events(eventFile);
  assert.ok(log.some(item=>item.event==='bar-update-click'),'Update was not clicked through Electron renderer');
  assert.equal(log.filter(item=>item.event==='install-returned'&&item.started).length,1,'Concurrent update requests launched duplicate installers');
  assert.ok(log.some(item=>item.event==='update-state'&&item.selected===manifest.version),'Signed release was not selected in Electron');
  success=true;
  console.log(JSON.stringify({passed:true,version:manifest.version,uiButtonClicked:true,entrypoint:'bar-download-icon',externalInstallerSurvivedLauncherExit:true,settingsPreserved:true,receipts:true,monitorRestarted:restarted,fixtureRoot:root}));
}finally{
  await client?.close().catch(()=>{});
  const pids=await monitorPids(exe).catch(()=>[]);
  if(pids.length){await exec(exe,['--quit',`--data-dir=${data}`],{windowsHide:true,timeout:10000}).catch(()=>{});await waitFor(async()=>!(await monitorPids(exe)).length,15000,'fixture monitor exit').catch(()=>{});}
  // Keep failures for diagnosis. Only remove our generated temporary root.
  if(success&&path.dirname(root)===os.tmpdir()&&/^agent-release-e2e-[A-Za-z0-9]+$/.test(path.basename(root)))await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:500});
  else if(!success)console.error('Fixture retained for diagnosis: '+root);
}
