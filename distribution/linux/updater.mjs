#!/usr/bin/env node
/** Linux/WSL share this updater. No provider CLI, credentials or host settings are changed. */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const UPDATER_VERSION='1.0.0';
export const REPOSITORY='qkrguswnd133/agent-acp-mcp';
const SELF=path.dirname(fileURLToPath(import.meta.url));
const MAX_ARCHIVE=512*1024*1024,MAX_EXPANDED=1024*1024*1024,MAX_FILES=30000;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const exists=async p=>{try{await fs.lstat(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const readJson=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const now=()=>new Date().toISOString();
export function compareVersions(a,b){
  if(!/^\d+\.\d+\.\d+$/.test(a)||!/^\d+\.\d+\.\d+$/.test(b))throw Error('Invalid stable version');
  const aa=a.split('.').map(Number),bb=b.split('.').map(Number);
  for(let i=0;i<3;i++)if(aa[i]!==bb[i])return aa[i]>bb[i]?1:-1;
  return 0;
}
export function defaultPaths(env=process.env,home=os.homedir()){
  const data=env.XDG_DATA_HOME||path.join(home,'.local','share');
  const state=env.AGENT_MCP_STATE_DIR||path.join(env.XDG_STATE_HOME||path.join(home,'.local','state'),'agent-acp-mcp');
  if(!path.isAbsolute(data)||!path.isAbsolute(state))throw Error('XDG and state paths must be absolute');
  return {installRoot:path.join(data,'agent-acp-mcp'),stateRoot:state,launcher:path.join(home,'.local','bin','agent-acp')};
}
export function safeRelative(name){
  if(typeof name!=='string'||!name||name.includes('\\')||name.includes(':')||name.includes('\0')||name.startsWith('/')||name.split('/').some(x=>!x||x==='.'||x==='..')||/[\x00-\x1f\x7f]/.test(name))throw Error(`Unsafe archive path: ${name}`);
  return name;
}
function octal(bytes){const value=bytes.toString('ascii').replace(/\0.*$/s,'').trim();if(value&&!/^[0-7]+$/.test(value))throw Error('Unsupported tar numeric field');return value?parseInt(value,8):0;}
/** Complete validation happens in memory before any archive path is written. */
export function parseArchive(compressed){
  if(compressed.length>MAX_ARCHIVE)throw Error('Archive too large');
  const bytes=zlib.gunzipSync(compressed,{maxOutputLength:MAX_EXPANDED});
  const entries=[],seen=new Set();let offset=0,ended=false;
  while(offset+512<=bytes.length){
    const head=bytes.subarray(offset,offset+512);offset+=512;
    if(head.every(n=>n===0)){ended=true;if(bytes.subarray(offset).some(n=>n!==0))throw Error('Data after tar terminator');break;}
    const checksum=octal(head.subarray(148,156));let sum=0;for(let i=0;i<512;i++)sum+=i>=148&&i<156?32:head[i];if(sum!==checksum)throw Error('Tar checksum mismatch');
    const str=(a,b)=>head.subarray(a,b).toString('utf8').replace(/\0.*$/s,'');
    if(str(257,263)!=='ustar')throw Error('Only ustar archives are supported');
    let name=[str(345,500),str(0,100)].filter(Boolean).join('/');
    const type=String.fromCharCode(head[156]||48),directory=type==='5';
    if(directory)name=name.replace(/\/$/,'');safeRelative(name);
    if(!['0','5'].includes(type))throw Error(`Archive links or special records are forbidden: ${name}`);
    if(seen.has(name))throw Error(`Duplicate archive path: ${name}`);seen.add(name);
    const size=octal(head.subarray(124,136));if(!Number.isSafeInteger(size)||size<0||offset+size>bytes.length||(directory&&size))throw Error('Invalid tar size');
    entries.push({name,directory,mode:octal(head.subarray(100,108))&0o777,bytes:bytes.subarray(offset,offset+size)});
    if(entries.length>MAX_FILES)throw Error('Too many archive entries');offset+=Math.ceil(size/512)*512;
  }
  if(!ended)throw Error('Truncated tar archive');
  const files=new Set(entries.filter(e=>!e.directory).map(e=>e.name));
  for(const e of entries){let parent=path.posix.dirname(e.name);while(parent!=='.'){if(files.has(parent))throw Error('Archive file/directory collision');parent=path.posix.dirname(parent);}}
  return entries;
}
export function verifyManifest(bytes,signature,key,architecture=process.arch){
  if(!crypto.verify(null,bytes,key,Buffer.from(String(signature).trim(),'base64')))throw Error('Manifest signature verification failed');
  const value=JSON.parse(bytes);
  if(value.schemaVersion!==1||value.platform!=='linux'||value.repository!==REPOSITORY||!Array.isArray(value.architectures)||!value.architectures.includes(architecture))throw Error('Unsupported Linux manifest');
  compareVersions(value.version,'0.0.0');compareVersions(value.components?.gateway,'0.0.0');
  if(value.tag!==`v${value.version}`||!Number.isFinite(Date.parse(value.publishedAt)))throw Error('Invalid release identity');
  if(compareVersions(value.minimumUpdaterVersion,UPDATER_VERSION)>0)throw Error(`Manual update required: updater ${value.minimumUpdaterVersion} or newer`);
  const asset=value.asset;
  if(!asset||asset.name!==`Agent-ACP-MCP-Linux-${value.version}.tar.gz`||!Number.isSafeInteger(asset.size)||asset.size<1||asset.size>MAX_ARCHIVE||!/^[a-f0-9]{64}$/.test(asset.sha256))throw Error('Invalid Linux release asset');
  return value;
}
export function verifyPackage(entries,manifest){
  const meta=entries.find(e=>e.name==='package-manifest.json'&&!e.directory);if(!meta)throw Error('Missing package manifest');
  const p=JSON.parse(meta.bytes);
  if(p.schemaVersion!==1||p.platform!=='linux'||p.version!==manifest.version||p.components?.gateway!==manifest.components.gateway||!Array.isArray(p.files))throw Error('Package/outer manifest mismatch');
  const actual=new Map(entries.filter(e=>!e.directory&&e.name!=='package-manifest.json').map(e=>[e.name,e]));const listed=new Set();
  for(const file of p.files){safeRelative(file.path);if(listed.has(file.path))throw Error('Duplicate package manifest entry');listed.add(file.path);const e=actual.get(file.path);if(!e||e.bytes.length!==file.size||sha(e.bytes)!==file.sha256)throw Error(`Package checksum mismatch: ${file.path}`);}
  if(actual.size!==listed.size)throw Error('Unlisted package files');
  for(const required of ['gateway/dist/src/index.js','gateway/package.json','linux/updater.mjs','linux/agent-acp','linux/trusted-key.pem'])if(!actual.has(required))throw Error(`Missing package file: ${required}`);
  const gatewayPackage=JSON.parse(actual.get('gateway/package.json').bytes);
  if(gatewayPackage.version!==manifest.components.gateway||!/^agent-acp-mcp(?:-local)?$/.test(gatewayPackage.name||''))throw Error('Gateway package identity/version mismatch');
  for(const name of actual.keys())if(!name.startsWith('gateway/')&&!name.startsWith('linux/'))throw Error(`Unexpected package root: ${name}`);
  for(const name of actual.keys())if(name.startsWith('gateway/state/')||name.startsWith('gateway/runtime/')||name.startsWith('gateway/linux/'))throw Error(`Runtime data must not be shipped: ${name}`);
  return p;
}
export async function ensureSafePath(target){
  const resolved=path.resolve(target);if(!path.isAbsolute(target)||resolved===path.parse(resolved).root)throw Error('Unsafe installation path');
  let cursor=path.parse(resolved).root;
  for(const part of resolved.slice(cursor.length).split(path.sep).filter(Boolean)){cursor=path.join(cursor,part);try{const stat=await fs.lstat(cursor);if(stat.isSymbolicLink())throw Error(`Path traverses a symlink: ${cursor}`);}catch(e){if(e.code!=='ENOENT')throw e;}}
  return resolved;
}
async function atomicJson(file,value){await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});const tmp=file+'.'+crypto.randomUUID()+'.tmp';await fs.writeFile(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});await fs.rename(tmp,file);}
export async function linuxIdentity(pid,procRoot='/proc'){
  const [stat,boot,status]=await Promise.all([fs.readFile(path.join(procRoot,String(pid),'stat'),'utf8'),fs.readFile(path.join(procRoot,'sys/kernel/random/boot_id'),'utf8'),fs.readFile(path.join(procRoot,String(pid),'status'),'utf8')]);
  const tail=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/);const start=tail[19],uid=/^Uid:\s+(\d+)/m.exec(status)?.[1];
  if(!/^\d+$/.test(start||'')||!uid)throw Error('Cannot verify Linux process identity');return `linux:${boot.trim()}:${start}:${uid}`;
}
export async function scanProcesses(root,stateRoot){
  const found=[];const entry=path.join(root,'dist/src/index.js');
  for(const dir of await fs.readdir('/proc')){
    if(!/^\d+$/.test(dir)||Number(dir)===process.pid)continue;
    try{
      const base=path.join('/proc',dir),stat=await fs.stat(base);if(stat.uid!==process.getuid())continue;
      const args=(await fs.readFile(path.join(base,'cmdline'),'utf8')).split('\0').filter(Boolean);
      if(!args.some(a=>a.endsWith('index.js')))continue;
      const cwd=await fs.readlink(path.join(base,'cwd'));
      if(args.some(a=>path.resolve(cwd,a)===entry)){found.push({pid:Number(dir),identity:await linuxIdentity(Number(dir))});}
    }catch(e){if(!['ENOENT','ESRCH'].includes(e.code))throw Error(`Cannot inspect process ${dir}; disconnect MCP before updating`);}
  }
  if(stateRoot){const registry=path.join(stateRoot,'gateways');let files=[];try{files=await fs.readdir(registry);}catch(e){if(e.code!=='ENOENT')throw e;}for(const name of files){if(!/^\d+\.json$/.test(name))continue;const record=await readJson(path.join(registry,name));if(record.installRoot!==root)continue;let actual;try{actual=await linuxIdentity(record.pid);}catch(e){if(['ENOENT','ESRCH'].includes(e.code))continue;throw e;}if(actual!==record.startIdentity)continue;if(!found.some(p=>p.pid===record.pid))found.push({pid:record.pid,identity:actual});}}
  return found;
}
export async function acquireLock(stateRoot){
  const lock=path.join(stateRoot,'update.lock');await fs.mkdir(stateRoot,{recursive:true,mode:0o700});await ensureSafePath(lock);
  const identity=await linuxIdentity(process.pid);
  const value={pid:process.pid,identity,createdAt:now()};
  try{await fs.writeFile(lock,JSON.stringify(value),{flag:'wx',mode:0o600});}
  catch(e){if(e.code!=='EEXIST')throw e;let old;try{old=await readJson(lock);}catch{throw Error('Update lock is unreadable; inspect it before retrying');}let alive=false;try{alive=await linuxIdentity(old.pid)===old.identity;}catch{}if(alive)throw Error('Another update is already running');throw Error(`Stale update lock requires inspection before removal: ${lock}`);}
  return async()=>{try{const current=await readJson(lock);if(current.pid===process.pid&&current.identity===identity)await fs.unlink(lock);}catch{}};
}
async function maintenance(root,emit,stateRoot){
  const file=root+'.maintenance.json';await ensureSafePath(file);
  const before=await scanProcesses(root,stateRoot),operationId=crypto.randomUUID();
  if(await exists(file)){const old=await readJson(file);if(Date.parse(old.expiresAt)>Date.now())throw Error('Gateway has an active maintenance request');}
  const request={schemaVersion:1,platform:'linux',operationId,ownerPid:process.pid,ownerStartedAt:await linuxIdentity(process.pid),requestedAt:now(),expiresAt:new Date(Date.now()+30*60_000).toISOString(),phase:'prepare'};
  await atomicJson(file,request);
  const release=async()=>{try{const current=await readJson(file);if(current.operationId===operationId)await fs.unlink(file);}catch{}for(const p of before)await fs.rm(`${root}.maintenance.${operationId}.${p.pid}.ack.json`,{force:true}).catch(()=>{});};
  try{
    emit('preparing',null,'Checking Gateway idle state');
    const deadline=Date.now()+5000;
    for(;;){
      const active=await scanProcesses(root,stateRoot);if(active.some(p=>!before.some(b=>b.pid===p.pid&&b.identity===p.identity)))throw Error('Gateway restarted during update; disconnect MCP and retry');
      let ready=true;
      for(const p of active){let ack;try{ack=await readJson(`${root}.maintenance.${operationId}.${p.pid}.ack.json`);}catch{}if(ack?.operationId!==operationId||ack.gatewayPid!==p.pid||ack.gatewayStartedAt!==p.identity)ready=false;}
      if(ready)break;if(Date.now()>deadline)throw Error('Gateway is busy or does not support safe maintenance; finish jobs and disconnect MCP');await sleep(100);
    }
    await atomicJson(file,{...request,phase:'commit'});
    const end=Date.now()+10000;while((await scanProcesses(root,stateRoot)).length){if(Date.now()>end)throw Error('Gateway did not exit safely; disconnect MCP and retry');await sleep(100);}
    return {release,assertIdle:async()=>{if((await scanProcesses(root,stateRoot)).length)throw Error('Gateway restarted during update; disconnect MCP and retry');}};
  }catch(e){await release();throw e;}
}
/** Copy legacy state to staging first. Existing unequal files abort without overwriting. */
export async function mergeState(source,target){
  return mergeStates([source],target);
}
export async function mergeStates(sources,target){
  await ensureSafePath(target);const actions=[],planned=new Map(),plannedDirectories=new Set();
  async function plan(from,to,rel=''){
    for(const item of await fs.readdir(from,{withFileTypes:true})){const a=path.join(from,item.name),b=path.join(to,item.name),name=rel?rel+'/'+item.name:item.name;const s=await fs.lstat(a);if(s.isSymbolicLink()||(!s.isFile()&&!s.isDirectory()))throw Error(`Unsafe legacy state file: ${name}`);await ensureSafePath(b);
      if(s.isDirectory()){if(planned.has(b)||(await exists(b)&&!(await fs.stat(b)).isDirectory()))throw Error(`State migration collision: ${name}`);plannedDirectories.add(b);await plan(a,b,name);}
      else if(plannedDirectories.has(b))throw Error(`State migration collision: ${name}`);
      else if(await exists(b)){if(!(await fs.stat(b)).isFile()||sha(await fs.readFile(a))!==sha(await fs.readFile(b)))throw Error(`State migration collision: ${name}`);}
      else if(planned.has(b)){if(planned.get(b)!==sha(await fs.readFile(a)))throw Error(`State migration collision between legacy sources: ${name}`);}
      else {planned.set(b,sha(await fs.readFile(a)));actions.push({from:a,to:b,name});}
    }
  }
  for(const source of sources){if(await exists(source)){await ensureSafePath(source);await plan(source,target);}}
  for(const a of actions){await fs.mkdir(path.dirname(a.to),{recursive:true,mode:0o700});await fs.copyFile(a.from,a.to,fsSync.constants.COPYFILE_EXCL);}
  return actions.map(a=>a.name);
}
export async function requestBytes(url,limit,signal,onProgress){
  signal=AbortSignal.any([signal||new AbortController().signal,AbortSignal.timeout(limit>2*1024*1024?10*60_000:45_000)]);
  let current=new URL(url);
  for(let redirects=0;redirects<6;redirects++){
    if(current.protocol!=='https:'||!['api.github.com','github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(current.hostname)||current.username||current.password)throw Error('Untrusted download URL');
    const res=await fetch(current,{headers:{'User-Agent':'agent-acp-linux-updater/'+UPDATER_VERSION,'Accept':'application/vnd.github+json'},signal,redirect:'manual'});
    if([301,302,303,307,308].includes(res.status)){current=new URL(res.headers.get('location'),current);continue;}
    if(!res.ok){let retryAfter=null;const ra=res.headers.get('retry-after'),reset=res.headers.get('x-ratelimit-reset');if(ra)retryAfter=/^\d+$/.test(ra)?new Date(Date.now()+Number(ra)*1000).toISOString():new Date(ra).toISOString();else if(reset&&/^\d+$/.test(reset))retryAfter=new Date(Number(reset)*1000).toISOString();const e=Error(`GitHub request failed (${res.status})`);e.retryAfter=retryAfter;throw e;}
    if(Number(res.headers.get('content-length'))>limit)throw Error('Download exceeds size limit');const chunks=[];let total=0,lastProgress=0;for await(const chunk of res.body){total+=chunk.length;if(total>limit)throw Error('Download exceeds size limit');chunks.push(Buffer.from(chunk));if(Date.now()-lastProgress>300){onProgress?.(total,limit);lastProgress=Date.now();}}return Buffer.concat(chunks);
  }
  throw Error('Too many download redirects');
}
export async function latestRelease(paths,key,signal){
  const cacheFile=path.join(paths.stateRoot,'updates','github-linux-cache.json');let cache;try{cache=await readJson(cacheFile);}catch{}
  if(cache?.retryAfter&&Date.parse(cache.retryAfter)>Date.now()){const e=Error(`GitHub retry required after ${cache.retryAfter}`);e.retryAfter=cache.retryAfter;throw e;}
  if(cache?.checkedAt&&Date.now()-Date.parse(cache.checkedAt)<15*60_000){const raw=Buffer.from(cache.manifest,'base64');return {manifest:verifyManifest(raw,cache.signature,key),manifestBytes:raw,signature:cache.signature,assetUrl:cache.assetUrl};}
  try{
    const release=JSON.parse(await requestBytes(`https://api.github.com/repos/${REPOSITORY}/releases/latest`,2*1024*1024,signal));
    if(release.draft||release.prerelease||!/^v\d+\.\d+\.\d+$/.test(release.tag_name))throw Error('No stable Linux release');
    const assets=release.assets||[],get=name=>{const a=assets.find(a=>a.name===name);if(!a?.browser_download_url)throw Error(`Release asset is unavailable: ${name}`);const expected=`https://github.com/${REPOSITORY}/releases/download/${release.tag_name}/${name}`;if(a.browser_download_url!==expected)throw Error('Unexpected release asset URL');return expected;};
    const [raw,sig]=await Promise.all([requestBytes(get('linux-update-manifest.json'),1024*1024,signal),requestBytes(get('linux-update-manifest.sig'),16384,signal)]);
    const signature=sig.toString('utf8'),manifest=verifyManifest(raw,signature,key);if(manifest.tag!==release.tag_name)throw Error('Release tag mismatch');const assetUrl=get(manifest.asset.name);
    await atomicJson(cacheFile,{checkedAt:now(),manifest:raw.toString('base64'),signature,assetUrl});return {manifest,manifestBytes:raw,signature,assetUrl};
  }catch(e){if(e.retryAfter)await atomicJson(cacheFile,{...cache,retryAfter:e.retryAfter});throw e;}
}
async function extract(entries,target){await fs.mkdir(target,{recursive:false,mode:0o700});for(const e of entries){const file=path.join(target,...e.name.split('/'));if(e.directory)await fs.mkdir(file,{recursive:true,mode:0o755});else{await fs.mkdir(path.dirname(file),{recursive:true,mode:0o755});await fs.writeFile(file,e.bytes,{flag:'wx',mode:e.mode&0o111?0o755:0o644});}}}
async function copyTree(source,target){await fs.cp(source,target,{recursive:true,errorOnExist:true,force:false,verbatimSymlinks:false});}
export function launcherText(node,updater){const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";return '#!/bin/sh\nexec '+quote(node)+' '+quote(updater)+' "$@"\n';}
async function receipt(paths){try{return await readJson(path.join(paths.stateRoot,'installations','gateway.json'));}catch(e){if(e.code!=='ENOENT')throw e;return null;}}
async function history(paths,entry){const file=path.join(paths.stateRoot,'updates','history.jsonl');await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});await fs.appendFile(file,JSON.stringify({...entry,at:now()})+'\n',{mode:0o600});}
async function componentVersion(root){try{return (await readJson(path.join(root,'package.json'))).version;}catch{return null;}}
export async function assertNoUnfinishedTransaction(stateRoot){
  const directory=path.join(stateRoot,'updates','transactions');await ensureSafePath(directory);let names=[];
  try{names=await fs.readdir(directory);}catch(e){if(e.code==='ENOENT')return;throw e;}
  for(const name of names){if(!name.endsWith('.json'))continue;const file=path.join(directory,name);await ensureSafePath(file);let record;try{record=await readJson(file);}catch{throw Error(`Unreadable update transaction requires manual recovery: ${file}`);}
    const finished=['installed','rolled_back'].includes(record.status)||(record.status==='failed'&&['restored','not_needed'].includes(record.recovery));
    if(!finished)throw Error(`Unfinished update transaction requires manual recovery before another update: ${file}; backup: ${record.backup||'none'}`);
  }
}
export async function installVerified(paths,entries,manifest,emit=()=>{},options={}){
  const root=await ensureSafePath(paths.installRoot),state=await ensureSafePath(paths.stateRoot);await ensureSafePath(paths.launcher);
  if(state===root||state.startsWith(root+path.sep))throw Error('State must be outside the installation');
  await assertNoUnfinishedTransaction(state);
  const old=await receipt(paths),installed=await exists(root);
  if(installed){let known;try{known=await readJson(path.join(root,'package.json'));}catch{}if(!/^agent-acp-mcp(?:-local)?$/.test(known?.name||'')||!await exists(path.join(root,'dist/src/index.js')))throw Error('Target contains an unknown installation');}
  const id=crypto.randomUUID(),stage=root+'.staging-'+id,backup=root+'.backup-'+id,unpack=root+'.unpack-'+id;
  const journal=path.join(state,'updates','transactions',id+'.json');
  // Capture the launcher before any install mutation. Only restore it if we actually changed it.
  let launcherBackup=null,launcherMode=0o755;const hadLauncher=await exists(paths.launcher);
  if(hadLauncher){const stat=await fs.stat(paths.launcher);if(!stat.isFile())throw Error('Launcher path is not a regular file');launcherBackup=await fs.readFile(paths.launcher);launcherMode=stat.mode&0o777;}
  await fs.mkdir(path.dirname(root),{recursive:true,mode:0o700});let gate,replaced=false,oldMoved=false,launcherModified=false;
  try{
    await extract(entries,unpack);await fs.rename(path.join(unpack,'gateway'),stage);await copyTree(path.join(unpack,'linux'),path.join(stage,'linux'));
    await atomicJson(path.join(stage,'agent-acp-installation.json'),{schemaVersion:1,stateRoot:state});
    gate=await maintenance(root,emit,state);await gate.assertIdle();
    const quotaRoot=options.legacyStateRoot===false?null:(options.legacyStateRoot||path.join(os.homedir(),'.agent-acp-mcp'));
    const legacySources=installed?[path.join(root,'state')]:[];
    if(quotaRoot&&quotaRoot!==state&&!state.startsWith(quotaRoot+path.sep))legacySources.push(quotaRoot);
    const migrated=await mergeStates(legacySources,state);
    emit('installing',75,'Replacing Gateway');options.onCommit?.();
    await atomicJson(journal,{schemaVersion:1,id,status:'replacing',installRoot:root,backup:installed?backup:null,stage,previousReceipt:old,version:manifest.version,startedAt:now()});
    if(installed){await fs.rename(root,backup);oldMoved=true;}
    await fs.rename(stage,root);replaced=true;await gate.assertIdle();
    await fs.mkdir(path.dirname(paths.launcher),{recursive:true,mode:0o755});
    const launcher=launcherText(process.execPath,path.join(root,'linux/updater.mjs'));
    launcherModified=true;await fs.writeFile(paths.launcher,launcher,{mode:0o755});await fs.chmod(paths.launcher,0o755);
    const result={schemaVersion:1,platform:'linux',version:manifest.version,components:manifest.components,installedAt:now(),installRoot:root,stateRoot:state,nodeExecutable:process.execPath,launcher:paths.launcher,updaterVersion:UPDATER_VERSION,backup:oldMoved?backup:null,previousReceipt:old||null,migratedStateFiles:migrated};
    await atomicJson(path.join(state,'installations','gateway.json'),result);await gate.assertIdle();
    await atomicJson(journal,{schemaVersion:1,id,status:'installed',installRoot:root,backup:result.backup,version:manifest.version,finishedAt:now()});
    await history(paths,{status:'installed',version:manifest.version,backup:result.backup,migratedStateFiles:migrated}).catch(()=>{});return result;
  }catch(e){
    let recovery='not_needed';try{if(replaced){await fs.rename(root,root+'.failed-'+id);if(oldMoved)await fs.rename(backup,root);if(launcherModified){if(hadLauncher){await fs.writeFile(paths.launcher,launcherBackup,{mode:launcherMode});await fs.chmod(paths.launcher,launcherMode);}else await fs.rm(paths.launcher,{force:true});}if(old)await atomicJson(path.join(state,'installations','gateway.json'),old);else await fs.rm(path.join(state,'installations','gateway.json'),{force:true});recovery='restored';}else if(oldMoved){await fs.rename(backup,root);recovery='restored';}}catch(r){recovery='failed';e.message+=`; recovery failed: ${r.message}; backup: ${backup}`;}
    await atomicJson(journal,{schemaVersion:1,id,status:'failed',version:manifest.version,error:e.message,recovery,backup:oldMoved?backup:null,finishedAt:now()}).catch(()=>{});
    await history(paths,{status:'failed',version:manifest.version,error:e.message,recovery,backup:oldMoved?backup:null}).catch(()=>{});throw e;
  }finally{await gate?.release();await fs.rm(unpack,{recursive:true,force:true});await fs.rm(stage,{recursive:true,force:true});}
}
async function rollback(paths,emit){
  await assertNoUnfinishedTransaction(paths.stateRoot);
  const current=await receipt(paths);if(!current?.backup)throw Error('No retained backup is available');
  const root=await ensureSafePath(paths.installRoot),backup=await ensureSafePath(current.backup);
  if(!backup.startsWith(root+'.backup-')||path.dirname(backup)!==path.dirname(root)||!await exists(path.join(backup,'dist/src/index.js')))throw Error('Invalid backup; manual recovery required');
  let previousLocation;try{previousLocation=await readJson(path.join(backup,'agent-acp-installation.json'));}catch{}
  if(!current.previousReceipt||previousLocation?.schemaVersion!==1||previousLocation.stateRoot!==paths.stateRoot)throw Error('Legacy rollback is blocked: the backup cannot read the current external job history. Keep the current installation and perform a reviewed manual recovery; records and backup are preserved.');
  const id=crypto.randomUUID(),gate=await maintenance(root,emit,paths.stateRoot),saved=root+'.backup-rollback-'+id,journal=path.join(paths.stateRoot,'updates','transactions',id+'.json');let moved=false,restored=false;
  try{await gate.assertIdle();await atomicJson(journal,{schemaVersion:1,id,status:'replacing',operation:'rollback',installRoot:root,backup:saved,rollbackSource:backup,previousReceipt:current,startedAt:now()});await fs.rename(root,saved);moved=true;await fs.rename(backup,root);restored=true;await gate.assertIdle();
    const prior=current.previousReceipt||{schemaVersion:1,platform:'linux',version:null,components:{gateway:await componentVersion(root)},installRoot:root,stateRoot:paths.stateRoot,nodeExecutable:process.execPath,launcher:paths.launcher,installedAt:now()};
    // Keep the updater usable when reverting to a pre-updater installation.
    if(!await exists(path.join(root,'linux/updater.mjs')))await copyTree(path.join(saved,'linux'),path.join(root,'linux'));
    await atomicJson(path.join(paths.stateRoot,'installations','gateway.json'),{...prior,backup:saved,previousReceipt:{...current,backup:null,previousReceipt:null},rolledBackAt:now()});await atomicJson(journal,{schemaVersion:1,id,status:'rolled_back',installRoot:root,backup:saved,version:prior.version,finishedAt:now()});await history(paths,{status:'rolled_back',version:prior.version,backup:saved}).catch(()=>{});return prior;
  }catch(e){let recovery='not_needed';try{if(restored){await fs.rename(root,backup);await fs.rename(saved,root);await atomicJson(path.join(paths.stateRoot,'installations','gateway.json'),current);recovery='restored';}else if(moved){await fs.rename(saved,root);recovery='restored';}}catch(r){recovery='failed';e.message+=`; rollback recovery failed: ${r.message}; backup: ${saved}`;}await atomicJson(journal,{schemaVersion:1,id,status:'failed',operation:'rollback',recovery,error:e.message,backup:saved,finishedAt:now()}).catch(()=>{});throw e;}finally{await gate.release();}
}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseArgs(args){const result={command:args.shift()||'status',json:false,check:false,background:false};if(!['status','install','update','rollback','operation'].includes(result.command))throw Error('Usage: agent-acp status|install|update|rollback|operation [--json] [--check] [--package-dir DIR]');if(result.command==='operation'){result.operationId=args.shift();if(!UUID.test(result.operationId||''))throw Error('A valid operation UUID is required');}for(let i=0;i<args.length;i++){const a=args[i];if(a==='--json')result.json=true;else if(a==='--check')result.check=true;else if(a==='--background')result.background=true;else if(['--package-dir','--install-dir','--state-dir','--operation-id'].includes(a)){if(!args[i+1]||args[i+1].startsWith('--'))throw Error(`Missing value for ${a}`);result[a.slice(2).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=args[++i];}else throw Error(`Unknown option: ${a}`);}if(result.check&&result.command!=='update')throw Error('--check is only valid with update');if(result.background&&(result.command!=='update'||result.check))throw Error('--background requires update without --check');if(result.operationId&&!UUID.test(result.operationId))throw Error('Invalid operation UUID');return result;}
export async function main(argv=process.argv.slice(2)){
  let options,paths,releaseLock,operationFile;let committing=false;const controller=new AbortController();const abort=()=>{if(!committing)controller.abort(Error('Update cancelled'));};process.on('SIGINT',abort);process.on('SIGTERM',abort);
  // Writes are serialized; the final snapshot must not be overwritten by an older progress write.
  let writes=Promise.resolve();const save=value=>{if(operationFile)writes=writes.then(()=>atomicJson(operationFile,{operationId:options.operationId,pid:process.pid,updatedAt:now(),...value}));};
  const emit=(phase,progress,message)=>{const value={type:'progress',status:'running',phase,progress,message,at:now()};save(value);if(options?.json)process.stdout.write(JSON.stringify(value)+'\n');else process.stdout.write(message+'\n');};
  const finish=value=>{const final={type:'result',...value};save(final);process.stdout.write(options?.json?JSON.stringify(final)+'\n':(value.error||`${value.status}: ${value.latestVersion||value.version||'unknown'}`)+'\n');return value;};
  try{
    options=parseArgs([...argv]);if(process.platform!=='linux')throw Error('This updater runs on Linux, including WSL; use Update.ps1 on Windows');if(!['x64','arm64'].includes(process.arch))throw Error('Linux x64 and arm64 are supported');if(compareVersions(process.versions.node,'22.12.0')<0)throw Error('Node.js 22.12+ required (24 LTS recommended)');
    paths=defaultPaths();
    // Running the installed updater pins that installation, never another root from a shared receipt.
    const fromInstalledRoot=await exists(path.join(SELF,'..','dist','src','index.js'));
    if(fromInstalledRoot)paths.installRoot=path.resolve(SELF,'..');
    if(options.installDir)paths.installRoot=path.resolve(options.installDir);
    let location;try{location=await readJson(path.join(paths.installRoot,'agent-acp-installation.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
    if(!process.env.AGENT_MCP_STATE_DIR&&location?.schemaVersion===1&&typeof location.stateRoot==='string')paths.stateRoot=location.stateRoot;
    if(options.stateDir)paths.stateRoot=path.resolve(options.stateDir);
    if(location?.stateRoot&&paths.stateRoot!==location.stateRoot)throw Error('Configured state directory differs from this installation; use its recorded --state-dir');
    const requestedRoot=paths.installRoot,old=await receipt(paths);
    if(old?.installRoot){if((options.installDir||fromInstalledRoot)&&path.resolve(old.installRoot)!==requestedRoot)throw Error('Receipt belongs to a different installation; refusing to redirect the requested installation');if(old.stateRoot&&path.resolve(old.stateRoot)!==paths.stateRoot)throw Error('Receipt state directory does not match the requested state directory');paths.installRoot=old.installRoot;}
    if(old?.launcher)paths.launcher=old.launcher;
    await ensureSafePath(paths.stateRoot);await ensureSafePath(paths.installRoot);
    const currentVersion=old?.version||null,gatewayVersion=await componentVersion(paths.installRoot);
    if(options.command==='operation'){const value=await readJson(path.join(paths.stateRoot,'updates','operations',options.operationId+'.json'));return finish(value);}
    if(options.operationId){operationFile=path.join(paths.stateRoot,'updates','operations',options.operationId+'.json');await ensureSafePath(operationFile);}
    if(options.command==='status')return finish({status:gatewayVersion?'installed':'not_installed',installed:!!gatewayVersion,legacy:!!gatewayVersion&&!old,canUpdate:!!gatewayVersion,version:currentVersion,currentVersion,gatewayVersion,latestVersion:null,updaterVersion:UPDATER_VERSION,installRoot:paths.installRoot,installationRoot:paths.installRoot,stateRoot:paths.stateRoot,stateDirectory:paths.stateRoot,nodeExecutable:process.execPath,platform:'linux',architecture:process.arch,blocked:false});
    if(options.command!=='operation'&&!options.check)await assertNoUnfinishedTransaction(paths.stateRoot);
    if(options.command==='update'&&!gatewayVersion)throw Error('Gateway is not installed; use install explicitly');
    if(options.background){
      const id=crypto.randomUUID(),opDir=path.join(paths.stateRoot,'updates','operations');await ensureSafePath(opDir);await fs.mkdir(opDir,{recursive:true,mode:0o700});
      const record=path.join(opDir,id+'.json'),worker=path.join(opDir,id);await fs.mkdir(worker,{mode:0o700});
      await fs.copyFile(path.join(SELF,'updater.mjs'),path.join(worker,'updater.mjs'));await fs.copyFile(path.join(SELF,'trusted-key.pem'),path.join(worker,'trusted-key.pem'));
      const childArgs=[path.join(worker,'updater.mjs'),'update','--json','--operation-id',id,'--install-dir',paths.installRoot,'--state-dir',paths.stateRoot];if(options.packageDir)childArgs.push('--package-dir',path.resolve(options.packageDir));
      await atomicJson(record,{operationId:id,status:'starting',phase:'starting',progress:0,updatedAt:now()});
      const log=await fs.open(path.join(opDir,id+'.log'),'ax',0o600);let child;try{child=spawn(process.execPath,childArgs,{detached:true,stdio:['ignore',log.fd,log.fd],env:process.env,cwd:worker});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();}finally{await log.close();}
      return finish({status:'started',operationId:id,pid:child.pid,phase:'starting',progress:0,currentVersion,operationFile:record});
    }
    releaseLock=await acquireLock(paths.stateRoot);
    if(options.command==='rollback'){const restored=await rollback(paths,emit);return finish({status:'rolled_back',version:restored.version,currentVersion:restored.version,phase:'complete',progress:100,reconnectRequired:true});}
    const key=await fs.readFile(path.join(SELF,'trusted-key.pem'),'utf8');let release,compressed;
    emit('checking',0,'Checking signed Linux release');
    if(options.packageDir){const folder=path.resolve(options.packageDir);const raw=await fs.readFile(path.join(folder,'linux-update-manifest.json')),signature=await fs.readFile(path.join(folder,'linux-update-manifest.sig'),'utf8');release={manifest:verifyManifest(raw,signature,key)};compressed=await fs.readFile(path.join(folder,release.manifest.asset.name));}
    else release=await latestRelease(paths,key,controller.signal);
    const manifest=release.manifest,available=!currentVersion||compareVersions(manifest.version,currentVersion)>0;
    if(!currentVersion&&gatewayVersion&&compareVersions(manifest.components.gateway,gatewayVersion)<0)throw Error('Latest release is older than the installed Gateway; manual review is required');
    if(options.check)return finish({status:available?'available':'up_to_date',version:currentVersion,currentVersion,latestVersion:manifest.version,gatewayVersion,components:manifest.components,notes:manifest.notes,publishedAt:manifest.publishedAt,downloadSize:manifest.asset.size,blocked:false,phase:'checked',progress:100});
    if(currentVersion&&compareVersions(manifest.version,currentVersion)<=0)return finish({status:'up_to_date',version:currentVersion,currentVersion,latestVersion:manifest.version,phase:'complete',progress:100});
    emit('downloading',15,'Downloading Linux Gateway');if(!compressed)compressed=await requestBytes(release.assetUrl,manifest.asset.size,controller.signal,(done,total)=>emit('downloading',15+Math.round(done/total*30),`Downloading Linux Gateway (${done}/${total} bytes)`));
    controller.signal.throwIfAborted();emit('verifying',50,'Verifying signature, hash and archive paths');
    if(compressed.length!==manifest.asset.size||sha(compressed)!==manifest.asset.sha256)throw Error('Archive SHA256 or size mismatch');
    const entries=parseArchive(compressed);verifyPackage(entries,manifest);controller.signal.throwIfAborted();
    const installed=await installVerified(paths,entries,manifest,emit,{onCommit:()=>{controller.signal.throwIfAborted();committing=true;}});
    return finish({status:'installed',version:installed.version,currentVersion:installed.version,latestVersion:manifest.version,components:installed.components,phase:'complete',progress:100,blocked:false,reconnectRequired:true,backup:installed.backup,installRoot:installed.installRoot,stateRoot:installed.stateRoot});
  }catch(e){process.exitCode=1;const blocked=/busy|disconnect MCP|restarted|already running|maintenance/i.test(e.message);return finish({status:controller.signal.aborted?'cancelled':blocked?'blocked':'error',phase:'failed',progress:null,blocked,error:e.message,retryAfter:e.retryAfter||null});}
  finally{await releaseLock?.();await writes;process.off('SIGINT',abort);process.off('SIGTERM',abort);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
