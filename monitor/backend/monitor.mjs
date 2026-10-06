import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';

export const PROVIDERS=['grok','claude','codex'];
const ALLOWED_ENV=new Set(['GROK_ENABLED','CLAUDE_ENABLED','CODEX_ENABLED','GROK_CLI','CLAUDE_CLI','CODEX_CLI','CODEX_CLI_PATH','GROK_MODEL','CLAUDE_MODEL','CODEX_MODEL','GROK_EFFORT','CLAUDE_EFFORT','CODEX_EFFORT','QUOTA_RETRY_MINUTES','AGENT_MCP_STATE_DIR','AGENT_MCP_WORKTREE_DIR','CODEX_POWERSHELL_PATH']);
const text=value=>typeof value==='string'&&value.length<=512?value:null;
const number=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
export function timestamp(value){
  const time=typeof value==='number'?(value<1e11?value*1000:value):typeof value==='string'?Date.parse(value):NaN;
  return Number.isFinite(time)&&Math.abs(time)<=8.64e15?new Date(time).toISOString():null;
}
/** Read only explicit scalar settings from the gateway's env table. Never copy credentials. */
export function parseGatewayEnvironment(toml){
  const result={};let inside=false;
  for(const line of toml.split(/\r?\n/)){
    const header=line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if(header){inside=header[1].replaceAll('"','').replaceAll("'",'')==='mcp_servers.agent.env';continue;}
    if(!inside)continue;
    const match=line.match(/^\s*([A-Z_]+)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/);
    if(!match||!ALLOWED_ENV.has(match[1]))continue;
    try{result[match[1]]=match[2][0]==='"'?JSON.parse(match[2]):match[2].slice(1,-1);}catch{}
  }
  return result;
}
async function readJson(file,maxBytes=4*1024*1024){try{const info=await fs.stat(file);if(!info.isFile()||info.size>maxBytes)return null;return JSON.parse(await fs.readFile(file,'utf8'));}catch{return null;}}
export function sanitizeUsage(value){
  if(!value||typeof value!=='object')return null;
  const allowed=['inputTokens','outputTokens','reasoningTokens','totalTokens','input_tokens','output_tokens','cache_creation_input_tokens','cache_read_input_tokens','cached_input_tokens','total_tokens'];
  const result={};for(const key of allowed)if(number(value[key])!==null)result[key]=value[key];
  return Object.keys(result).length?result:null;
}
function observedSetting(value){return text(value)&&!['auto','unavailable','unknown'].includes(value)?value:null;}
const secretLike=/(?:sk-ant-|sk-[a-z0-9]{12}|gh[opusr]_|Bearer\s+)/i;
const sourceText=value=>typeof value==='string'&&/^[a-z0-9_.:-]{1,64}$/i.test(value)?value:null;
const reasonText=value=>typeof value==='string'&&value.trim()&&value.length<=300&&!/[\x00-\x1f\x7f]/.test(value)&&!secretLike.test(value)?value.trim():null;
function selectionAxis(v){return v&&typeof v==='object'&&text(v.value)&&!secretLike.test(v.value)&&['parent','configured'].includes(v.source)?{value:v.value,source:v.source,reason:reasonText(v.reason)}:null;}
function observationAxis(v){const value=v&&typeof v==='object'?observedSetting(v.value):null;return value?{value,source:sourceText(v.source)??'unavailable',verified:v.verified===true}:null;}
/** Parent/configured selection stays separate from observed runtime values; legacy results yield nulls. */
export function runSettings(r){
  const selection={model:selectionAxis(r?.selection?.model),effort:selectionAxis(r?.selection?.effort)};
  const observation={model:observationAxis(r?.observation?.model),effort:observationAxis(r?.observation?.effort)};
  return {selection:selection.model||selection.effort?selection:null,observation:observation.model||observation.effort?observation:null};
}
export function sanitizeJob(job){
  if(!job||typeof job!=='object'||!text(job.job_id)||!text(job.cwd))return null;
  const results=Array.isArray(job.result?.results)?job.result.results:[];
  const providers=results.filter(r=>PROVIDERS.includes(r?.provider)).map(r=>({provider:r.provider,model:observedSetting(r.model),effort:observedSetting(r.effort),...runSettings(r),sessionId:text(r.sessionId),usage:sanitizeUsage(r.usage),status:r.error?'failed':'completed',errorKind:text(r.errorKind)}));
  const active=job.activity;
  if(PROVIDERS.includes(active?.provider)&&!providers.some(p=>p.provider===active.provider))providers.push({provider:active.provider,model:observedSetting(active.model),effort:observedSetting(active.effort),...runSettings(active),sessionId:text(active.sessionId),usage:sanitizeUsage(active.usage),status:text(job.status),errorKind:null});
  const candidate=text(job.worktree?.originalCwd);
  const originalCwd=candidate&&(path.win32.isAbsolute(candidate)||path.posix.isAbsolute(candidate))?candidate:null;
  const isolated=!!originalCwd&&originalCwd!==job.cwd;
  return {originalCwd,isolated,jobId:job.job_id,status:['queued','running','cancelling','completed','failed','cancelled','interrupted'].includes(job.status)?job.status:'unknown',project:path.win32.basename((originalCwd??job.cwd).replaceAll('/','\\')),cwd:job.cwd,startedAt:timestamp(job.startedAt),lastActivityAt:timestamp(job.lastActivityAt),finishedAt:timestamp(job.finishedAt),providers};
}
export async function readJobs(directory,limit=20){
  let names;try{names=(await fs.readdir(directory)).filter(n=>/^[a-f0-9-]{36}\.json$/i.test(n));}catch{return [];}
  const files=await Promise.all(names.map(async name=>{try{return {name,mtime:(await fs.stat(path.join(directory,name))).mtimeMs};}catch{return null;}}));
  const jobs=await Promise.all(files.filter(Boolean).sort((a,b)=>b.mtime-a.mtime).slice(0,Math.max(1,Math.min(limit,100))).map(async f=>sanitizeJob(await readJson(path.join(directory,f.name)))));
  return jobs.filter(Boolean).sort((a,b)=>(Date.parse(b.lastActivityAt??b.startedAt)||0)-(Date.parse(a.lastActivityAt??a.startedAt)||0));
}
export function normalizeQuota(value={},observedAt=null){
  const used=number(value.usedPercent),remaining=number(value.remainingPercent);
  const windows=Array.isArray(value.windows)?value.windows.filter(w=>text(w?.id)&&text(w?.label)&&number(w?.usedPercent)!==null).map(w=>({id:w.id,label:w.label,usedPercent:w.usedPercent,remainingPercent:number(w.remainingPercent),resetsAt:timestamp(w.resetsAt)})):[];
  return {state:['available','exhausted','unknown'].includes(value.state)?value.state:'unknown',source:text(value.source)??'unavailable',usedPercent:used,remainingPercent:remaining,resetsAt:timestamp(value.resetsAt),retryAfter:timestamp(value.retryAfter),limitKind:['quota_exhausted','rate_limited'].includes(value.limitKind)?value.limitKind:null,observedAt:timestamp(value.observedAt??observedAt),stale:value.stale===true,selectedWindow:text(value.selectedWindow),windows,unavailableReason:value.unavailableReason==='missing_percentage'?'missing_percentage':null,note:text(value.note)};
}
/** Pure read of runtime cache; never acquire locks or migrate/write gateway files. */
export async function readRuntimeQuota(file,provider,now=Date.now()){
  const raw=await readJson(file);const modern=raw?.schemaVersion===2;const entry=(modern?raw.providers:raw)?.[provider];
  if(!entry?.quota)return null;
  const retry=timestamp(modern?entry.retryAfter:entry.blockedUntil);
  const kind=entry.limitKind??(entry.quota.state==='exhausted'?'quota_exhausted':null);
  if(kind&&(!retry||Date.parse(retry)<=now))return null;
  return normalizeQuota({...entry.quota,resetsAt:modern?entry.resetsAt:null,retryAfter:retry,limitKind:kind},entry.updatedAt);
}
function enabled(provider,env){return !['false','0','no','off','disabled'].includes(String(env[`${provider.toUpperCase()}_ENABLED`]??'true').toLowerCase());}
const accountText=value=>typeof value==='string'&&value.length<=128&&value.trim()&&!/[\x00-\x1f\x7f]/.test(value)&&!/(?:sk-ant-|sk-[a-z0-9]{12}|gh[opusr]_|Bearer\s+)/i.test(value)?value.trim():null;
/** Only current, explicitly authenticated CLI status can identify an account. */
export function normalizeAccount(value,authenticated){
  if(authenticated!==true||!value||typeof value!=='object'||value.status!=='authenticated'||value.stale===true||value.fresh===false)return {status:authenticated===false?'unauthenticated':'unknown',email:null,username:null,displayName:null,organization:null,source:null,observedAt:null};
  const source=typeof value.source==='string'&&/^[a-z0-9_.-]{1,64}$/i.test(value.source)?value.source:null;
  return {status:'authenticated',email:accountText(value.email),username:accountText(value.username),displayName:accountText(value.displayName),organization:accountText(value.organization),source,observedAt:timestamp(value.observedAt)};
}
function emptyProvider(provider,env){return {provider,enabled:enabled(provider,env),available:'unknown',authenticated:'unknown',subscriptionAuth:'unknown',account:normalizeAccount(),version:null,versionSource:'unavailable',model:null,effort:null,modelSource:'unavailable',effortSource:'unavailable',modelPolicy:env[`${provider.toUpperCase()}_MODEL`]??'auto',effortPolicy:env[`${provider.toUpperCase()}_EFFORT`]??'auto',observedAt:null,quota:normalizeQuota(),reason:null};}

export function createMonitor({gatewayRoot,home=os.homedir(),env=process.env,adapters={},getWeeklyUsage,getGrokAccountStatus,now=Date.now}={}){
  const stateRoot=env.AGENT_MCP_STATE_DIR??path.join(home,'.agent-acp-mcp');
  let inFlight;
  async function statusOne(provider){
    const base=emptyProvider(provider,env);if(!base.enabled)return {...base,available:false,quota:normalizeQuota({source:'disabled'})};
    try{
      if(provider==='grok'){
        const health=await readJson(path.join(gatewayRoot,'state','health.json'));
        const command=env.GROK_CLI??path.join(home,'.grok','bin',process.platform==='win32'?'grok.exe':'grok');
        const exists=await fs.stat(command).then(s=>s.isFile()).catch(()=>false);
        let weekly;try{weekly=exists?await getWeeklyUsage?.(false):null;}catch{}
        let accountStatus;try{accountStatus=exists?await getGrokAccountStatus?.(false):null;}catch{}
        const fresh=weekly?.status==='available'&&weekly.fresh===true&&weekly.stale!==true;
        const used=number(weekly?.creditUsagePercent),remaining=number(weekly?.remainingPercent);
        const missingPercentage=fresh&&used===null;
        const live=normalizeQuota({state:fresh&&used!==null?(used>=100?'exhausted':'available'):'unknown',source:weekly?.source??'unavailable',usedPercent:used,remainingPercent:remaining,resetsAt:weekly?.currentPeriod?.end,stale:!fresh,unavailableReason:missingPercentage?'missing_percentage':null,note:missingPercentage?'공식 Grok 응답에서 사용률 값이 제공되지 않았습니다. 구독 기간과 다음 초기화 시각은 확인됐으며, 사용률 값이 제공되면 자동으로 표시합니다.':null},weekly?.timestamp);
        const block=await readRuntimeQuota(path.join(stateRoot,'grok-quota.json'),'grok',now());
        const quota=block?.state==='exhausted'?{...live,...block,usedPercent:live.usedPercent,remainingPercent:live.remainingPercent}:live;
        const authenticated=accountStatus?.status==='unauthenticated'?false:accountStatus?.status==='authenticated'?true:fresh&&['acp_billing','acp_cache'].includes(weekly?.source)?true:'unknown';
        return {...base,available:exists,availabilitySource:'local_executable',authenticated,subscriptionAuth:authenticated,account:normalizeAccount(accountStatus,authenticated),version:text(health?.version),versionSource:health?.version?'last_known_health':'unavailable',model:observedSetting(health?.model),effort:observedSetting(health?.effort),modelSource:health?.model?'last_known_health':'unavailable',effortSource:health?.effort?'last_known_health':'unavailable',observedAt:timestamp(health?.checkedAt),quota,reason:exists?null:'CLI not found'};
      }
      const raw=await adapters[provider]?.status(false);
      if(!raw)throw Error('status unavailable');
      const authenticated=typeof raw.authenticated==='boolean'?raw.authenticated:'unknown';
      return {...base,enabled:raw.enabled===true,available:typeof raw.available==='boolean'?raw.available:'unknown',authenticated,subscriptionAuth:typeof raw.subscriptionAuth==='boolean'?raw.subscriptionAuth:'unknown',account:normalizeAccount(raw.account,authenticated),version:text(raw.version),versionSource:'cli_status',modelPolicy:text(raw.modelPolicy)??base.modelPolicy,effortPolicy:text(raw.effortPolicy)??base.effortPolicy,observedAt:new Date(now()).toISOString(),quota:normalizeQuota(raw.quota,new Date(now()).toISOString()),reason:raw.reason?'Provider status incomplete':null};
    }catch{return {...base,reason:'Status lookup unavailable'};}
  }
  return {status(){return inFlight??=(async()=>{
    const [providers,jobs]=await Promise.all([Promise.all(PROVIDERS.map(statusOne)),readJobs(path.join(gatewayRoot,'state','jobs'))]);
    for(const p of providers){
      const latest=jobs.flatMap(job=>job.providers.map(r=>({...r,at:job.finishedAt??job.lastActivityAt}))).find(r=>r.provider===p.provider&&(r.model||r.effort));
      if(latest&&(!p.observedAt||Date.parse(latest.at)>Date.parse(p.observedAt)||p.modelSource==='unavailable')){
        if(latest.model){p.model=latest.model;p.modelSource='last_known_job';}
        if(latest.effort){p.effort=latest.effort;p.effortSource='last_known_job';}
        p.observedAt=latest.at;
      }
      // Newest settled (or metadata-bearing) run decides; an older run's selection never stands in for a newer legacy run.
      const run=jobs.flatMap(job=>job.providers.map(r=>({...r,jobId:job.jobId,at:job.finishedAt??job.lastActivityAt??job.startedAt}))).find(r=>r.provider===p.provider&&(r.selection||r.observation||!['running','queued','cancelling'].includes(r.status)));
      p.lastRun=run&&(run.selection||run.observation)?{jobId:run.jobId,at:run.at,selection:run.selection,observation:run.observation}:null;
    }
    return {generatedAt:new Date(now()).toISOString(),providers,jobs};
  })().finally(()=>{inFlight=undefined;});}};
}

export async function loadMonitor({home=process.env.USERPROFILE??os.homedir(),env=process.env,configFile=path.join(path.dirname(process.execPath),'agent-monitor.config.json')}={}){
  let configured={};try{configured=parseGatewayEnvironment(await fs.readFile(path.join(env.CODEX_HOME??path.join(home,'.codex'),'config.toml'),'utf8'));}catch{}
  // A standalone installation can configure the monitor without a Codex host.
  const local=await readJson(configFile,64*1024);
  for(const [key,value] of Object.entries(local?.env??{}))if(ALLOWED_ENV.has(key)&&typeof value==='string')configured[key]=value;
  if(typeof local?.gatewayRoot==='string'&&path.isAbsolute(local.gatewayRoot)&&env.AGENT_GATEWAY_ROOT===undefined)env.AGENT_GATEWAY_ROOT=local.gatewayRoot;
  // Explicit monitor environment overrides the saved gateway's scalar settings.
  for(const [key,value] of Object.entries(configured))if(env[key]===undefined)env[key]=value;
  const neutralRoot=path.join(env.LOCALAPPDATA??path.join(home,'AppData','Local'),'Programs','Agent ACP MCP');
  const legacyRoot=path.join(home,'.codex','tools','agent-acp-mcp');
  const neutralExists=await fs.stat(neutralRoot).then(s=>s.isDirectory()).catch(()=>false);
  const legacyExists=await fs.stat(legacyRoot).then(s=>s.isDirectory()).catch(()=>false);
  const gatewayRoot=env.AGENT_GATEWAY_ROOT??(neutralExists||!legacyExists?neutralRoot:legacyRoot);
  const module=relative=>import(pathToFileURL(path.join(gatewayRoot,'dist','src',relative)).href);
  const imports=await Promise.allSettled([module('billing.js'),module('providers/claude.js'),module('providers/codex.js')]);
  const adapters={};if(imports[1].status==='fulfilled')adapters.claude=new imports[1].value.ClaudeProvider();if(imports[2].status==='fulfilled')adapters.codex=new imports[2].value.CodexProvider();
  return createMonitor({gatewayRoot,home,env,adapters,getWeeklyUsage:imports[0].status==='fulfilled'?imports[0].value.getWeeklyUsage:undefined,getGrokAccountStatus:imports[0].status==='fulfilled'?imports[0].value.getGrokAccountStatus:undefined});
}
