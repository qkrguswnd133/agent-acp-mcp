import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createUpdater,validateSignedManifest,extractVerifiedZip,safeZipName}=require('../update/service.cjs');
const yazl=require('yazl');
const repository='qkrguswnd133/agent-acp-mcp';
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'agent-updater-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const keys=crypto.generateKeyPairSync('ed25519');const keyFile=path.join(root,'trusted-key.pem');await fs.writeFile(keyFile,keys.publicKey.export({type:'spki',format:'pem'}));return {root,keys,keyFile};}
function signedRelease(keys,version,archive=Buffer.from('zip fixture'),extra={}){
  const tag=`v${version}`,assetName=`Agent-ACP-MCP-Windows-${version}.zip`;
  const manifest={schemaVersion:1,repository,version,tag,publishedAt:'2026-09-29T00:00:00Z',components:{gateway:version,monitor:'1.1.0'},notes:{gateway:['Gateway change'],monitor:['Monitor change']},asset:{name:assetName,size:archive.length,sha256:digest(archive)},minimumUpdaterVersion:'1.0.0',...extra};
  const bytes=Buffer.from(JSON.stringify(manifest));const signature=Buffer.from(crypto.sign(null,bytes,keys.privateKey).toString('base64'));
  const base=`https://github.com/${repository}/releases/download/${tag}/`;
  const assets=[['update-manifest.json',bytes],['update-manifest.sig',signature],[assetName,archive]].map(([name,data])=>({name,size:data.length,browser_download_url:base+name}));
  return {manifest,bytes,signature,archive,release:{tag_name:tag,draft:false,prerelease:false,assets,target_commitish:'main'}};
}
function fetcherFor(items,calls){const responses=new Map();for(const item of items){for(const asset of item.release.assets){responses.set(asset.browser_download_url,asset.name==='update-manifest.json'?item.bytes:asset.name==='update-manifest.sig'?item.signature:item.archive);}}
  return async(url,options={})=>{calls.push({url,options});if(url.includes('/releases?'))return new Response(JSON.stringify(items.map(x=>x.release)),{headers:{'content-type':'application/json'}});const data=responses.get(url);if(!data)return new Response('missing',{status:404});const range=options.headers?.Range;if(range){const start=Number(range.match(/^bytes=(\d+)-$/)?.[1]);return new Response(data.subarray(start),{status:206,headers:{'content-range':`bytes ${start}-${data.length-1}/${data.length}`}});}return new Response(data);};}
test('signed release check rejects prereleases and forged data, and uses six-hour cache',async t=>{
  const {root,keys,keyFile}=await fixture(t),stable=signedRelease(keys,'2.2.0'),pre=signedRelease(keys,'2.3.0');pre.release.prerelease=true;
  const calls=[],fetcher=fetcherFor([pre,stable],calls),monitorDirectory=path.join(root,'monitor');await fs.mkdir(monitorDirectory);
  const updater=createUpdater({stateDir:root,monitorDirectory,appVersion:'1.1.0',keyFile,fetcher});await updater.load();
  await updater.check();assert.equal(updater.getState().selected.version,'2.2.0');assert.equal(updater.getState().history.length,1);
  const before=calls.length;await updater.check();assert.equal(calls.length,before);
  const mutated=Buffer.from(stable.bytes);mutated[10]^=1;assert.throws(()=>validateSignedManifest(mutated,stable.signature,keys.publicKey,stable.release),/서명/);
  const cache=JSON.parse(await fs.readFile(path.join(root,'updates','release-cache.json'),'utf8'));cache.releases[0].urls.archive='https://evil.example/test';await fs.writeFile(path.join(root,'updates','release-cache.json'),JSON.stringify(cache));
  const again=createUpdater({stateDir:root,monitorDirectory,appVersion:'1.1.0',keyFile,fetcher});await again.load();assert.equal(again.getState().selected.version,'2.2.0');await again.download();assert.equal(again.getState().downloaded,true);assert.equal(calls.at(-1).url,stable.release.assets.at(-1).browser_download_url);
});
test('missing trusted key blocks network and minimum updater version blocks install',async t=>{
  const {root,keys,keyFile}=await fixture(t),monitorDirectory=path.join(root,'monitor');await fs.mkdir(monitorDirectory);
  let calls=0;const absent=createUpdater({stateDir:root,monitorDirectory,appVersion:'1.1.0',keyFile:path.join(root,'missing.pem'),fetcher:async()=>{calls++;throw Error('should not fetch');}});await absent.load();await absent.check();assert.equal(calls,0);assert.match(absent.getState().blocked,/수동/);
  const release=signedRelease(keys,'2.2.0',Buffer.from('test'),{minimumUpdaterVersion:'1.0.5'});const updater=createUpdater({stateDir:root,monitorDirectory,appVersion:'1.1.0',keyFile,fetcher:fetcherFor([release],[])});await updater.load();await updater.check();assert.match(updater.getState().blocked,/수동/);assert.equal((await updater.install()).started,false);
});
test('GitHub 403 reset persists cooldown across restart and manual checks',async t=>{
  const {root,keyFile}=await fixture(t),monitorDirectory=path.join(root,'monitor');await fs.mkdir(monitorDirectory);
  let time=Date.now(),calls=0;const fetcher=async()=>{calls++;return calls===1?new Response('',{status:403,headers:{'x-ratelimit-remaining':'0','x-ratelimit-reset':String(Math.floor((Date.now()+60000)/1000))}}):new Response('[]');};
  const options={stateDir:root,monitorDirectory,appVersion:'1.1.0',keyFile,fetcher,clock:()=>time};const updater=createUpdater(options);await updater.load();await updater.check(true);const retryAt=updater.getState().retryAt;assert.ok(Date.parse(retryAt)>time);assert.match(updater.getState().error,/이후/);await updater.check(true);assert.equal(calls,1);
  const reopened=createUpdater(options);await reopened.load();assert.equal(reopened.getState().retryAt,retryAt);await reopened.check(true);assert.equal(calls,1);
  time=Date.parse(retryAt)+1;await reopened.check(true);assert.equal(calls,2);assert.equal(reopened.getState().retryAt,null);
});
test('GitHub 429 Retry-After takes precedence and bounds manual retry cooldown',async t=>{
  const {root,keyFile}=await fixture(t),monitorDirectory=path.join(root,'monitor');await fs.mkdir(monitorDirectory);
  const started=Date.now();let calls=0;const updater=createUpdater({stateDir:root,monitorDirectory,appVersion:'1.1.0',keyFile,clock:()=>started,fetcher:async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'120','x-ratelimit-reset':String(Math.floor((started+3600000)/1000))}});}});
  await updater.load();await updater.check(true);const retryAt=Date.parse(updater.getState().retryAt);assert.ok(retryAt>=started+119000&&retryAt<=started+121000);await updater.check(true);assert.equal(calls,1);
});
test('download resumes partial data and verifies SHA-256 before exposing install',async t=>{
  const {root,keys,keyFile}=await fixture(t),monitorDirectory=path.join(root,'monitor');await fs.mkdir(monitorDirectory);
  const archive=crypto.randomBytes(32000),release=signedRelease(keys,'2.2.0',archive),calls=[],updater=createUpdater({stateDir:root,monitorDirectory,appVersion:'1.1.0',keyFile,fetcher:fetcherFor([release],calls)});
  await updater.load();await updater.check();const part=path.join(root,'updates',`${release.manifest.asset.name}.part`);await fs.writeFile(part,archive.subarray(0,10000));await updater.download();assert.equal(updater.getState().downloaded,true);assert.equal((await fs.readFile(path.join(root,'updates',release.manifest.asset.name))).length,archive.length);assert.equal(calls.some(x=>x.options.headers?.Range==='bytes=10000-'),true);
});
test('corrupt complete download is removed and retry starts without a Range request',async t=>{
  const {root,keys,keyFile}=await fixture(t),monitorDirectory=path.join(root,'monitor');await fs.mkdir(monitorDirectory);
  const archive=crypto.randomBytes(10000),release=signedRelease(keys,'2.2.0',archive),calls=[],base=fetcherFor([release],calls),assetUrl=release.release.assets.at(-1).browser_download_url;
  let archiveCalls=0;const fetcher=async(url,options)=>{if(url===assetUrl&&archiveCalls++===0)return new Response(Buffer.alloc(archive.length,7));return base(url,options);};
  const updater=createUpdater({stateDir:root,monitorDirectory,appVersion:'1.1.0',keyFile,fetcher});await updater.load();await updater.check();await updater.download();assert.equal(updater.getState().downloaded,false);
  const part=path.join(root,'updates',`${release.manifest.asset.name}.part`);assert.equal(await fs.stat(part).then(()=>true).catch(()=>false),false);
  await updater.download();assert.equal(updater.getState().downloaded,true);assert.equal(archiveCalls,2);
  const final=await fs.readFile(path.join(root,'updates',release.manifest.asset.name));assert.deepEqual(final,archive);
});
test('stale partial rejected with 416 retries once from byte zero',async t=>{
  const {root,keys,keyFile}=await fixture(t),monitorDirectory=path.join(root,'monitor');await fs.mkdir(monitorDirectory);
  const archive=crypto.randomBytes(10000),release=signedRelease(keys,'2.2.0',archive),calls=[],base=fetcherFor([release],calls),assetUrl=release.release.assets.at(-1).browser_download_url;
  let archiveCalls=0;const fetcher=async(url,options)=>{if(url===assetUrl&&archiveCalls++===0)return new Response('range stale',{status:416});return base(url,options);};
  const updater=createUpdater({stateDir:root,monitorDirectory,appVersion:'1.1.0',keyFile,fetcher});await updater.load();await updater.check();const part=path.join(root,'updates',`${release.manifest.asset.name}.part`);await fs.writeFile(part,archive.subarray(0,5000));
  await updater.download();assert.equal(updater.getState().downloaded,true);assert.equal(archiveCalls,2);assert.equal(calls.at(-1).options.headers?.Range,undefined);
});
test('cancelling download leaves installer unlaunched',async t=>{
  const {root,keys,keyFile}=await fixture(t),monitorDirectory=path.join(root,'monitor');await fs.mkdir(monitorDirectory);
  const archive=crypto.randomBytes(10000),release=signedRelease(keys,'2.2.0',archive),assetUrl=release.release.assets.at(-1).browser_download_url,base=fetcherFor([release],[]);let launches=0;
  const fetcher=(url,options)=>url===assetUrl?new Promise((_,reject)=>{if(options.signal.aborted)return reject(Object.assign(Error('cancelled'),{name:'AbortError'}));options.signal.addEventListener('abort',()=>reject(Object.assign(Error('cancelled'),{name:'AbortError'})),{once:true});}):base(url,options);
  const updater=createUpdater({stateDir:root,monitorDirectory,appVersion:'1.1.0',keyFile,fetcher,launch:async()=>{launches++;return 12345;}});await updater.load();await updater.check();const downloading=updater.download();updater.cancel();await downloading;
  assert.equal(updater.getState().downloaded,false);assert.equal((await updater.install()).started,false);assert.equal(launches,0);
});
function zipBuffer(files){return new Promise((resolve,reject)=>{const zip=new yazl.ZipFile(),chunks=[];for(const [name,data] of Object.entries(files))zip.addBuffer(Buffer.from(data),name);zip.outputStream.on('data',chunk=>chunks.push(chunk));zip.outputStream.on('end',()=>resolve(Buffer.concat(chunks)));zip.outputStream.on('error',reject);zip.end();});}
test('ZIP extraction requires exact internal hashes and rejects traversal names',async t=>{
  const {root}=await fixture(t),run=Buffer.from('runner'),update=Buffer.from('update'),gateway=Buffer.from('gateway'),monitor=Buffer.from('monitor');
  const files={'Run-Update.ps1':run,'Update.ps1':update,'gateway/file.txt':gateway,'monitor/file.txt':monitor,'release-info.json':JSON.stringify({schemaVersion:1,version:'2.2.0',components:{gateway:'2.2.0',monitor:'1.1.0'}})};const internal={platform:'win32-x64',gatewayVersion:'2.2.0',monitorVersion:'1.1.0',files:Object.entries(files).map(([name,data])=>({path:name,sha256:digest(data),size:data.length??Buffer.byteLength(data)}))};
  const zip=await zipBuffer({...files,'manifest.json':JSON.stringify(internal)}),file=path.join(root,'package.zip');await fs.writeFile(file,zip);await extractVerifiedZip(file,path.join(root,'stage'),{version:'2.2.0',components:{gateway:'2.2.0',monitor:'1.1.0'}});assert.equal((await fs.readFile(path.join(root,'stage','gateway','file.txt'))).toString(),'gateway');
  internal.files[0].sha256='0'.repeat(64);const invalid=await zipBuffer({...files,'manifest.json':JSON.stringify(internal)});await fs.writeFile(file,invalid);await assert.rejects(extractVerifiedZip(file,path.join(root,'bad'),{version:'2.2.0',components:{gateway:'2.2.0',monitor:'1.1.0'}}),/검증 실패/);
  assert.equal(safeZipName('../escape'),false);assert.equal(safeZipName('folder/CON.txt'),false);assert.equal(safeZipName('folder\\file'),false);
});
test('install handoff persists one pending operation and accepts matching blocked result',async t=>{
  const {root,keys,keyFile}=await fixture(t),monitorDirectory=path.join(root,'monitor');await fs.mkdir(monitorDirectory);
  const files={'Run-Update.ps1':'runner','Update.ps1':'update','gateway/file.txt':'gateway','monitor/file.txt':'monitor','release-info.json':JSON.stringify({schemaVersion:1,version:'2.2.0',components:{gateway:'2.2.0',monitor:'1.1.0'}})};
  const internal={platform:'win32-x64',gatewayVersion:'2.2.0',monitorVersion:'1.1.0',files:Object.entries(files).map(([name,data])=>({path:name,sha256:digest(data),size:Buffer.byteLength(data)}))};
  const archive=await zipBuffer({...files,'manifest.json':JSON.stringify(internal)}),release=signedRelease(keys,'2.2.0',archive);
  let time=Date.now();const launches=[],options={stateDir:root,monitorDirectory,appVersion:'1.1.0',keyFile,fetcher:fetcherFor([release],[]),nodeFinder:async()=>process.execPath,helperAlive:()=>false,clock:()=>time,launch:async(runner,request)=>{launches.push({runner,request});return 12345;}};
  const updater=createUpdater(options);await updater.load();await updater.check();await updater.download();assert.equal((await updater.install()).started,true);assert.equal(launches.length,1);assert.equal((await updater.install()).started,false);
  const request=JSON.parse(await fs.readFile(launches[0].request,'utf8'));assert.equal(request.schemaVersion,1);assert.equal(request.nodeExecutable,process.execPath);assert.equal(request.monitorDirectory,monitorDirectory);assert.equal(request.gatewayDirectory,undefined);assert.equal(request.userDataDir,root);
  const reopened=createUpdater(options);await reopened.load();assert.equal(reopened.getState().phase,'installing');assert.equal((await reopened.install()).started,false);
  const blockedResult={schemaVersion:1,operationId:request.operationId,status:'blocked',version:'2.2.0',startedAt:'2026-09-29T00:00:00Z',finishedAt:'2026-09-29T00:01:00Z',message:'gateway busy',backups:[]};await fs.writeFile(request.resultFile,JSON.stringify(blockedResult));await fs.writeFile(path.join(root,'updates','history.json'),JSON.stringify([blockedResult]));
  await reopened.pollResult();assert.equal(reopened.getState().phase,'idle');assert.equal(reopened.getState().result.status,'blocked');assert.equal(reopened.getState().localHistory.length,1);
  await updater.pollResult();assert.equal((await updater.install()).started,true);time+=11001;await updater.pollResult();assert.equal(updater.getState().pending,null);assert.match(updater.getState().blocked,/결과를 남기지/);
});
test('hash failure and cancellation during preparation never launch installer; verified retry does',async t=>{
  const {root,keys,keyFile}=await fixture(t),monitorDirectory=path.join(root,'monitor');await fs.mkdir(monitorDirectory);
  const files={'Run-Update.ps1':'runner','Update.ps1':'update','gateway/file.txt':'gateway','monitor/file.txt':'monitor','release-info.json':JSON.stringify({schemaVersion:1,version:'2.2.0',components:{gateway:'2.2.0',monitor:'1.1.0'}})};
  const internal={platform:'win32-x64',gatewayVersion:'2.2.0',monitorVersion:'1.1.0',files:Object.entries(files).map(([name,data])=>({path:name,sha256:digest(data),size:Buffer.byteLength(data)}))};
  const archive=await zipBuffer({...files,'manifest.json':JSON.stringify(internal)}),release=signedRelease(keys,'2.2.0',archive),launches=[];
  const updater=createUpdater({stateDir:root,monitorDirectory,appVersion:'1.1.0',keyFile,fetcher:fetcherFor([release],[]),nodeFinder:async()=>process.execPath,launch:async()=>{launches.push(true);const pending=path.join(root,'updates','pending-install.json');await fs.rename(pending,`${pending}.saved`);await fs.mkdir(pending);return 12345;}});
  await updater.load();await updater.check();await updater.download();const final=path.join(root,'updates',release.manifest.asset.name);
  await fs.writeFile(final,Buffer.alloc(archive.length,7));assert.equal((await updater.install()).started,false);assert.equal(launches.length,0);assert.equal(updater.getState().downloaded,false);
  await updater.download();assert.equal(updater.getState().downloaded,true);
  updater.cancel();assert.equal((await updater.install()).started,false);assert.equal(launches.length,0);
  await updater.download();assert.equal(updater.getState().downloaded,true);
  const preparing=updater.install();assert.equal(updater.getState().phase,'preparing');updater.cancel();assert.equal((await preparing).started,false);assert.equal(launches.length,0);assert.match(updater.getState().error,/취소/);
  await updater.download();assert.equal((await updater.install()).started,true);assert.equal(launches.length,1);assert.equal(updater.getState().phase,'installing');
});
test('unfinished rollback blocks automatic download and install across restart',async t=>{
  const {root,keys,keyFile}=await fixture(t),monitorDirectory=path.join(root,'monitor');await fs.mkdir(monitorDirectory);
  const release=signedRelease(keys,'2.2.0',crypto.randomBytes(1024)),calls=[],launches=[];
  const options={stateDir:root,monitorDirectory,appVersion:'1.1.0',keyFile,fetcher:fetcherFor([release],calls),launch:async()=>{launches.push(true);return 12345;}};
  const updater=createUpdater(options);await updater.load();await updater.check();await updater.download();assert.equal(updater.getState().downloaded,true);
  await fs.writeFile(path.join(root,'updates','install-result.json'),JSON.stringify({schemaVersion:1,operationId:'11111111-1111-1111-1111-111111111111',status:'rollback_failed',version:'2.2.0',message:'Manual recovery required.',backups:[]}));await updater.pollResult();
  assert.equal((await updater.install()).started,false);assert.equal(launches.length,0);
  const restarted=createUpdater(options);await restarted.load();await restarted.check(true);const before=calls.length;await restarted.download();assert.equal(calls.length,before);assert.equal(restarted.getState().downloaded,false);assert.equal((await restarted.install()).started,false);
});
