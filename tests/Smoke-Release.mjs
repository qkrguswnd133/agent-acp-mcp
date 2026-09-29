// Full Windows release smoke. All installations and data are disposable fixtures.
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {Client} from '../gateway/node_modules/@modelcontextprotocol/client/dist/index.mjs';
import {StdioClientTransport} from '../gateway/node_modules/@modelcontextprotocol/client/dist/stdio.mjs';
const require=createRequire(import.meta.url),exec=promisify(execFile);
const {createUpdater}=require('../monitor/update/service.cjs');
const self=fileURLToPath(import.meta.url),repository=path.resolve(path.dirname(self),'..');
const write=async(file,value)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(value));};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function read(file){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch{return null;}}
async function waitFor(fn,timeout=120000){const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(value)return value;await sleep(300);}throw Error('Timed out waiting for isolated update');}
async function powershell(script){return exec('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:30000});}
async function monitorPids(exe){const escaped=exe.replaceAll("'","''");const {stdout}=await powershell(`@(Get-CimInstance Win32_Process -Filter "Name = 'Agent Monitor.exe'" | Where-Object { $_.ExecutablePath -eq '${escaped}' } | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress`);return stdout.trim()?JSON.parse(stdout):[];}

if(process.argv[2]==='--dispatch'){
  const artifacts=path.resolve(process.argv[3]),root=path.resolve(process.argv[4]);
  const raw=await fs.readFile(path.join(artifacts,'update-manifest.json')),signature=await fs.readFile(path.join(artifacts,'update-manifest.sig'));
  const manifest=JSON.parse(raw),base=`https://github.com/${manifest.repository}/releases/download/${manifest.tag}/`;
  const assets=[{name:'update-manifest.json',size:raw.length},{name:'update-manifest.sig',size:signature.length},{name:manifest.asset.name,size:manifest.asset.size}].map(a=>({...a,browser_download_url:base+a.name}));
  const fetcher=async(url,options={})=>{
    if(String(url).startsWith('https://api.github.com/'))return new Response(JSON.stringify([{tag_name:manifest.tag,draft:false,prerelease:false,published_at:manifest.publishedAt,assets}]));
    if(url===base+'update-manifest.json')return new Response(raw);
    if(url===base+'update-manifest.sig')return new Response(signature);
    if(url===base+manifest.asset.name)return new Response(syncFs.createReadStream(path.join(artifacts,manifest.asset.name)),{headers:{'content-length':String(manifest.asset.size)}});
    throw Error('Unexpected release request');
  };
  // This dispatcher is plain Node, not Electron. The app's production finder
  // excludes its own executable (Electron), so inject our verified test runtime.
  // The running fixture may have checked real GitHub before this dispatcher.
  // Its network cooldown does not apply to the isolated, in-memory release feed.
  await fs.rm(path.join(root,'data/updates/rate-limit.json'),{force:true});
  const service=createUpdater({stateDir:path.join(root,'data'),monitorDirectory:path.join(root,'monitor'),gatewayDirectory:path.join(root,'gateway'),fetcher,keyFile:path.join(repository,'monitor/update/trusted-key.pem'),appVersion:manifest.components.monitor,nodeFinder:async()=>process.execPath});
  await service.load();await service.check(true);assert.equal(service.getState().selected?.version,manifest.version);
  await service.download();assert.equal(service.getState().downloaded,true,service.getState().error);
  const started=await service.install();assert.equal(started.started,true,started.reason);
  console.log(JSON.stringify(started));process.exit(0); // The WMI installer must outlive this launcher.
}

const artifacts=path.resolve(process.argv[2]||path.join(repository,'build/release/v2.2.0'));
const payload=path.join(artifacts,'payload');
const manifest=await read(path.join(artifacts,'update-manifest.json'));assert.ok(manifest);
const root=await fs.mkdtemp(path.join(os.tmpdir(),'agent-release-e2e-'));
const gateway=path.join(root,'gateway'),monitor=path.join(root,'monitor'),data=path.join(root,'data'),exe=path.join(monitor,'Agent Monitor.exe');
let client,success=false;
try{
  await fs.cp(path.join(payload,'gateway'),gateway,{recursive:true});
  await fs.cp(path.join(payload,'monitor'),monitor,{recursive:true});
  const receipt={schemaVersion:1,version:'2.1.0',components:manifest.components,installedAt:new Date().toISOString()};
  await write(path.join(gateway,'release-receipt.json'),receipt);await write(path.join(monitor,'release-receipt.json'),receipt);
  const env={GROK_ENABLED:'false',CLAUDE_ENABLED:'false',CODEX_ENABLED:'false'};
  const settings={gatewayRoot:gateway,nodeExecutable:process.execPath,env};
  await write(path.join(monitor,'agent-monitor.config.json'),settings);
  await write(path.join(gateway,'configuration','fixture.json'),{preserved:true});
  await write(path.join(gateway,'state','fixture.json'),{preserved:true});
  client=new Client({name:'codex-release-smoke',version:'1.0.0'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(gateway,'dist/src/index.js')],cwd:gateway,env:{...process.env,...env},stderr:'pipe'}));
  await client.listTools();
  const original=spawn(exe,[`--data-dir=${data}`],{env:{...process.env,...env},windowsHide:true,stdio:'ignore'});original.on('error',()=>{});
  await waitFor(async()=>!!await read(path.join(data,'latest-status.json')));
  const dispatched=await exec(process.execPath,[self,'--dispatch',artifacts,root],{windowsHide:true,timeout:180000,maxBuffer:1024*1024});
  const operation=JSON.parse(dispatched.stdout.trim().split(/\r?\n/).at(-1));
  const result=await waitFor(async()=>{const r=await read(path.join(data,'updates/install-result.json'));return r?.operationId===operation.operationId?r:null;},240000);
  assert.equal(result.status,'success',JSON.stringify(result));
  assert.equal((await read(path.join(gateway,'release-receipt.json'))).version,manifest.version);
  assert.equal((await read(path.join(monitor,'release-receipt.json'))).version,manifest.version);
  assert.deepEqual(await read(path.join(monitor,'agent-monitor.config.json')),settings);
  assert.deepEqual(await read(path.join(gateway,'configuration/fixture.json')),{preserved:true});
  assert.deepEqual(await read(path.join(gateway,'state/fixture.json')),{preserved:true});
  await waitFor(async()=>{const pids=await monitorPids(exe);return Array.isArray(pids)?pids.length:pids;});
  const history=await read(path.join(data,'updates/history.json'));assert.ok(history.some(r=>r.operationId===operation.operationId&&r.status==='success'));
  success=true;console.log(JSON.stringify({passed:true,version:manifest.version,externalInstallerSurvivedLauncherExit:true,settingsPreserved:true,receipts:true,monitorRestarted:true,fixtureRoot:root}));
}finally{
  await client?.close().catch(()=>{});
  const pids=await monitorPids(exe).catch(()=>[]);
  if(Array.isArray(pids)?pids.length:pids){await exec(exe,['--quit',`--data-dir=${data}`],{windowsHide:true,timeout:10000}).catch(()=>{});await waitFor(async()=>{const current=await monitorPids(exe);return !(Array.isArray(current)?current.length:current);},15000).catch(()=>{});}
  // Keep failed fixtures for diagnosis. Never remove paths outside this generated root.
  if(success&&path.dirname(root)===os.tmpdir()&&/^agent-release-e2e-[A-Za-z0-9]+$/.test(path.basename(root)))await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:500});
  else if(!success)console.error('Fixture retained for diagnosis: '+root);
}
