import path from 'node:path';
import {spawnPlan} from '../process.js';
import {home,resolveExecutable,runCommand,safeChildEnv,findExecutableInChildDirs,type LaunchCommand} from '../process.js';
import {resolveNpmLaunch,type OfficialNpmPackage} from '../npm-launch.js';
import {providerEnabled,modelPolicy,effortPolicy} from '../config.js';
import {resolveProviderSettings,validateCatalog,withSelection,selectionFailure} from '../model-settings.js';
import {CatalogCache,codexCatalog,unavailableCatalog} from '../model-catalog.js';
import {buildPrompt} from '../prompt.js';
import {readCodexStatus,readCodexModels} from '../codex-app-server.js';
import {accountStatus} from '../account.js';
import {readCodexSessionTelemetry,codexRuntimeMetadata} from '../codex-session.js';
import {QuotaCache} from '../quota-cache.js';
import {classifyProviderError} from '../limits.js';
import {observedExitCode,observedOutput} from '../command-telemetry.js';
import type {CommandExecution} from '../command-telemetry.js';
import type {AgentKind,ProviderAdapter,ProviderRunResult,ProviderStatus,RunHooks,RunInput,QuotaStatus} from '../types.js';

const modelCache=new CatalogCache();
let cachedExecutable:LaunchCommand|undefined;let statusCache:{at:number,value:ProviderStatus}|undefined;let observedRuntimeBlock=false;
const quota=new QuotaCache(path.join(process.env.AGENT_MCP_STATE_DIR??path.join(home,'.agent-acp-mcp'),'codex-quota.json'));
export const codexNpmPackage:OfficialNpmPackage={name:'@openai/codex',binNames:['codex'],label:'Codex',defaultMinimumNode:16};
/** --ignore-user-config also removes windows.sandbox. Without an explicit
 * Windows implementation, CLI 0.159.2 can downgrade workspace-write to read-only. */
export function codexSandboxArgs(writable:boolean,platform:NodeJS.Platform=process.platform,env:NodeJS.ProcessEnv=process.env):string[]{
 const mode=writable?(env.CODEX_IMPLEMENT_SANDBOX??'workspace-write'):'read-only';
 if(!['workspace-write','danger-full-access','read-only'].includes(mode))throw Error('CODEX_IMPLEMENT_SANDBOX must be workspace-write, danger-full-access or read-only');
 const args=['--sandbox',mode];
 if(platform==='win32'&&mode!=='danger-full-access'){
  const implementation=env.CODEX_WINDOWS_SANDBOX??'unelevated';
  if(implementation!=='unelevated'&&implementation!=='elevated')throw Error('CODEX_WINDOWS_SANDBOX must be unelevated or elevated');
  args.push('-c',`windows.sandbox="${implementation}"`);
 }
 return args;
}
// One resolved launcher serves status, app-server telemetry and run alike.
async function exe(){
 if(cachedExecutable)return cachedExecutable;
 const common=[path.join(home,'AppData','Local','Programs','OpenAI','Codex','bin','codex.exe'),path.join(home,'.local','bin',process.platform==='win32'?'codex.exe':'codex')];
 const direct=await resolveExecutable(process.env.CODEX_CLI??process.env.CODEX_CLI_PATH,['codex'],common);if(direct)return cachedExecutable=await resolveNpmLaunch(direct,codexNpmPackage);
 if(process.platform==='win32'){
   const local=process.env.LOCALAPPDATA??path.join(home,'AppData','Local');
   const runtime=await findExecutableInChildDirs(path.join(local,'OpenAI','Codex','bin'),'codex.exe');if(runtime)return cachedExecutable=runtime;
 }
 return undefined;
}
function finiteNumber(value:unknown):number|undefined{return typeof value==='number'&&Number.isFinite(value)?value:undefined;}
export function quotaFromRateLimits(value:any):QuotaStatus{
 const result=value?.rateLimitsByLimitId?.codex??value?.rateLimits??value;const windows=[result?.primary,result?.secondary].filter(Boolean);
 const usageWindows=windows.flatMap((window:any)=>{const usedPercent=finiteNumber(window?.usedPercent);return usedPercent===undefined?[]:[{usedPercent,resetsAt:finiteNumber(window?.resetsAt)}];});
 const selected=usageWindows.reduce<{usedPercent:number;resetsAt?:number}|undefined>((highest,window)=>!highest||window.usedPercent>highest.usedPercent?window:highest,undefined);
 const exhaustedWindows=usageWindows.filter(window=>window.usedPercent>=100);const reached=!!result?.rateLimitReachedType||value?.ordinaryUsageAllowed===false||exhaustedWindows.length>0;
 const knownAvailable=value?.ordinaryUsageAllowed===true||selected!==undefined;const state=reached?'exhausted':knownAvailable?'available':'unknown';
 let resetsAt=selected?.resetsAt;let note=result?.rateLimitReachedType?String(result.rateLimitReachedType):undefined;
 if(exhaustedWindows.length>1){const latest=exhaustedWindows.reduce<{usedPercent:number;resetsAt?:number}|undefined>((latest,window)=>window.resetsAt!==undefined&&(!latest||latest.resetsAt===undefined||window.resetsAt>latest.resetsAt)?window:latest,undefined);if(latest?.resetsAt!==undefined)resetsAt=latest.resetsAt;note=[note,latest?.resetsAt!==undefined?'multiple quota windows exhausted; resetsAt is the latest known exhausted-window reset.':'multiple quota windows exhausted; no exhausted-window reset is available.'].filter(Boolean).join(' ');}
 const quotaWindows=windows.flatMap((window:any)=>{
  const usedPercent=finiteNumber(window?.usedPercent),duration=finiteNumber(window?.windowDurationMins);
  if(usedPercent===undefined||(duration!==300&&duration!==10080))return [];
  const reset=finiteNumber(window?.resetsAt);const date=reset===undefined?null:new Date(reset*1000);
  return [{id:duration===300?'five_hour':'seven_day',label:duration===300?'5시간':'주간',usedPercent,remainingPercent:Math.max(0,100-usedPercent),resetsAt:date&&Number.isFinite(date.getTime())?date.toISOString():null}];
 });
 return {state,source:'codex_app_server',usedPercent:selected?.usedPercent,remainingPercent:selected?Math.max(0,100-selected.usedPercent):undefined,resetsAt,note,...(quotaWindows.length?{windows:quotaWindows}:{})};
}
function eventError(event:any,item:any){const value=event?.error??item?.error??event?.message??item?.message;if(typeof value==='string'&&value.trim())return value.trim();if(value&&typeof value==='object'){const message=value.message??value.detail??value.code;if(typeof message==='string'&&message.trim())return message.trim();return JSON.stringify(value);}return `Codex reported ${String(event?.type??item?.type??'an error')}`;}
function interruptionKind(timedOut:boolean,signal?:AbortSignal):string|undefined{
 if(timedOut)return 'deadline_exceeded';
 if(!signal?.aborted)return undefined;
 const reason=signal.reason;
 const message=typeof reason==='string'?reason:reason instanceof Error?reason.message:reason&&typeof reason==='object'?String((reason as any).errorKind??(reason as any).code??(reason as any).message??''):'';
 return /deadline|timeout/i.test(message)?'deadline_exceeded':'cancelled';
}
function parseEvents(stdout:string){
 const texts:string[]=[],seenTexts=new Set<string>();let threadId:string|undefined,usage:any='unavailable',terminalError:string|undefined,terminalEvidence:unknown,streamError:string|undefined,streamEvidence:unknown,completed=false,model:string|undefined,effort:string|undefined;
 const commands=new Map<string,CommandExecution>();let anonymousCommand=0;
 for(const line of stdout.split(/\r?\n/)){try{
  const event=JSON.parse(line);const item=event?.item;
  if(item?.type==='command_execution'&&['item.started','item.updated','item.completed'].includes(event?.type)){
   const id=typeof item.id==='string'?item.id:event.type==='item.completed'?`anonymous-${++anonymousCommand}`:undefined;
   if(id){
    let execution=commands.get(id);
    if(!execution&&typeof item.command==='string'&&item.command.trim()){
     execution={command:item.command,cwd:typeof item.cwd==='string'?item.cwd:null,exitCode:null,output:null,source:'codex_json'};
     commands.set(id,execution);
    }
    if(execution){
     if(typeof item.cwd==='string')execution.cwd=item.cwd;
     const exitCode=observedExitCode(item.exit_code,item.exitCode);if(exitCode!==null)execution.exitCode=exitCode;
     const output=observedOutput(item.aggregated_output??item.output);if(output!==null)execution.output=output;
    }
   }
  }
  if(event?.type==='thread.started'&&event.thread_id)threadId=String(event.thread_id);
  if(event?.type==='item.completed'&&item?.type==='agent_message'&&typeof item.text==='string'&&item.text.trim()&&!seenTexts.has(item.text)){seenTexts.add(item.text);texts.push(item.text);}
  if(typeof event?.model==='string')model=event.model;
  if(typeof (event?.reasoning_effort??event?.reasoningEffort??event?.effort)==='string')effort=event.reasoning_effort??event.reasoningEffort??event.effort;
  if(event?.usage!==undefined)usage=event.usage;else if(item?.usage!==undefined)usage=item.usage;
  if(event?.type==='turn.completed')completed=true;
  if(event?.type==='turn.failed'&&!terminalError){terminalError=eventError(event,item);terminalEvidence=event?.error??item?.error??event;}
  else if(event?.type==='error'||item?.type==='error'){
   const message=eventError(event,item),evidence=event?.error??item?.error??event;
   if(completed&&!terminalError){terminalError=message;terminalEvidence=evidence;}else if(!streamError){streamError=message;streamEvidence=evidence;}
  }
 }catch{/* A malformed line is not assistant text and must not become a fallback response. */}}
 return {text:texts.join('\n'),threadId,usage,error:terminalError??(completed?undefined:streamError),errorEvidence:terminalEvidence??(completed?undefined:streamEvidence),model,effort,commandExecutions:[...commands.values()]};
}

export class CodexProvider implements ProviderAdapter{
 readonly name='codex' as const;
 async status(force=false):Promise<ProviderStatus>{
  const runtimeQuota=await quota.get('codex');
  const runtimeBlock=runtimeQuota?.state==='exhausted'&&runtimeQuota.source==='runtime_limit_error';
  // Another gateway process may have observed and expired a limit between our
  // calls. Its durable observation is newer than this local snapshot, so an
  // old "available" status must not survive the cooldown.
  const limitNewerThanCachedStatus=statusCache?await quota.needsRefresh('codex',statusCache.at):false;
  // A live runtime block wins over the app-server value, including an older
  // in-process status cache. Once it expires, do a fresh authoritative read.
  if(runtimeBlock){observedRuntimeBlock=true;if(!force&&statusCache&&Date.now()-statusCache.at<60_000)return {...statusCache.value,quota:runtimeQuota};}
  const refreshAfterRuntimeBlock=observedRuntimeBlock&&!runtimeBlock;
  if(refreshAfterRuntimeBlock||limitNewerThanCachedStatus){observedRuntimeBlock=false;statusCache=undefined;}
  if(!force&&!refreshAfterRuntimeBlock&&!limitNewerThanCachedStatus&&statusCache&&Date.now()-statusCache.at<60_000&&statusCache.value.quota.source!=='runtime_limit_error')return statusCache.value;
  const enabled=providerEnabled('codex');let command:LaunchCommand|undefined,launchError:string|undefined;
  if(enabled)try{command=await exe();}catch(error){launchError=error instanceof Error?error.message:String(error);}
  if(!enabled)return {provider:'codex',enabled:false,available:false,authenticated:'unknown',version:'unavailable',modelPolicy:modelPolicy('codex'),effortPolicy:effortPolicy('codex'),quota:{state:'unknown',source:'disabled'}};
  if(!command)return {provider:'codex',enabled:true,available:false,authenticated:false,version:'unavailable',modelPolicy:modelPolicy('codex'),effortPolicy:effortPolicy('codex'),quota:{state:'unknown',source:launchError?'cli_launch_unusable':'cli_not_found'},reason:launchError??'Codex CLI not found'};
  const env=safeChildEnv();let version:Awaited<ReturnType<typeof runCommand>>,auth:Awaited<ReturnType<typeof runCommand>>;
  try{[version,auth]=await Promise.all([runCommand(command,['--version'],{env,timeoutMs:10000}),runCommand(command,['login','status'],{env,timeoutMs:10000})]);}
  catch(error){return {provider:'codex',enabled:true,available:false,authenticated:'unknown',version:'unavailable',modelPolicy:modelPolicy('codex'),effortPolicy:effortPolicy('codex'),quota:{state:'unknown',source:'cli_launch_failed'},reason:error instanceof Error?error.message:String(error)};}
  let q:QuotaStatus={state:'unknown',source:'codex_app_server_unavailable'},observedAccount:any;
  try{const live=await readCodexStatus(command);if(live.limits)q=quotaFromRateLimits(live.limits);observedAccount=live.account;}catch{/* Account/quota telemetry cannot replace authentication status. */}
  const authText=`${auth.stdout}\n${auth.stderr}`;const authenticated=auth.code===0;const subscriptionAuth=authenticated?!/api\s*key/i.test(authText):false;
  const latestRuntimeQuota=await quota.get('codex');
  const latestRuntimeBlock=latestRuntimeQuota?.state==='exhausted'&&latestRuntimeQuota.source==='runtime_limit_error';
  if(latestRuntimeBlock)observedRuntimeBlock=true;
  const account=accountStatus(!authenticated?false:observedAccount?.account===null?false:observedAccount?.account?.type==='chatgpt'?true:'unknown',{email:observedAccount?.account?.email},'codex_app_server_account');
  const value={provider:'codex' as const,enabled:true,available:version.code===0,authenticated,subscriptionAuth,account,version:(version.stdout||version.stderr).trim()||'unavailable',modelPolicy:modelPolicy('codex'),effortPolicy:effortPolicy('codex'),quota:latestRuntimeBlock?latestRuntimeQuota:q,reason:version.code===0?undefined:'Codex CLI version check failed'};statusCache={at:Date.now(),value};return value;
 }
 async models(force=false){
  if(!providerEnabled('codex'))return unavailableCatalog('codex','Provider disabled.');
  const command=await exe().catch(()=>undefined);if(!command)return unavailableCatalog('codex','CLI unavailable.');
  return modelCache.get(JSON.stringify(command),async()=>{
   let version='unavailable';
   try{const result=await runCommand(command,['--version'],{env:safeChildEnv({DISABLE_AUTOUPDATER:'1'}),timeoutMs:10000});version=(result.stdout||result.stderr).trim()||'unavailable';if(result.code!==0)throw Error('CLI version check failed');return codexCatalog(await readCodexModels(command),version);}
   catch(error){return unavailableCatalog('codex',`Catalog discovery failed: ${error instanceof Error?error.message:String(error)}; model/effort support remains unverified.`,version);}
  },force);
 }
 async run(kind:AgentKind,input:RunInput,signal?:AbortSignal,hooks?:RunHooks):Promise<ProviderRunResult>{
  let settings:ReturnType<typeof resolveProviderSettings>|undefined;
  try{
   settings=resolveProviderSettings('codex',input);
   if(signal?.aborted)return withSelection({provider:'codex',text:'',error:'Cancelled',errorKind:'cancelled'},settings.selection);
   const command=await exe();if(!command)throw Error('CLI unavailable');spawnPlan(command,[],input.cwd);
   validateCatalog('codex',settings,await this.models());
   const result=await this.execute(kind,input,signal,hooks);
   if(result.error&&/unknown model|unsupported model|invalid model|invalid.*effort|unsupported.*effort|effort.*not supported/i.test(result.error)&&result.errorKind==='task_error')result.errorKind='UNSUPPORTED_MODEL_OR_EFFORT';
   return withSelection(result,settings.selection);
  }catch(error){return selectionFailure('codex',error,settings?.selection);}
 }
 private async execute(kind:AgentKind,input:RunInput,signal?:AbortSignal,hooks?:RunHooks):Promise<ProviderRunResult>{
  const runStartedAt=Date.now();const command=await exe();if(!command)throw Error('Codex CLI not found');const writable=kind==='agent_implement';const {model,effort,modelSource,effortSource}=resolveProviderSettings('codex',input);
  const args=['exec','--ignore-user-config',...codexSandboxArgs(writable),'--json','-c','mcp_servers={}','-c','features.plugins=false'];if(model!=='auto')args.push('--model',model);if(effort!=='auto')args.push('-c',`model_reasoning_effort=\"${effort.replace(/\"/g,'')}\"`);args.push('-');
  const r=await runCommand(command,args,{cwd:input.cwd,env:providerChildEnv(),timeoutMs:(input.max_runtime_minutes??120)*60_000,stdin:buildPrompt(kind,input,'Codex'),signal,onActivity:hooks?.onActivity});
  statusCache=undefined;const parsed=parseEvents(r.stdout);
  const session=await readCodexSessionTelemetry(input.cwd,parsed.threadId,runStartedAt);
  const runtime=codexRuntimeMetadata(parsed.model,parsed.effort,session);
  if(r.code!==0||parsed.error){
   const error=parsed.error??(r.stderr.trim()||`Codex exited with code ${r.code}`);
   const classification=classifyProviderError(parsed.errorEvidence??r.stderr);
   const interrupted=interruptionKind(r.timedOut,signal),errorKind=interrupted??classification.errorKind;
   if(!interrupted&&classification.limitKind){
    try{await quota.markLimited('codex',classification,'Codex CLI reported a runtime limit.',Date.now());}catch{/* Cache telemetry cannot replace the CLI result. */}
   }
   return {provider:'codex',text:parsed.text,error,errorKind,limitKind:classification.limitKind??null,resetsAt:classification.resetsAt??null,retryAfter:classification.retryAfter??null,requestedModel:model,requestedEffort:effort,requestedModelSource:modelSource,requestedEffortSource:effortSource,...runtime,...(parsed.threadId?{sessionId:parsed.threadId}:{}),usage:parsed.usage,commandExecutions:parsed.commandExecutions};
  }
  try{await quota.markAvailable('codex','runtime_success',runStartedAt);}catch{/* Cache telemetry cannot replace the CLI result. */}
  return {provider:'codex',text:parsed.text,error:null,errorKind:null,requestedModel:model,requestedEffort:effort,requestedModelSource:modelSource,requestedEffortSource:effortSource,...runtime,...(parsed.threadId?{sessionId:parsed.threadId}:{}),usage:parsed.usage,commandExecutions:parsed.commandExecutions,rawEvents:r.stdout};
 }
 async cliStatus(){return this.status(true);}
 async update(){return {provider:'codex',updated:false,supported:false,reason:'Codex update is installation-dependent (Desktop/native/npm). Update Codex outside the gateway, then agent_cli_status will re-detect the version.'};}
}
import {providerChildEnv} from '../process.js';
