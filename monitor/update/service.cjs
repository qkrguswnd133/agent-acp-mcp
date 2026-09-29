const fs=require('node:fs');
const fsp=require('node:fs/promises');
// Electron interprets .asar paths as virtual archives. Update payload files
// must be written as ordinary disk bytes, including a new app.asar archive.
// Keep regular fs for reading our embedded trust key from the running ASAR.
const diskFs=process.versions.electron?require('original-fs'):fs;
const path=require('node:path');
const crypto=require('node:crypto');
const {pipeline}=require('node:stream/promises');
const {Transform}=require('node:stream');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const semver=require('semver');
const yauzl=require('yauzl');

const execFileAsync=promisify(execFile);
const REPOSITORY='qkrguswnd133/agent-acp-mcp';
const UPDATER_VERSION='1.0.0';
const API=`https://api.github.com/repos/${REPOSITORY}/releases?per_page=20`;
const MAX_JSON=2*1024*1024,MAX_MANIFEST=64*1024,MAX_PACKAGE_MANIFEST=8*1024*1024,MAX_SIGNATURE=4096;
const MAX_ZIP=1024*1024*1024,MAX_UNPACKED=2*1024*1024*1024,MAX_ENTRIES=100000;
const CHECK_INTERVAL=6*60*60*1000;
const MAX_RATE_COOLDOWN=6*60*60*1000;
const SHA=/^[a-f0-9]{64}$/i;
const VERSION=/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const updateError=(code,message)=>Object.assign(new Error(message),{code});
const safeMessage=error=>error?.code==='RATE_LIMIT'?'GitHub 요청 제한 중입니다. 나중에 다시 확인하세요.':error?.message||'업데이트 작업에 실패했습니다.';
const rateMessage=retryAt=>`GitHub 요청 제한 중입니다. ${new Date(retryAt).toLocaleString('ko-KR')} 이후 다시 확인하세요.`;
function rateRetryAt(headers,now=Date.now()){
  const retry=headers.get('retry-after');let candidate;
  if(retry&&/^\d+(?:\.\d+)?$/.test(retry.trim()))candidate=now+Number(retry)*1000;
  else if(retry&&Number.isFinite(Date.parse(retry)))candidate=Date.parse(retry);
  if(!Number.isFinite(candidate)){const reset=Number(headers.get('x-ratelimit-reset'));if(Number.isFinite(reset)&&reset>0)candidate=reset*1000;}
  if(!Number.isFinite(candidate))candidate=now+60000;
  return new Date(Math.min(now+MAX_RATE_COOLDOWN,Math.max(now+5000,candidate))).toISOString();
}
async function readJson(file,max=MAX_JSON){try{const s=await fsp.stat(file);if(!s.isFile()||s.size>max)return null;return JSON.parse(await fsp.readFile(file,'utf8'));}catch{return null;}}
async function writeJson(file,value){await fsp.mkdir(path.dirname(file),{recursive:true});const temp=`${file}.${process.pid}.tmp`;await fsp.writeFile(temp,JSON.stringify(value,null,2));await fsp.rename(temp,file);}
function validVersion(value){return typeof value==='string'&&VERSION.test(value)&&!!semver.valid(value);}
function releaseAssetUrl(release,name){const found=release.assets?.find(a=>a.name===name);if(!found||!Number.isSafeInteger(found.size)||found.size<0)return null;let url;try{url=new URL(found.browser_download_url);}catch{return null;}if(url.protocol!=='https:'||url.hostname!=='github.com'||url.username||url.password||url.search||url.hash||url.pathname!==`/${REPOSITORY}/releases/download/${release.tag_name}/${name}`)return null;return {url:url.href,size:found.size};}
function validateSignedManifest(bytes,signature,key,release){
  if(!Buffer.isBuffer(bytes)||bytes.length>MAX_MANIFEST||!Buffer.isBuffer(signature)||signature.length>MAX_SIGNATURE)throw updateError('MANIFEST','업데이트 서명 파일 크기가 올바르지 않습니다.');
  const encoded=signature.toString('utf8').trim();if(!/^[A-Za-z0-9+/]{86}==$/.test(encoded))throw updateError('SIGNATURE','업데이트 서명 형식이 올바르지 않습니다.');
  if(!crypto.verify(null,bytes,key,Buffer.from(encoded,'base64')))throw updateError('SIGNATURE','업데이트 서명 검증에 실패했습니다.');
  let m;try{m=JSON.parse(bytes.toString('utf8'));}catch{throw updateError('MANIFEST','업데이트 설명 파일이 올바르지 않습니다.');}
  if(m?.schemaVersion!==1||m.repository!==REPOSITORY||!validVersion(m.version)||m.tag!==`v${m.version}`||m.tag!==release.tag_name||!Number.isFinite(Date.parse(m.publishedAt))||!validVersion(m.minimumUpdaterVersion)||!validVersion(m.components?.gateway)||!validVersion(m.components?.monitor)||!Array.isArray(m.notes?.gateway)||!Array.isArray(m.notes?.monitor)||![...m.notes.gateway,...m.notes.monitor].every(x=>typeof x==='string'&&x.length<=1000)||m.asset?.name!==`Agent-ACP-MCP-Windows-${m.version}.zip`||!Number.isSafeInteger(m.asset.size)||m.asset.size<=0||m.asset.size>MAX_ZIP||!SHA.test(m.asset.sha256))throw updateError('MANIFEST','서명된 업데이트 설명이 예상 형식과 다릅니다.');
  return m;
}
async function boundedFetch(fetcher,url,max,{signal,accept='application/json',timeoutMs=12000,redirects=0}={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
  try{
    const response=await fetcher(url,{headers:{'User-Agent':'Agent-Monitor-Updater','Accept':accept},redirect:'manual',signal:controller.signal});
    if([301,302,303,307,308].includes(response.status)){
      if(redirects>=3)throw updateError('NETWORK','리디렉션이 너무 많습니다.');
      const location=new URL(response.headers.get('location')||'',url);
      if(location.protocol!=='https:'||!['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(location.hostname))throw updateError('NETWORK','허용되지 않은 다운로드 주소입니다.');
      return boundedFetch(fetcher,location.href,max,{signal,accept,timeoutMs,redirects:redirects+1});
    }
    if(response.status===403||response.status===429)throw Object.assign(updateError('RATE_LIMIT','GitHub 요청 제한'),{retryAt:rateRetryAt(response.headers)});
    if(!response.ok)throw updateError('NETWORK',`GitHub 요청 실패 (${response.status})`);
    const length=Number(response.headers.get('content-length'));if(Number.isFinite(length)&&length>max)throw updateError('SIZE','GitHub 응답 크기 초과');
    const parts=[];let size=0;for await(const part of response.body){size+=part.length;if(size>max)throw updateError('SIZE','GitHub 응답 크기 초과');parts.push(part);}return Buffer.concat(parts);
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
async function withRetry(operation){let last;for(let i=0;i<2;i++){try{return await operation();}catch(e){last=e;if(e.code==='RATE_LIMIT'||e.code==='SIGNATURE'||e.code==='MANIFEST'||e.code==='SIZE'||e.name==='AbortError')break;}}throw last;}
async function verifiedDownloadResponse(fetcher,url,headers,signal){
  let current=url;for(let redirects=0;redirects<4;redirects++){
    const response=await fetcher(current,{headers,redirect:'manual',signal});
    if(![301,302,303,307,308].includes(response.status))return response;
    const next=new URL(response.headers.get('location')||'',current);
    if(next.protocol!=='https:'||next.username||next.password||!['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(next.hostname))throw updateError('NETWORK','허용되지 않은 다운로드 주소입니다.');
    current=next.href;
  }throw updateError('NETWORK','리디렉션이 너무 많습니다.');
}
function safeZipName(name){
  if(typeof name!=='string'||name.length>500||!name||name.includes('\\')||name.includes('\0')||name.startsWith('/')||/^[A-Za-z]:/.test(name))return false;
  const parts=name.replace(/\/$/,'').split('/');return parts.every(p=>p&&p!=='.'&&p!=='..'&&!/[<>:"|?*\x00-\x1f]/.test(p)&&!/[. ]$/.test(p)&&!['con','prn','aux','nul',...Array.from({length:9},(_,i)=>`com${i+1}`),...Array.from({length:9},(_,i)=>`lpt${i+1}`)].includes(p.toLowerCase().split('.')[0]));
}
async function extractVerifiedZip(zipFile,stage,manifest){
  await fsp.mkdir(stage);
  const zip=await new Promise((resolve,reject)=>yauzl.open(zipFile,{lazyEntries:true,autoClose:false,decodeStrings:true,validateEntrySizes:true},(e,z)=>e?reject(e):resolve(z)));
  const seen=new Set(),files=new Map();let total=0,count=0;
  try{
    await new Promise((resolve,reject)=>{
      let done=false;const fail=e=>{if(!done){done=true;reject(e);}};
      zip.on('error',fail);zip.on('end',()=>{if(!done){done=true;resolve();}});
      zip.on('entry',async entry=>{
        try{
          const name=entry.fileName,dir=name.endsWith('/');if(!safeZipName(name))throw updateError('ZIP_PATH',`잘못된 ZIP 경로: ${name}`);
          const key=name.toLowerCase();if(seen.has(key))throw updateError('ZIP_DUPLICATE','ZIP 안에 중복 경로가 있습니다.');seen.add(key);
          const mode=(entry.externalFileAttributes>>>16)&0xffff;if((mode&0xf000)===0xa000||((mode&0xf000)!==0&&(mode&0xf000)!==0x8000&&(mode&0xf000)!==0x4000))throw updateError('ZIP_LINK','링크나 특수 파일이 포함되어 있습니다.');
          if(++count>MAX_ENTRIES||entry.uncompressedSize>MAX_ZIP||(total+=entry.uncompressedSize)>MAX_UNPACKED)throw updateError('ZIP_SIZE','압축 파일 크기 제한을 초과했습니다.');
          if(dir){await fsp.mkdir(path.join(stage,name),{recursive:true});zip.readEntry();return;}
          const destination=path.resolve(stage,...name.split('/'));if(!destination.startsWith(path.resolve(stage)+path.sep))throw updateError('ZIP_PATH','압축 경로가 작업 폴더를 벗어납니다.');
          await fsp.mkdir(path.dirname(destination),{recursive:true});const stream=await new Promise((res,rej)=>zip.openReadStream(entry,(e,s)=>e?rej(e):res(s)));
          const hash=crypto.createHash('sha256');let bytes=0;const meter=new Transform({transform(chunk,_,cb){bytes+=chunk.length;if(bytes>entry.uncompressedSize||bytes>MAX_ZIP)return cb(updateError('ZIP_SIZE','압축 파일 크기 불일치'));hash.update(chunk);cb(null,chunk);}});
          await pipeline(stream,meter,diskFs.createWriteStream(destination,{flags:'wx'}));if(bytes!==entry.uncompressedSize)throw updateError('ZIP_SIZE','압축 파일 크기 불일치');files.set(name,{size:bytes,sha256:hash.digest('hex')});zip.readEntry();
        }catch(e){fail(e);zip.close();}
      });zip.readEntry();
    });
  }finally{zip.close();}
  const internal=await readJson(path.join(stage,'manifest.json'),MAX_PACKAGE_MANIFEST);
  if(internal?.platform!=='win32-x64'||internal.gatewayVersion!==manifest.components.gateway||internal.monitorVersion!==manifest.components.monitor||!Array.isArray(internal.files))throw updateError('PACKAGE','내부 패키지 설명이 일치하지 않습니다.');
  const listed=new Set();for(const item of internal.files){if(!safeZipName(item?.path)||item.path.endsWith('/')||item.path==='manifest.json'||listed.has(item.path)||!SHA.test(item.sha256)||item.size!==undefined&&(!Number.isSafeInteger(item.size)||item.size<0))throw updateError('PACKAGE','내부 파일 목록이 올바르지 않습니다.');listed.add(item.path);const actual=files.get(item.path);if(!actual||actual.sha256.toLowerCase()!==item.sha256.toLowerCase()||item.size!==undefined&&actual.size!==item.size)throw updateError('PACKAGE',`패키지 파일 검증 실패: ${item.path}`);}
  if(files.size!==listed.size+1||!files.has('manifest.json')||!listed.has('Run-Update.ps1')||!listed.has('Update.ps1')||!listed.has('release-info.json')||![...listed].some(x=>x.startsWith('gateway/'))||![...listed].some(x=>x.startsWith('monitor/')))throw updateError('PACKAGE','패키지에 필요한 파일이 없거나 목록 밖 파일이 있습니다.');
  const info=await readJson(path.join(stage,'release-info.json'),MAX_MANIFEST);
  if(info?.schemaVersion!==1||info.version!==manifest.version||info.components?.gateway!==manifest.components.gateway||info.components?.monitor!==manifest.components.monitor)throw updateError('PACKAGE','패키지 버전 정보가 서명된 릴리스와 일치하지 않습니다.');
  return internal;
}
function readReceipt(file){return readJson(file,16*1024).then(x=>x?.schemaVersion===1&&validVersion(x.version)&&validVersion(x.components?.gateway)&&validVersion(x.components?.monitor)?x:null);}
async function findNode(configFile){
  const config=await readJson(configFile,64*1024),candidates=[];
  if(typeof config?.nodeExecutable==='string')candidates.push(config.nodeExecutable);
  if(process.env.NODE_EXE)candidates.push(process.env.NODE_EXE);
  try{const {stdout}=await execFileAsync(process.platform==='win32'?'where.exe':'which',[process.platform==='win32'?'node.exe':'node'],{timeout:3000,windowsHide:true});candidates.push(...stdout.split(/\r?\n/).filter(Boolean));}catch{}
  for(const candidate of candidates){try{if(!path.isAbsolute(candidate)||path.resolve(candidate).toLowerCase()===path.resolve(process.execPath).toLowerCase())continue;const {stdout}=await execFileAsync(candidate,['-p','JSON.stringify({version:process.versions.node,arch:process.arch})'],{timeout:3000,windowsHide:true});const info=JSON.parse(stdout.trim());if(info.arch==='x64'&&validVersion(info.version)&&semver.gte(info.version,'22.12.0'))return candidate;}catch{}}
  return null;
}
function resolveGatewayRoot(monitorDirectory,env=process.env){
  const configPath=path.join(monitorDirectory,'agent-monitor.config.json');let local={};try{local=JSON.parse(fs.readFileSync(configPath,'utf8'));}catch{}
  if(typeof env.AGENT_GATEWAY_ROOT==='string'&&path.isAbsolute(env.AGENT_GATEWAY_ROOT))return env.AGENT_GATEWAY_ROOT;
  if(typeof local.gatewayRoot==='string'&&path.isAbsolute(local.gatewayRoot))return local.gatewayRoot;
  const home=env.USERPROFILE||require('node:os').homedir(),neutral=path.join(env.LOCALAPPDATA||path.join(home,'AppData','Local'),'Programs','Agent ACP MCP'),legacy=path.join(home,'.codex','tools','agent-acp-mcp');return fs.existsSync(neutral)||!fs.existsSync(legacy)?neutral:legacy;
}
function createUpdater({stateDir,monitorDirectory,gatewayDirectory,fetcher=globalThis.fetch,keyFile=path.join(__dirname,'trusted-key.pem'),appVersion,launch,nodeFinder=findNode,helperAlive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}},clock=Date.now}={}){
  if(!stateDir||!monitorDirectory||!appVersion)throw Error('updater configuration incomplete');
  const updateDir=path.join(stateDir,'updates'),cacheFile=path.join(updateDir,'release-cache.json'),resultFile=path.join(updateDir,'install-result.json'),historyFile=path.join(updateDir,'history.json'),pendingFile=path.join(updateDir,'pending-install.json'),cooldownFile=path.join(updateDir,'rate-limit.json');
  let state={phase:'idle',error:null,checkedAt:null,history:[],localHistory:[],installed:null,currentComponents:{gateway:null,monitor:appVersion},selected:null,downloaded:false,progress:null,result:null,blocked:null,pending:null,retryAt:null},selectedRelease,controller,busy=false,cancelRequested=false,onChange=()=>{};
  const emit=()=>onChange({...state});const set=patch=>{state={...state,...patch};emit();};
  async function load(){
    const [monitorReceipt,gatewayReceipt,gatewayPackage,result,history,pending,cooldown]=await Promise.all([readReceipt(path.join(monitorDirectory,'release-receipt.json')),gatewayDirectory?readReceipt(path.join(gatewayDirectory,'release-receipt.json')):null,gatewayDirectory?readJson(path.join(gatewayDirectory,'package.json'),64*1024):null,readJson(resultFile,64*1024),readJson(historyFile,64*1024),readJson(pendingFile,16*1024),readJson(cooldownFile,4096)]);
    const installed=monitorReceipt&&gatewayReceipt&&monitorReceipt.version!==gatewayReceipt.version?null:monitorReceipt||gatewayReceipt;
    const localHistory=Array.isArray(history)?history.filter(x=>x?.schemaVersion===1&&typeof x.operationId==='string').slice(0,20):[];
    if(result?.schemaVersion===1&&typeof result.operationId==='string'&&!localHistory.some(x=>x.operationId===result.operationId))localHistory.unshift(result);
    const completed=result?.schemaVersion===1&&['success','blocked','failed','rolled_back','rollback_failed'].includes(result.status);
    const unresolved=pending?.schemaVersion===1&&typeof pending.operationId==='string'&&(!completed||result.operationId!==pending.operationId)?pending:null;
    if(pending&&!unresolved)await fsp.unlink(pendingFile).catch(()=>{});
    const retryMs=cooldown?.schemaVersion===1?Date.parse(cooldown.retryAt):NaN,retryAt=Number.isFinite(retryMs)&&retryMs>clock()?new Date(Math.min(retryMs,clock()+MAX_RATE_COOLDOWN)).toISOString():null;
    set({installed:installed?{version:installed.version,components:installed.components,installedAt:installed.installedAt,source:'receipt'}:{version:null,source:'unknown'},currentComponents:{gateway:validVersion(gatewayPackage?.version)?gatewayPackage.version:null,monitor:appVersion},result:result?.schemaVersion===1?result:null,localHistory,pending:unresolved,phase:unresolved?'installing':'idle',retryAt,error:retryAt?rateMessage(retryAt):null});
    const cached=await readJson(cacheFile,MAX_JSON);if(cached?.checkedAt&&Array.isArray(cached.releases)){
      try{const key=await fsp.readFile(keyFile,'utf8');const verified=cached.releases.map(x=>{const raw=Buffer.from(x.manifest,'base64'),sig=Buffer.from(x.signature,'base64');const m=validateSignedManifest(raw,sig,key,x.release),archive=releaseAssetUrl(x.release,m.asset.name);if(!archive||archive.size!==m.asset.size)throw Error('Invalid cached asset');return {manifest:m,release:x.release,urls:{archive:archive.url}};});
        selectedRelease=verified.find(x=>!state.installed?.version||semver.gt(x.manifest.version,state.installed.version))||verified[0];set({checkedAt:cached.checkedAt,history:verified.map(publicRelease),selected:selectedRelease?publicRelease(selectedRelease):null,blocked:selectedRelease&&semver.gt(selectedRelease.manifest.minimumUpdaterVersion,UPDATER_VERSION)?'이 업데이트에는 최신 설치 관리자가 필요합니다. GitHub 릴리스에서 수동으로 설치하세요.':null});
      }catch{}
    }
    return state;
  }
  function publicRelease(item){const m=item.manifest;return {version:m.version,tag:m.tag,publishedAt:m.publishedAt,components:m.components,notes:m.notes,minimumUpdaterVersion:m.minimumUpdaterVersion,assetName:m.asset.name,size:m.asset.size};}
  async function pollResult(){
    const result=await readJson(resultFile,64*1024);
    const valid=result?.schemaVersion===1&&typeof result.operationId==='string'&&['success','blocked','failed','rolled_back','rollback_failed'].includes(result.status);
    const pending=state.pending;if(pending?.helperPid&&(!valid||result.operationId!==pending.operationId)&&clock()-Date.parse(pending.startedAt)>10000&&!helperAlive(pending.helperPid)){
      await fsp.unlink(pendingFile).catch(()=>{});set({pending:null,phase:'idle',blocked:'설치 프로그램이 결과를 남기지 않고 종료되었습니다. 설치 폴더와 백업을 확인한 뒤 다시 시도하세요.',error:'설치 결과를 확인할 수 없습니다.'});
    }
    if(!valid)return state;
    const found=state.localHistory.some(x=>x.operationId===result.operationId);
    if(!found){const history=await readJson(historyFile,64*1024);const localHistory=Array.isArray(history)&&history.some(x=>x?.operationId===result.operationId)?history.slice(0,20):[result,...state.localHistory].slice(0,20);set({localHistory});}
    if(state.pending?.operationId===result.operationId){await fsp.unlink(pendingFile).catch(()=>{});set({pending:null,phase:'idle',result,error:result.status==='success'?null:result.message||`설치 결과: ${result.status}`});}
    else if(state.result?.operationId!==result.operationId)set({result});
    return state;
  }
  async function check(force=false){
    if(busy||state.phase==='installing'||state.pending)return state;
    if(state.retryAt&&clock()<Date.parse(state.retryAt)){set({phase:'idle',error:rateMessage(state.retryAt)});return state;}
    if(state.retryAt){await fsp.unlink(cooldownFile).catch(()=>{});set({retryAt:null,error:null});}
    if(!force&&state.checkedAt&&clock()-Date.parse(state.checkedAt)<CHECK_INTERVAL)return state;
    busy=true;set({phase:'checking',error:null,blocked:null});try{
      const key=await fsp.readFile(keyFile,'utf8').catch(()=>null);if(!key)throw updateError('TRUST_KEY','신뢰할 수 있는 업데이트 공개 키가 포함되지 않았습니다. 수동 업데이트가 필요합니다.');
      const response=await withRetry(()=>boundedFetch(fetcher,API,MAX_JSON));const releases=JSON.parse(response.toString('utf8'));if(!Array.isArray(releases))throw updateError('NETWORK','GitHub 릴리스 응답이 올바르지 않습니다.');
      const valid=[];let invalidCount=0;for(const release of releases){if(release.draft||release.prerelease||!/^v\d+\.\d+\.\d+$/.test(release.tag_name)||!Array.isArray(release.assets))continue;
        const manifestAsset=releaseAssetUrl(release,'update-manifest.json'),sigAsset=releaseAssetUrl(release,'update-manifest.sig');if(!manifestAsset||!sigAsset)continue;
        try{const [raw,sig]=await Promise.all([withRetry(()=>boundedFetch(fetcher,manifestAsset.url,MAX_MANIFEST,{accept:'application/octet-stream'})),withRetry(()=>boundedFetch(fetcher,sigAsset.url,MAX_SIGNATURE,{accept:'application/octet-stream'}))]);const m=validateSignedManifest(raw,sig,key,release);const archive=releaseAssetUrl(release,m.asset.name);if(!archive||archive.size!==m.asset.size){invalidCount++;continue;}valid.push({release:{tag_name:release.tag_name,assets:release.assets.map(a=>({name:a.name,size:a.size,browser_download_url:a.browser_download_url}))},manifest:m,urls:{archive:archive.url},raw,sig});}catch(e){if(e.code==='RATE_LIMIT')throw e;invalidCount++;}
      }
      valid.sort((a,b)=>semver.rcompare(a.manifest.version,b.manifest.version));selectedRelease=valid.find(x=>!state.installed?.version||semver.gt(x.manifest.version,state.installed.version))||valid[0];const checkedAt=new Date(clock()).toISOString();await writeJson(cacheFile,{checkedAt,releases:valid.map(x=>({release:x.release,urls:x.urls,manifest:x.raw.toString('base64'),signature:x.sig.toString('base64')}))});await fsp.unlink(cooldownFile).catch(()=>{});
      const blocked=selectedRelease&&semver.gt(selectedRelease.manifest.minimumUpdaterVersion,UPDATER_VERSION)?'이 업데이트에는 최신 설치 관리자가 필요합니다. GitHub 릴리스에서 수동으로 설치하세요.':null;
      set({phase:'idle',checkedAt,history:valid.map(publicRelease),selected:selectedRelease?publicRelease(selectedRelease):null,downloaded:false,blocked,retryAt:null,error:invalidCount?`${invalidCount}개 릴리스의 서명 또는 파일 정보를 확인하지 못했습니다.`:valid.length?null:'검증된 안정 릴리스가 없습니다.'});
    }catch(e){if(e.code==='RATE_LIMIT'){const retryAt=Number.isFinite(Date.parse(e.retryAt))?new Date(Math.min(Date.parse(e.retryAt),clock()+MAX_RATE_COOLDOWN)).toISOString():new Date(clock()+60000).toISOString();await writeJson(cooldownFile,{schemaVersion:1,retryAt}).catch(()=>{});set({phase:'idle',retryAt,error:rateMessage(retryAt)});}else set({phase:'idle',error:safeMessage(e),blocked:e.code==='TRUST_KEY'?safeMessage(e):state.blocked});}finally{busy=false;}return state;
  }
  async function download(){
    if(busy||state.phase==='installing'||state.pending||state.result?.status==='rollback_failed'||!selectedRelease||state.blocked||state.installed?.version&&semver.lte(selectedRelease.manifest.version,state.installed.version))return state;busy=true;cancelRequested=false;controller=new AbortController();const m=selectedRelease.manifest,final=path.join(updateDir,m.asset.name),part=`${final}.part`;
    set({phase:'downloading',error:null,progress:{received:0,total:m.asset.size}});
    let timeout;try{
      await fsp.mkdir(updateDir,{recursive:true});const finalStat=await fsp.stat(final).catch(()=>null);if(finalStat){if(finalStat.isFile()&&finalStat.size===m.asset.size&&(await hashFile(final)).toLowerCase()===m.asset.sha256.toLowerCase()){if(cancelRequested)throw updateError('CANCELLED','업데이트를 취소했습니다.');set({phase:'downloaded',downloaded:true,progress:null});return state;}await fsp.unlink(final);}
      let existing=await fsp.stat(part).then(s=>s.size).catch(()=>0);
      if(existing>=m.asset.size){if(existing===m.asset.size&&(await hashFile(part)).toLowerCase()===m.asset.sha256.toLowerCase()){if(cancelRequested)throw updateError('CANCELLED','업데이트를 취소했습니다.');await fsp.rename(part,final);set({phase:'downloaded',downloaded:true,progress:null});return state;}await fsp.unlink(part);existing=0;}
      timeout=setTimeout(()=>controller.abort(),20*60*1000);
      for(let attempt=0;attempt<2;attempt++){
        const response=await verifiedDownloadResponse(fetcher,selectedRelease.urls.archive,{'User-Agent':'Agent-Monitor-Updater',Accept:'application/octet-stream',...(existing?{Range:`bytes=${existing}-`}:{})},controller.signal);
        const match=response.status===206?/^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range')||''):null;
        const badRange=response.status===206&&(!match||Number(match[1])!==existing||Number(match[2])<existing||Number(match[2])>=m.asset.size||Number(match[3])!==m.asset.size);
        if((response.status===416||badRange)&&existing&&attempt===0){await response.body?.cancel?.().catch(()=>{});await fsp.unlink(part);existing=0;set({progress:{received:0,total:m.asset.size}});continue;}
        if(badRange)throw updateError('NETWORK','이어받기 범위가 올바르지 않습니다.');
        if(![200,206].includes(response.status))throw updateError('NETWORK',`다운로드 실패 (${response.status})`);
        if(response.status===200)existing=0;let received=existing;const meter=new Transform({transform(chunk,_,cb){received+=chunk.length;if(received>m.asset.size)return cb(updateError('SIZE','다운로드 크기 초과'));set({progress:{received,total:m.asset.size}});cb(null,chunk);}});
        await pipeline(response.body,meter,fs.createWriteStream(part,{flags:existing?'a':'w'}));if(received!==m.asset.size)throw updateError('SIZE','다운로드 크기가 일치하지 않습니다.');
        const digest=await hashFile(part);if(cancelRequested)throw updateError('CANCELLED','업데이트를 취소했습니다.');if(digest.toLowerCase()!==m.asset.sha256.toLowerCase()){await fsp.unlink(part);throw updateError('HASH','다운로드 해시 검증 실패');}
        await fsp.rename(part,final);set({phase:'downloaded',downloaded:true,progress:null});break;
      }
    }catch(e){set({phase:'idle',downloaded:false,error:e.name==='AbortError'?'다운로드를 취소했습니다. 이어받을 수 있습니다.':safeMessage(e),progress:null});}finally{clearTimeout(timeout);busy=false;controller=null;}return state;
  }
  async function hashFile(file){const h=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))h.update(chunk);return h.digest('hex');}
  function cancel(){if(['downloading','downloaded','preparing'].includes(state.phase)){cancelRequested=true;controller?.abort();}}
  function requireNotCancelled(){if(cancelRequested)throw updateError('CANCELLED','업데이트를 취소했습니다.');}
  async function install(){
    if(busy||cancelRequested||state.phase==='installing'||state.pending||state.result?.status==='rollback_failed'||!state.downloaded||!selectedRelease||state.blocked||state.installed?.version&&semver.lte(selectedRelease.manifest.version,state.installed.version))return {started:false,reason:'업데이트를 설치할 수 없습니다.'};busy=true;set({phase:'preparing',error:null});let pendingSaved=false;
    try{
      const m=selectedRelease.manifest,archive=path.join(updateDir,m.asset.name);requireNotCancelled();if(!await fsp.stat(archive).then(s=>s.isFile()&&s.size===m.asset.size).catch(()=>false))throw updateError('HASH','다운로드 파일 검증 실패. 다시 다운로드하세요.');
      if((await hashFile(archive)).toLowerCase()!==m.asset.sha256.toLowerCase())throw updateError('HASH','다운로드 파일 검증 실패. 다시 다운로드하세요.');requireNotCancelled();
      const operationId=crypto.randomUUID(),stage=path.join(updateDir,`stage-${operationId}`);await extractVerifiedZip(archive,stage,m);requireNotCancelled();
      const nodeExecutable=await nodeFinder(path.join(monitorDirectory,'agent-monitor.config.json'));requireNotCancelled();if(!nodeExecutable)throw updateError('NODE','Node.js 22.12 이상(x64)을 찾지 못했습니다. Node.js를 설치하거나 agent-monitor.config.json의 nodeExecutable에 실행 파일 경로를 지정하세요.');
      const request={schemaVersion:1,operationId,packageDirectory:stage,...(gatewayDirectory?{gatewayDirectory}:{}),monitorDirectory,nodeExecutable,resultFile,userDataDir:stateDir};const requestFile=path.join(updateDir,`request-${operationId}.json`);await writeJson(requestFile,request);requireNotCancelled();
      const runner=path.join(stage,'Run-Update.ps1'),pending={schemaVersion:1,operationId,version:m.version,startedAt:new Date(clock()).toISOString()};await writeJson(pendingFile,pending);pendingSaved=true;requireNotCancelled();
      set({phase:'installing',error:null});let helperPid;try{helperPid=await (launch||launchRunner)(runner,requestFile);}catch(e){await fsp.unlink(pendingFile).catch(()=>{});pendingSaved=false;throw e;}
      if(Number.isSafeInteger(helperPid)&&helperPid>0){pending.helperPid=helperPid;await writeJson(pendingFile,pending).catch(()=>{});}
      set({phase:'installing',error:null,pending});return {started:true,operationId};
    }catch(e){if(pendingSaved)await fsp.unlink(pendingFile).catch(()=>{});set({phase:'idle',downloaded:e.code==='HASH'?false:state.downloaded,error:safeMessage(e)});return {started:false,reason:safeMessage(e)};}finally{busy=false;}
  }
  async function launchRunner(runner,requestFile){
    if(process.platform!=='win32')throw updateError('PLATFORM','Windows에서만 설치할 수 있습니다.');
    const command=`powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"${runner.replaceAll('"','')}\" -RequestFile \"${requestFile.replaceAll('"','')}\"`;
    const escaped=command.replaceAll("'","''");const script=`$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow = [uint16]0}; $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine = '${escaped}'; CurrentDirectory = '${path.dirname(runner).replaceAll("'","''")}'; ProcessStartupInformation = $startup}; if ($result.ReturnValue -ne 0) { throw "Updater launch failed: $($result.ReturnValue)" }; Write-Output $result.ProcessId`;
    const {stdout}=await execFileAsync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-Command',script],{timeout:15000,windowsHide:true});if(!/^\s*\d+\s*$/.test(stdout))throw updateError('LAUNCH','업데이트 실행을 확인하지 못했습니다.');return Number(stdout.trim());
  }
  return {load,check,download,cancel,install,pollResult,getState:()=>({...state}),onChange(callback){onChange=callback;},resolveGatewayRoot};
}
module.exports={createUpdater,validateSignedManifest,releaseAssetUrl,extractVerifiedZip,resolveGatewayRoot,findNode,readReceipt,safeZipName};
