import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import type {QuotaStatus} from './types.js';

export interface ClaudeUsageWindow {id:string;label:string;usedPercent:number;remainingPercent:number;resetsAt:string|null;}
export interface ClaudeUsageStatus extends QuotaStatus {
  windows:ClaudeUsageWindow[];selectedWindow:string|null;observedAt:string|null;stale:boolean;nextRefreshAt?:string|null;
}
export interface ClaudeUsageOptions {
  fetch?:typeof fetch;readCredentials?:()=>Promise<unknown>;file?:string;now?:()=>number;
  refreshCredentials?:()=>Promise<void>;
}
export interface ClaudeUsageContext {accountKey?:string;refreshCredentials?:()=>Promise<void>;}
interface Cache {schemaVersion:1;fingerprint:string;accountKey?:string;nextAttemptAt:number;renewalFailure?:boolean;status:ClaudeUsageStatus;}
const interval=300_000;
const globals=['five_hour','seven_day'];
const labels:Record<string,string>={five_hour:'5시간',seven_day:'주간 · 전체 모델',seven_day_fable:'주간 · Fable',seven_day_opus:'주간 Opus',seven_day_sonnet:'주간 Sonnet',seven_day_oauth_apps:'주간 OAuth 앱',seven_day_cowork:'주간 Cowork'};
function record(value:unknown):Record<string,unknown> {return value && typeof value==='object' && !Array.isArray(value)?value as Record<string,unknown>:{};}
function timestamp(value:unknown):string|null {
  if(typeof value!=='string'||!/(Z|[+-]\d\d:\d\d)$/i.test(value))return null;
  const parsed=Date.parse(value);return Number.isFinite(parsed)?new Date(parsed).toISOString():null;
}
function unavailable(note:string):ClaudeUsageStatus {return {state:'unknown',source:'claude_oauth_usage_unavailable',windows:[],selectedWindow:null,observedAt:null,stale:true,resetsAt:null,retryAfter:null,note};}

/** Accept only numeric utilization; scoped/model windows never exhaust the whole account. */
export function parseClaudeUsage(value:unknown,now=Date.now()):ClaudeUsageStatus {
  const windows:ClaudeUsageWindow[]=[];
  for(const [id,item] of Object.entries(record(value))){
    if(!/^five_hour$|^seven_day(?:_[a-z_]+)?$/.test(id))continue;
    const row=record(item),used=row.utilization;
    if(typeof used!=='number'||!Number.isFinite(used)||used<0||used>100)continue;
    windows.push({id,label:labels[id]??id,usedPercent:used,remainingPercent:100-used,resetsAt:timestamp(row.resets_at)});
  }
  // New official OAuth shape names model-scoped quotas in limits[].scope.model.
  // Do not infer model identity from opaque top-level keys or is_active.
  const limits=record(value).limits;
  if(Array.isArray(limits))for(const entry of limits){
    const row=record(entry),scope=record(row.scope),model=record(scope.model),used=row.percent;
    if(typeof used!=='number'||!Number.isFinite(used)||used<0||used>100)continue;
    let id:string|undefined;
    if(row.kind==='session'&&row.scope==null)id='five_hour';
    else if(row.kind==='weekly_all'&&row.scope==null)id='seven_day';
    else if(row.kind==='weekly_scoped'&&scope.surface==null&&(
      typeof model.display_name==='string'&&/^Fable(?:\s+\d+(?:\.\d+)*)?$/i.test(model.display_name.trim())||
      typeof model.id==='string'&&/^claude-fable(?:-|$)/i.test(model.id)))id='seven_day_fable';
    if(!id)continue;
    const window={id,label:labels[id],usedPercent:used,remainingPercent:100-used,resetsAt:timestamp(row.resets_at)};
    const index=windows.findIndex(w=>w.id===id);if(index>=0)windows[index]=window;else windows.push(window);
  }
  const globalWindows=windows.filter(w=>globals.includes(w.id));
  const selected=[...globalWindows].sort((a,b)=>b.usedPercent-a.usedPercent)[0];
  const exhausted=globalWindows.filter(w=>w.usedPercent>=100&&(w.resetsAt===null||Date.parse(w.resetsAt)>now));
  const fresh=(w:ClaudeUsageWindow)=>w.resetsAt!==null&&Date.parse(w.resetsAt)>now;
  const allValid=globals.every(id=>globalWindows.some(w=>w.id===id&&fresh(w)));
  const state=exhausted.length?'exhausted':allValid?'available':'unknown';
  const resetsAt=state==='exhausted'
    ? exhausted.every(fresh)?new Date(Math.max(...exhausted.map(w=>Date.parse(w.resetsAt!)))).toISOString():null
    : selected?.resetsAt??null;
  return {state,source:'claude_oauth_usage',windows,selectedWindow:selected?.id??null,observedAt:new Date(now).toISOString(),stale:!allValid,
    ...(selected?{usedPercent:selected.usedPercent,remainingPercent:selected.remainingPercent}:{}),resetsAt,retryAfter:null,
    ...(state==='exhausted'?{limitKind:'quota_exhausted' as const}:{}),
    ...(!allValid?{note:'One or more global usage windows are missing or have an unconfirmed/expired reset.'}:{})};
}

/** Read-only OAuth telemetry. No inference request, refresh token, or API-key fallback. */
export class ClaudeUsageReader {
  private readonly fetcher:typeof fetch;private readonly clock:()=>number;private readonly file:string;
  private readonly credentials:()=>Promise<unknown>;private readonly refreshCredentials?:()=>Promise<void>;
  private memory?:Cache;private readonly pending=new Map<string,Promise<ClaudeUsageStatus>>();
  constructor(options:ClaudeUsageOptions={}) {
    this.fetcher=options.fetch??fetch;this.clock=options.now??Date.now;
    this.file=options.file??path.join(process.env.AGENT_MCP_STATE_DIR??path.join(os.homedir(),'.agent-acp-mcp'),'claude-usage.json');
    this.credentials=options.readCredentials??(async()=>JSON.parse(await fs.readFile(path.join(process.env.CLAUDE_CONFIG_DIR??path.join(os.homedir(),'.claude'),'.credentials.json'),'utf8')));
    this.refreshCredentials=options.refreshCredentials;
  }
  get(context:ClaudeUsageContext={}):Promise<ClaudeUsageStatus> {
    // Only a digest supplied by verified auth status may link rotated tokens.
    const accountKey=/^[a-f0-9]{64}$/.test(context.accountKey??'')?context.accountKey:undefined;
    const key=accountKey??'';
    const active=this.pending.get(key);if(active)return active;
    const pending=this.read({accountKey,refreshCredentials:context.refreshCredentials??this.refreshCredentials})
      .catch(()=>unavailable('Usage telemetry could not be read.')).finally(()=>{this.pending.delete(key);});
    this.pending.set(key,pending);return pending;
  }
  private matches(cache:Cache,fingerprint:string,accountKey?:string):boolean {
    if(cache.accountKey&&accountKey&&cache.accountKey!==accountKey)return false;
    if(cache.fingerprint===fingerprint)return !cache.accountKey||!accountKey||cache.accountKey===accountKey;
    return !!accountKey&&cache.accountKey===accountKey;
  }
  private async cache(fingerprint:string,accountKey?:string):Promise<Cache|undefined> {
    let disk:Cache|undefined;
    try {
      const candidate=JSON.parse(await fs.readFile(this.file,'utf8')) as Cache;
      if(candidate.schemaVersion===1&&this.matches(candidate,fingerprint,accountKey)&&Number.isFinite(candidate.nextAttemptAt)&&Array.isArray(candidate.status?.windows))disk=candidate;
    } catch {}
    const memory=this.memory&&this.matches(this.memory,fingerprint,accountKey)?this.memory:undefined;
    return !disk?memory:memory&&memory.nextAttemptAt>disk.nextAttemptAt?memory:disk;
  }
  private cachedStatus(cache:Cache):ClaudeUsageStatus {
    const s=cache.status;
    const expired=s.windows.some(w=>globals.includes(w.id)&&w.resetsAt!==null&&Date.parse(w.resetsAt)<=this.clock());
    if(expired)return {...s,state:'unknown',source:'claude_oauth_usage_cache',stale:true,limitKind:undefined,note:'Cached usage window reset has passed; awaiting telemetry refresh.'};
    return {...s,source:s.source==='claude_oauth_usage'?'claude_oauth_usage_cache':s.source};
  }
  private stale(cache:Cache|undefined,note:string):ClaudeUsageStatus {
    return cache?{...this.cachedStatus(cache),state:'unknown',source:'claude_oauth_usage_cache',stale:true,limitKind:undefined,note}:unavailable(note);
  }
  private async credential():Promise<{token?:string;fingerprint?:string;expired:boolean;scopeValid:boolean}> {
    try {
      const oauth=record(record(await this.credentials()).claudeAiOauth);
      const token=oauth.accessToken;
      if(typeof token!=='string'||!token)return {expired:false,scopeValid:false};
      return {token,fingerprint:createHash('sha256').update(token).digest('hex'),
        expired:typeof oauth.expiresAt==='number'&&oauth.expiresAt<=this.clock(),
        scopeValid:oauth.scopes===undefined||Array.isArray(oauth.scopes)&&oauth.scopes.includes('user:profile')};
    }catch{return {expired:false,scopeValid:false};}
  }
  private async renew(refresh?:()=>Promise<void>):Promise<boolean> {
    if(!refresh)return false;
    try{await refresh();return true;}catch{return false;}
  }
  private async save(cache:Cache) {
    this.memory=cache;
    const temporary=`${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {await fs.mkdir(path.dirname(this.file),{recursive:true});await fs.writeFile(temporary,JSON.stringify(cache),'utf8');await fs.rename(temporary,this.file);} catch {await fs.unlink(temporary).catch(()=>undefined);}
  }
  private async lock():Promise<fs.FileHandle|undefined> {
    try {await fs.mkdir(path.dirname(this.file),{recursive:true});}catch{return undefined;}
    const started=Date.now();
    while(Date.now()-started<17_000){
      try{return await fs.open(`${this.file}.lock`,'wx');}catch(error){
        if((error as NodeJS.ErrnoException).code!=='EEXIST')return undefined;
        try{const stat=await fs.stat(`${this.file}.lock`);if(Date.now()-stat.mtimeMs>120_000)await fs.unlink(`${this.file}.lock`);}catch{}
        await new Promise(resolve=>setTimeout(resolve,40));
      }
    }
    return undefined;
  }
  private async read(context:ClaudeUsageContext):Promise<ClaudeUsageStatus> {
    let credential=await this.credential();
    if(!credential.token||!credential.fingerprint)return unavailable('Claude subscription credentials are unavailable.');
    if(!credential.scopeValid)return unavailable('Claude subscription credentials do not include the usage profile scope.');
    let cached=await this.cache(credential.fingerprint,context.accountKey);
    if(cached&&cached.fingerprint===credential.fingerprint&&cached.nextAttemptAt>this.clock()&&(!credential.expired||cached.renewalFailure))
      return credential.expired?this.stale(cached,'Claude subscription credentials have expired; renewal is cooling down.'):this.cachedStatus(cached);
    const handle=await this.lock();
    if(!handle)return this.stale(cached,'Usage telemetry refresh is busy or its cache is unavailable.');
    try {
      // Another process may have renewed the credential while this one waited.
      credential=await this.credential();
      if(!credential.token||!credential.fingerprint)return unavailable('Claude subscription credentials are unavailable.');
      if(!credential.scopeValid)return unavailable('Claude subscription credentials do not include the usage profile scope.');
      cached=await this.cache(credential.fingerprint,context.accountKey)
        ??(cached&&this.matches(cached,credential.fingerprint,context.accountKey)?cached:undefined);
      if(cached&&cached.fingerprint===credential.fingerprint&&cached.nextAttemptAt>this.clock()&&(!credential.expired||cached.renewalFailure))
        return credential.expired?this.stale(cached,'Claude subscription credentials have expired; renewal is cooling down.'):this.cachedStatus(cached);
      const now=this.clock();let nextAttemptAt=now+interval;let status:ClaudeUsageStatus;
      let renewed=false,renewalFailure=false;
      if(credential.expired){
        renewed=true;
        const previousFingerprint=credential.fingerprint;
        const renewalAccepted=await this.renew(context.refreshCredentials);
        credential=await this.credential();
        if(!credential.token||!credential.fingerprint)
          return unavailable('Claude subscription credentials are unavailable.');
        if(!renewalAccepted&&credential.fingerprint!==previousFingerprint)
          return unavailable('Claude subscription account changed during credential renewal.');
        cached=await this.cache(credential.fingerprint,context.accountKey)
          ??(cached&&this.matches(cached,credential.fingerprint,context.accountKey)?cached:undefined);
        if(credential.expired||!credential.scopeValid){
          renewalFailure=true;
          status=this.stale(cached,'Claude subscription credentials have expired; renewal did not restore usage access.');
          status={...status,retryAfter:null,nextRefreshAt:new Date(nextAttemptAt).toISOString()};
          const fingerprint=credential.fingerprint??cached?.fingerprint;
          if(fingerprint)await this.save({schemaVersion:1,fingerprint,accountKey:context.accountKey,nextAttemptAt,renewalFailure,status});
          return status;
        }
      }
      try {
        const fetchUsage=()=>this.fetcher('https://api.anthropic.com/api/oauth/usage',{method:'GET',headers:{Authorization:`Bearer ${credential.token}`,'anthropic-beta':'oauth-2025-04-20','User-Agent':'AgentMonitor/1.0'},redirect:'error',signal:AbortSignal.timeout(15_000)});
        let response=await fetchUsage();
        if(response.status===401&&!renewed){
          renewed=true;
          const previousFingerprint=credential.fingerprint;
          const renewalAccepted=await this.renew(context.refreshCredentials);
          const refreshed=await this.credential();
          if(!refreshed.token||!refreshed.fingerprint)
            return unavailable('Claude subscription credentials are unavailable.');
          if(!renewalAccepted&&refreshed.fingerprint!==previousFingerprint)
            return unavailable('Claude subscription account changed during credential renewal.');
          credential=refreshed;
          cached=await this.cache(refreshed.fingerprint,context.accountKey)
            ??(cached&&this.matches(cached,refreshed.fingerprint,context.accountKey)?cached:undefined);
          if(renewalAccepted&&!refreshed.expired&&refreshed.scopeValid){
            response=await fetchUsage();
          }else renewalFailure=true;
        }
        if(response.ok)status=parseClaudeUsage(await response.json(),now);
        else {
          if(renewed)renewalFailure=true;
          const retry=response.headers.get('retry-after');
          const retryMs=retry===null?NaN:/^\d+(?:\.\d+)?$/.test(retry)?now+Number(retry)*1000:Date.parse(retry);
          if(Number.isFinite(retryMs)&&retryMs<=8.64e15)nextAttemptAt=Math.max(nextAttemptAt,retryMs);
          const note=response.status===401||response.status===403?'Claude usage access was rejected; verify subscription login and profile scope.':response.status===429?'Claude usage endpoint is rate limited; this does not indicate model quota exhaustion.':`Claude usage endpoint returned HTTP ${response.status}.`;
          status=this.stale(cached,note);
        }
      }catch{if(renewed)renewalFailure=true;status=this.stale(cached,'Claude usage request failed or timed out.');}
      status={...status,retryAfter:null,nextRefreshAt:new Date(nextAttemptAt).toISOString()};
      await this.save({schemaVersion:1,fingerprint:credential.fingerprint!,accountKey:context.accountKey,nextAttemptAt,renewalFailure,status});return status;
    } finally {await handle.close().catch(()=>undefined);await fs.unlink(`${this.file}.lock`).catch(()=>undefined);}
  }
}
const defaultReader=new ClaudeUsageReader();
export function getClaudeUsage(context:ClaudeUsageContext={}):Promise<ClaudeUsageStatus>{return defaultReader.get(context);}
