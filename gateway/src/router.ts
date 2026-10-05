import type {HostDetection} from './host.js';
import {isDelegatedProcess} from './process.js';
import {allowSelfProvider} from './config.js';
import {validateRunSettings,resolveProviderSettings,validateCatalog,withSelection,selectionFailure} from './model-settings.js';
import {unavailableCatalog} from './model-catalog.js';
import {modelPolicy,effortPolicy} from './config.js';
import type {AgentKind,ProviderAdapter,ProviderName,ProviderRunResult,ProviderStatus,RunHooks,RunInput,SkippedProvider} from './types.js';

const names:ProviderName[]=['grok','claude','codex'];

export type ProviderSelection={mode:'auto'|'explicit';requested:ProviderName[]};
export function parseProviderSpec(value:string|undefined):ProviderSelection{
  const raw=(value??'auto').trim().toLowerCase();
  if(!raw||raw==='auto')return {mode:'auto',requested:[]};
  const parts=[...new Set(raw.split(',').map(x=>x.trim()).filter(Boolean))];
  if(parts.includes('auto'))throw Error('provider="auto" cannot be combined with explicit providers');
  const invalid=parts.filter(x=>!names.includes(x as ProviderName));if(invalid.length)throw Error(`Unknown provider(s): ${invalid.join(', ')}`);
  if(!parts.length)throw Error('At least one provider is required');
  return {mode:'explicit',requested:parts as ProviderName[]};
}

export function randomNonEmptySubset<T>(values:T[],rng:()=>number=Math.random):T[]{
  if(!values.length)return [];
  // Every non-empty subset has equal probability (provider count is intentionally small).
  const combinations=(2**values.length)-1;
  const mask=1+Math.floor(rng()*combinations);
  return values.filter((_,index)=>(mask&(1<<index))!==0);
}

function blockedReason(status:ProviderStatus|undefined,host:HostDetection,provider:ProviderName,allowSelf=false):string|undefined{
  if(isDelegatedProcess())return 'nested_delegation_blocked';
  if(host.host==='unknown')return 'host_unknown';
  if(provider===host.host&&!allowSelf)return 'self_provider';
  if(!status)return 'status_unavailable';
  if(!status.enabled)return 'disabled';
  if(!status.available)return 'unavailable';
  if(status.authenticated===false)return 'auth_failed';
  if(status.authenticated!==true)return 'auth_unknown';
  if(status.subscriptionAuth===false)return 'non_subscription_auth';
  if(status.subscriptionAuth!==true)return 'subscription_auth_unknown';
  if(status.quota.state==='exhausted')return status.quota.limitKind??'quota_exhausted';
  if(status.quota.limitKind==='rate_limited'&&status.quota.retryAfter&&Date.parse(status.quota.retryAfter)>Date.now())return 'rate_limited';
  return undefined;
}

export class AgentRouter{
  private map=new Map<ProviderName,ProviderAdapter>();
  constructor(adapters:ProviderAdapter[],private options:{rng?:()=>number;now?:()=>number}={}){for(const adapter of adapters)this.map.set(adapter.name,adapter);}
  private adapter(name:ProviderName){const value=this.map.get(name);if(!value)throw Error(`Provider adapter unavailable: ${name}`);return value;}
  async statuses(force=false){
    const entries=await Promise.all(names.map(async name=>{try{return [name,await this.adapter(name).status(force)] as const;}catch(e){return [name,{provider:name,enabled:true,available:false,authenticated:'unknown' as const,version:'unavailable',modelPolicy:'unknown',effortPolicy:'unknown',quota:{state:'unknown' as const,source:'status_error'},reason:(e as Error).message}] as const;}}));
    return Object.fromEntries(entries) as Record<ProviderName,ProviderStatus>;
  }
  async status(host:HostDetection,force=false,override?:boolean){
    const allowSelf=allowSelfProvider(override);
    const statuses=await this.statuses(force);const providers:any={};
    const catalogs=Object.fromEntries(await Promise.all(names.map(async name=>[name,statuses[name].enabled?await this.catalog(name,force):unavailableCatalog(name,'Provider disabled.')])));
    for(const name of names){const status=statuses[name];const reason=blockedReason(status,host,name,allowSelf);providers[name]={...status,modelCatalog:catalogs[name],quota:{...status.quota,resetsAt:status.quota.resetsAt??null,retryAfter:status.quota.retryAfter??null,limitKind:status.quota.limitKind??(status.quota.state==='exhausted'?'quota_exhausted':null)},callable:!reason,blocked_reason:reason??null,selfProvider:name===host.host};}
    return {server:'agent-acp-mcp',version:'2.3.1',host,allow_self_provider:allowSelf,self_provider_policy_source:typeof override==='boolean'?'call':'environment_default',auto_excludes_self:!allowSelf,providers};
  }
  async plan(spec:string|undefined,host:HostDetection,forceStatus=false,override?:boolean){
    if(isDelegatedProcess())throw Error('NESTED_DELEGATION_BLOCKED: delegated provider sessions cannot invoke this gateway');
    if(host.host==='unknown')throw Error(`HOST_UNKNOWN: MCP client could not be mapped to codex/claude/grok (client=${host.clientName}). Self-provider exclusion cannot be guaranteed.`);
    const selection=parseProviderSpec(spec);const skipped:SkippedProvider[]=[];
    const allowSelf=allowSelfProvider(override);
    const requested=selection.mode==='auto'?names:selection.requested;
    const statuses={} as Record<ProviderName,ProviderStatus>;
    await Promise.all(requested.map(async name=>{
      if(name===host.host&&!allowSelf)return;
      try{statuses[name]=await this.adapter(name).status(forceStatus);}catch(e){statuses[name]={provider:name,enabled:true,available:false,authenticated:'unknown',version:'unavailable',modelPolicy:'unknown',effortPolicy:'unknown',quota:{state:'unknown',source:'status_error'},reason:(e as Error).message};}
    }));
    const eligible:ProviderName[]=[];
    for(const name of requested){const reason=blockedReason(statuses[name],host,name,allowSelf);if(reason)skipped.push({provider:name,reason});else eligible.push(name);}
    if(!eligible.length)throw Error(`NO_CALLABLE_PROVIDER: ${JSON.stringify({host:host.host,requested:selection.mode==='auto'?'auto':selection.requested,skipped})}`);
    const selected=selection.mode==='auto'?randomNonEmptySubset(eligible,this.options.rng):eligible;
    return {selection,statuses,eligible,selected,skipped,allowSelf};
  }
  async models(spec='grok,claude,codex',force=false){
    const parsed=parseProviderSpec(spec);if(parsed.mode!=='explicit')throw Error('agent_models requires explicit provider names; routing auto is not supported');
    const providers=Object.fromEntries(await Promise.all(parsed.requested.map(async name=>[name,{modelPolicy:modelPolicy(name),effortPolicy:effortPolicy(name),catalog:await this.catalog(name,force)}])));
    return {providers,selectionPolicy:'auto requires a concrete parent value and selection_reason per call; fixed configuration rejects conflicting values',discoveryOnly:true};
  }
  private async catalog(name:ProviderName,force=false){try{return await this.adapter(name).models?.(force)??unavailableCatalog(name);}catch(error){return unavailableCatalog(name,`Catalog discovery failed: ${error instanceof Error?error.message:String(error)}; support remains unverified.`);}}
  async preflight(input:RunInput,host:HostDetection){
    validateRunSettings(input);
    const plan=await this.plan(input.provider,host,false,input.allow_self_provider);
    // Validate the entire auto retry pool before the first provider can write.
    const candidates=plan.selection.mode==='auto'?plan.eligible:plan.selected;
    const settings=new Map(candidates.map(name=>[name,resolveProviderSettings(name,input)]));
    for(const name of candidates)validateCatalog(name,settings.get(name)!,await this.catalog(name));
    return {plan,settings};
  }
  async run(kind:AgentKind,input:RunInput,host:HostDetection,signal?:AbortSignal,hooks?:RunHooks){
    validateRunSettings(input);
    const now=this.options.now??Date.now;
    const deadlineAt=Math.min(input.deadlineAt??Infinity,now()+(input.max_runtime_minutes??120)*60_000);
    const controller=new AbortController();let stopped:'cancelled'|'deadline_exceeded'|undefined;
    const stop=(kind:'cancelled'|'deadline_exceeded')=>{if(!stopped){stopped=kind;controller.abort(new Error(kind));}};
    const onAbort=()=>stop('cancelled');signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();
    const timer=setTimeout(()=>stop('deadline_exceeded'),Math.max(0,deadlineAt-now()));
    const check=()=>{if(!stopped&&now()>=deadlineAt)stop('deadline_exceeded');return stopped;};
    try{
      if(check())throw Error(stopped!);
      const {plan,settings}=await this.preflight(input,host);
      if(input.session_id&&(plan.selection.mode==='auto'||plan.selected.length!==1||plan.selected[0]!=='grok'))throw Error('session_id continuation is supported only with provider="grok"');
      const executed:ProviderName[]=[],notExecuted:SkippedProvider[]=[];
      const invoke=async(name:ProviderName):Promise<ProviderRunResult|undefined>=>{
        const stopReason=check();if(stopReason){notExecuted.push({provider:name,reason:stopReason});return;}
        executed.push(name);let result:ProviderRunResult;
        try{result=await this.adapter(name).run(kind,{...input,deadlineAt,max_runtime_minutes:(deadlineAt-now())/60_000},controller.signal,{onActivity:event=>{try{hooks?.onActivity?.({provider:name,...event});}catch{}}});}
        catch(e){result=selectionFailure(name,e,settings.get(name)!.selection);}
        result=withSelection(result,settings.get(name)!.selection);
        if(check())result={...result,providerError:result.error??null,providerErrorKind:result.errorKind??null,error:stopped==='cancelled'?'Cancelled':'Task runtime deadline exceeded',errorKind:stopped};
        if(kind==='agent_implement'&&result.error)result={...result,handoff:{requiresWorkspaceReview:true,cwd:input.cwd,allowedPaths:input.allowed_paths??[input.cwd],kind,reason:result.errorKind??'task_error',sessionId:result.sessionId??'unavailable',nextAction:'review_workspace_before_continuing',changes:'unverified'}};
        return {...result,execution:executionEvidence(result)};
      };
      const batch=async(selected:ProviderName[])=>{
        const results:ProviderRunResult[]=[];
        if(kind==='agent_implement'){
          for(let i=0;i<selected.length;i++){
            const result=await invoke(selected[i]);if(result)results.push(result);
            if(!result||result.error){for(const provider of selected.slice(i+1))notExecuted.push({provider,reason:check()??'partial_work_review_required'});break;}
          }
        }else{for(const result of await Promise.all(selected.map(invoke)))if(result)results.push(result);}
        return results;
      };
      let results=await batch(plan.selected);let retryCount=0;
      const limitFailure=(result:ProviderRunResult)=>!!result.error&&['quota_exhausted','rate_limited'].includes(result.errorKind??'');
      if(kind!=='agent_implement'&&plan.selection.mode==='auto'&&results.length>0&&results.every(limitFailure)&&!check()){
        const remaining=plan.eligible.filter(name=>!executed.includes(name));
        const eligible:ProviderName[]=[];
        for(const provider of remaining){
          if(check()){notExecuted.push({provider,reason:stopped!});continue;}
          let status:ProviderStatus|undefined;try{status=await this.adapter(provider).status(true);}catch{}
          const reason=check()??blockedReason(status,host,provider,plan.allowSelf);
          if(reason)notExecuted.push({provider,reason});else eligible.push(provider);
        }
        if(eligible.length&&!check()){
          const retry=randomNonEmptySubset(eligible,this.options.rng);retryCount=1;plan.selected.push(...retry);results.push(...await batch(retry));
        }
      }
      const succeeded=results.filter(r=>!r.error),failed=results.filter(r=>r.error);
      const incomplete=failed.length>0||notExecuted.length>0;
      const errorKind=stopped??(failed.length&&failed.every(r=>r.errorKind===failed[0].errorKind)?failed[0].errorKind:'task_error');
      return {
        routing:plan.selection.mode,host:host.host,client:{name:host.clientName,title:host.clientTitle??null,version:host.clientVersion??null},
        requested:plan.selection.mode==='auto'?'auto':plan.selection.requested,eligible:plan.eligible,selected:plan.selected,executed,
        allow_self_provider:plan.allowSelf,self_provider_policy_source:typeof input.allow_self_provider==='boolean'?'call':'environment_default',selfProviderExecuted:executed.includes(host.host as ProviderName),
        skipped:[...plan.skipped,...notExecuted],results,retryCount,deadlineAt:new Date(deadlineAt).toISOString(),
        outcome:incomplete?(succeeded.length?'partial_success':'failed'):succeeded.length?'success':'failed',
        successCount:succeeded.length,failureCount:failed.length,
        outcomeMeaning:'provider_turn_execution_only',
        completionCriteria:{status:'unverified',requiresParentReview:true},
        handoff:kind==='agent_implement'?failed.find(r=>r.handoff)?.handoff??null:null,
        error:incomplete||!succeeded.length?(failed.map(r=>`${r.provider}: ${r.error}`).join(' | ')||stopped||'NO_PROVIDER_RESULT'):null,
        errorKind:incomplete||!succeeded.length?errorKind:null,
      };
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);}
  }
  async cliUpdate(spec:string,host:HostDetection){
    if(isDelegatedProcess())throw Error('NESTED_DELEGATION_BLOCKED: delegated provider sessions cannot update CLIs');
    if(host.host==='unknown')throw Error(`HOST_UNKNOWN: cannot safely update providers for client ${host.clientName}`);
    const selection=parseProviderSpec(spec);if(selection.mode==='auto')throw Error('agent_cli_update requires explicit provider names; provider="auto" is not allowed');
    const updated:any[]=[];const skipped:SkippedProvider[]=[];
    for(const name of selection.requested){
      if(name===host.host){skipped.push({provider:name,reason:'self_provider_update_blocked'});continue;}
      const status=await this.adapter(name).status(false);if(!status.enabled){skipped.push({provider:name,reason:'disabled'});continue;}
      updated.push(await this.adapter(name).update());
    }
    return {host:host.host,requested:selection.requested,updated,skipped};
  }
}
import {executionEvidence} from './execution-evidence.js';
