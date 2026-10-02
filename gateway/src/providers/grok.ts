import path from 'node:path';
import {unavailableCatalog} from '../model-catalog.js';
import {runGrok} from '../acp.js';
import {getWeeklyUsage,getGrokAccountStatus} from '../billing.js';
import {ensureHealth} from '../health.js';
import {providerEnabled,modelPolicy,effortPolicy} from '../config.js';
import {childEnv,grokLaunch,resetGrokLaunch} from '../runtime.js';
import {home,runCommand} from '../process.js';
import {QuotaCache} from '../quota-cache.js';
import {classifyProviderError, type LimitClassification} from '../limits.js';
import type {AgentKind,ProviderAdapter,ProviderRunResult,ProviderStatus,RunHooks,RunInput,QuotaStatus} from '../types.js';

const kindMap:Record<AgentKind,string>={agent_ask:'grok_ask',agent_review:'grok_review',agent_investigate:'grok_investigate',agent_implement:'grok_implement'};
const quota=new QuotaCache(path.join(process.env.AGENT_MCP_STATE_DIR??path.join(home,'.agent-acp-mcp'),'grok-quota.json'));

export function quotaFromWeekly(value:any){
  if(value?.status!=='available')return {state:'unknown' as const,source:value?.source??'unavailable',note:value?.refreshError};
  const used=typeof value.creditUsagePercent==='number'?value.creditUsagePercent:undefined;
  const remaining=typeof value.remainingPercent==='number'?value.remainingPercent:undefined;
  if(value.stale||value.fresh===false||(used===undefined&&remaining===undefined))return {state:'unknown' as const,source:value.source??'unavailable',note:'No current numeric billing snapshot is available.'};
  const exhausted=(remaining!==undefined&&remaining<=0)||(used!==undefined&&used>=100);
  return {state:exhausted?'exhausted' as const:'available' as const,source:value.source??'grok_billing',usedPercent:used,remainingPercent:remaining,resetsAt:value.currentPeriod!=='unavailable'?value.currentPeriod?.end:undefined,note:value.stale?'Billing source is stale/last-known.':undefined};
}

/** Preserve an observed runtime block even when billing's live snapshot lags. */
export function overlayGrokQuota(live:QuotaStatus,cached:QuotaStatus|undefined):QuotaStatus {
  if(!cached||cached.state!=='exhausted')return live;
  return {
    ...live,
    ...cached,
    usedPercent:live.usedPercent??cached.usedPercent,
    remainingPercent:live.remainingPercent??cached.remainingPercent,
    // Billing's period end is not a rate-limit reset. Keep an unknown runtime
    // rate reset unknown; its durable retry cooldown remains authoritative.
    resetsAt:cached.limitKind==='rate_limited'?(cached.resetsAt??null):(cached.resetsAt??live.resetsAt),
    retryAfter:cached.retryAfter??live.retryAfter,
    limitKind:cached.limitKind??live.limitKind,
    note:[cached.note,live.note].filter(Boolean).join(' ')||undefined,
  };
}

export function classifyGrokRunFailure(value:Pick<ProviderRunResult,'error'|'errorKind'> & Record<string,unknown>,now=Date.now()):LimitClassification {
  const classified=classifyProviderError({error:value.error,reason:value.stopReason,code:value.errorKind},now);
  // ACP has already distinguished lifecycle and connection failures. Do not
  // turn those into a billing result merely because the text is ambiguous.
  if(value.errorKind==='cancelled'||value.errorKind==='deadline_exceeded'||value.errorKind==='connection_error')return {errorKind:value.errorKind};
  const limitKind=value.limitKind==='quota_exhausted'||value.limitKind==='rate_limited'?value.limitKind:undefined;
  if(limitKind)return {errorKind:typeof value.errorKind==='string'?value.errorKind:limitKind,limitKind,resetsAt:typeof value.resetsAt==='string'?value.resetsAt:null,retryAfter:typeof value.retryAfter==='string'?value.retryAfter:null};
  if(value.errorKind==='quota_exhausted'||value.errorKind==='rate_limited')return {...classified,errorKind:value.errorKind,limitKind:value.errorKind};
  return classified;
}

export class GrokProvider implements ProviderAdapter{
 readonly name='grok' as const;
 async models(force=false){if(!providerEnabled('grok'))return unavailableCatalog('grok','Provider disabled.');const health=await ensureHealth(force);return health.modelCatalog??unavailableCatalog('grok',health.reason??'ACP model catalog unavailable.',health.version);}
 async status(force=false):Promise<ProviderStatus>{
  const enabled=providerEnabled('grok');const [health,cached]=enabled?await Promise.all([ensureHealth(force),quota.get('grok')]):[undefined,undefined];let weekly=health?.auth==='cached_token'?await getWeeklyUsage(force):undefined;
  // A separate process can record a runtime limit while billing still serves
  // its 60-second snapshot. Re-fetch once when that observed limit is newer
  // than the billing snapshot itself, not when we last read that snapshot.
  const snapshotAt=weekly?.status==='available'?Date.parse(weekly.timestamp):0;
  if(!force&&health?.auth==='cached_token'&&await quota.needsRefresh('grok',Number.isFinite(snapshotAt)?snapshotAt:0))weekly=await getWeeklyUsage(true);
  const live=!enabled?{state:'unknown' as const,source:'disabled'}:weekly?quotaFromWeekly(weekly):{state:'unknown' as const,source:'health_unavailable'};
  return {provider:'grok',enabled,available:!!health?.healthy,authenticated:health?.auth==='cached_token',subscriptionAuth:health?.auth==='cached_token',...(enabled&&health?.auth==='cached_token'?{account:await getGrokAccountStatus(false)}:{}),version:health?.version??'unavailable',modelPolicy:modelPolicy('grok'),effortPolicy:effortPolicy('grok'),modelCatalog:health?.modelCatalog,quota:overlayGrokQuota(live,cached),reason:health?.reason};
 }
 async run(kind:AgentKind,input:RunInput,signal?:AbortSignal,hooks?:RunHooks):Promise<ProviderRunResult>{
  const observedAt=Date.now();const value=await runGrok(kindMap[kind],input,signal,hooks);const classification=classifyGrokRunFailure(value);
  // Runtime telemetry must never hide the ACP result (including partial text,
  // session id, and usage) when state persistence is unavailable.
  if(value.error&&classification.limitKind){await quota.markLimited('grok',classification,'Grok ACP reported a provider limit.').catch(()=>{});}
  else if(!value.error)await quota.markAvailable('grok','runtime_success',observedAt).catch(()=>{});
  return {...value,errorKind:value.error&&['MODEL_SELECTION_REQUIRED','FIXED_SETTING_CONFLICT','SELECTION_REASON_REQUIRED','UNSUPPORTED_MODEL_OR_EFFORT'].includes(value.errorKind??'')?value.errorKind:value.error?classification.errorKind:value.errorKind};
 }
 async cliStatus(){const status=await this.status(false);return status;}
 async update(){
  if(!providerEnabled('grok'))return {provider:'grok',updated:false,reason:'disabled'};
  try{
   const r=await runCommand(await grokLaunch(),['update'],{env:childEnv,timeoutMs:180000});resetGrokLaunch();
   if(r.code!==0)return {provider:'grok',updated:false,error:r.timedOut?'Grok update timed out':`Grok update exited with code ${r.code}`,stdout:r.stdout.trim(),stderr:r.stderr.trim()};
   const health=await ensureHealth(true);return {provider:'grok',updated:health.healthy,stdout:r.stdout.trim(),stderr:r.stderr.trim(),health};
  }
  catch(e){return {provider:'grok',updated:false,error:(e as Error).message};}
 }
}

