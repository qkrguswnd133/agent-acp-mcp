import path from 'node:path';
import {accountStatus} from '../account.js';
import {claudeModelMetadata} from '../claude-model.js';
import {randomUUID} from 'node:crypto';
import {home,resolveExecutable,runCommand,safeChildEnv} from '../process.js';
import {providerEnabled,modelPolicy,effortPolicy} from '../config.js';
import {resolveProviderSettings} from '../model-settings.js';
import {buildPrompt} from '../prompt.js';
import {QuotaCache} from '../quota-cache.js';
import {readClaudeSessionTelemetry,reportedEffort} from '../claude-session.js';
import {classifyProviderError} from '../limits.js';
import {getClaudeUsage} from '../claude-usage.js';
import {claudeUsageAccountKey,refreshClaudeCredentials} from '../claude-auth-refresh.js';
import type {AgentKind,ProviderAdapter,ProviderRunResult,ProviderStatus,RunHooks,RunInput,QuotaStatus} from '../types.js';

const quota=new QuotaCache(path.join(process.env.AGENT_MCP_STATE_DIR??path.join(home,'.agent-acp-mcp'),'claude-quota.json'));
let cachedExecutable:string|undefined;
async function exe(){return cachedExecutable??=await resolveExecutable(process.env.CLAUDE_CLI,['claude'],[
 path.join(home,'.local','bin',process.platform==='win32'?'claude.exe':'claude'),
 path.join(home,'AppData','Local','Programs','Claude','claude.exe')
]);}
function parseJson(stdout:string):any{try{return JSON.parse(stdout.trim());}catch{return undefined;}}
function resultText(parsed:any,stdout:string){return String(parsed?.result??parsed?.response??parsed?.message??stdout).trim();}
function resultError(parsed:any,stdout:string){const value=parsed?.result??parsed?.error??parsed?.message??parsed?.errors??stdout;return typeof value==='string'?value.trim():JSON.stringify(value);}
function interruptionKind(timedOut:boolean,signal?:AbortSignal):string|undefined{
 if(timedOut)return 'deadline_exceeded';
 if(!signal?.aborted)return undefined;
 const reason=signal.reason;
 const message=typeof reason==='string'?reason:reason instanceof Error?reason.message:reason&&typeof reason==='object'?String((reason as any).errorKind??(reason as any).code??(reason as any).message??''):'';
 return /deadline|timeout/i.test(message)?'deadline_exceeded':'cancelled';
}
function structuredErrorEvidence(parsed:any, message:string|undefined):unknown{
 if(parsed?.is_error!==true)return undefined;
 // Preserve protocol error metadata, including HTTP headers and explicit reset
 // hints, without ever passing ordinary result stdout to the classifier.
 const evidence:Record<string,unknown>={};
 for(const key of ['error','errors','code','type','detail','reason','status','statusCode','httpStatus','headers','resetsAt','resetAt','data','response','cause','details','body']){
  if(parsed?.[key]!==undefined)evidence[key]=parsed[key];
 }
 if(message!==undefined)evidence.message=message;
 return Object.keys(evidence).length?evidence:message;
}

export class ClaudeProvider implements ProviderAdapter{
 readonly name='claude' as const;
 async status():Promise<ProviderStatus>{
  const enabled=providerEnabled('claude'),command=enabled?await exe():undefined;
  if(!enabled)return {provider:'claude',enabled:false,available:false,authenticated:'unknown',version:'unavailable',modelPolicy:modelPolicy('claude'),effortPolicy:effortPolicy('claude'),quota:{state:'unknown',source:'disabled'}};
  if(!command)return {provider:'claude',enabled:true,available:false,authenticated:false,version:'unavailable',modelPolicy:modelPolicy('claude'),effortPolicy:effortPolicy('claude'),quota:{state:'unknown',source:'cli_not_found'},reason:'Claude CLI not found'};
  const env=safeChildEnv({DISABLE_AUTOUPDATER:'1'});
  const [version,auth]=await Promise.all([runCommand(command,['--version'],{env,timeoutMs:10000}),runCommand(command,['auth','status'],{env,timeoutMs:10000})]);
  const authParsed=parseJson(auth.stdout);const authenticated:boolean|'unknown'=auth.code===0?(authParsed?.loggedIn===true||authParsed?.authenticated===true?true:authParsed?.loggedIn===false||authParsed?.authenticated===false?false:'unknown'):false;
  const method=String(authParsed?.authMethod??authParsed?.auth_method??authParsed?.subscriptionType??authParsed?.subscription_type??'').toLowerCase();
  const subscriptionAuth=method?(!/console|api[_ -]?key/.test(method)):authenticated?'unknown':false;
  let usage:Awaited<ReturnType<typeof getClaudeUsage>>|undefined;
  if(authenticated===true&&subscriptionAuth===true){
   const accountKey=claudeUsageAccountKey(authParsed);
   try{usage=await getClaudeUsage({accountKey,refreshCredentials:()=>refreshClaudeCredentials(command,accountKey)});}catch{/* Usage telemetry never determines CLI authentication. */}
  }
  let currentQuota:QuotaStatus=usage??{state:'unknown',source:'claude_usage_unavailable'};
  if(usage?.observedAt&&await quota.needsRefresh('claude',Date.parse(usage.observedAt)))currentQuota={...usage,state:'unknown',stale:true,note:'Usage snapshot predates a runtime limit; awaiting next usage refresh.'};
  // Re-read after network I/O: another MCP process may have observed a limit.
  const latestQuota=await quota.get('claude');
  if(latestQuota?.state==='exhausted')currentQuota={...currentQuota,...latestQuota};
  return {provider:'claude',enabled:true,available:version.code===0,authenticated,subscriptionAuth,account:accountStatus(authenticated,{email:authParsed?.email,organization:authParsed?.orgName},'claude_auth_status'),version:(version.stdout||version.stderr).trim()||'unavailable',modelPolicy:modelPolicy('claude'),effortPolicy:effortPolicy('claude'),quota:currentQuota,reason:version.code===0?undefined:'Claude CLI version check failed'};
 }
 async run(kind:AgentKind,input:RunInput,signal?:AbortSignal,hooks?:RunHooks):Promise<ProviderRunResult>{
  const runStartedAt=Date.now();const command=await exe();if(!command)throw Error('Claude CLI not found');const writable=kind==='agent_implement';
  // Keep official session JSONL persistence: usage collectors attribute projects from its cwd.
  const generatedSessionId=randomUUID();
  const args=['-p','Follow the complete user task and constraints supplied on stdin.','--output-format','json','--session-id',generatedSessionId,'--permission-mode',writable?'acceptEdits':'dontAsk','--tools',writable?'Read,Glob,Grep,Edit,Write,Bash':'Read,Glob,Grep'];
  // acceptEdits covers file edits; Bash needs its own scoped tool grant in a
  // noninteractive session. Do not change the read-only providers' tool list.
  if(writable)args.push('--allowedTools','Bash');
  const {model,effort,modelSource,effortSource}=resolveProviderSettings('claude',input);
  if(model!=='auto')args.push('--model',model);if(effort!=='auto')args.push('--effort',effort);
  args.push('--strict-mcp-config','--mcp-config','{"mcpServers":{}}');
  const r=await runCommand(command,args,{cwd:input.cwd,env:providerChildEnv({DISABLE_AUTOUPDATER:'1'}),stdin:buildPrompt(kind,input,'Claude'),timeoutMs:(input.max_runtime_minutes??120)*60_000,signal,onActivity:hooks?.onActivity});
  const parsed=parseJson(r.stdout);const failed=r.code!==0||parsed?.is_error===true;
  const sessionId=typeof (parsed?.session_id??parsed?.sessionId)==='string'&&(parsed.session_id??parsed.sessionId).trim()?(parsed.session_id??parsed.sessionId).trim():generatedSessionId;
  const directEffort=reportedEffort(parsed?.effort??parsed?.reasoning_effort??parsed?.reasoningEffort);
  // JSON output can be malformed on an exit error, but the official session
  // transcript is still attributable because this run supplied its UUID.
  const telemetry=await readClaudeSessionTelemetry(input.cwd,sessionId);
  const {text:partialText,usage:transcriptUsage,model:transcriptModel,observedModels:transcriptModels,usageSource:transcriptUsageSource,usageScope:transcriptUsageScope,observedUsage,commandExecutions,...sessionEffort}=telemetry;
  const runtimeEffort=directEffort?{effort:directEffort,effortSource:'cli_result',observedEfforts:[directEffort],effortComplete:true}:sessionEffort;
  const metadata={...claudeModelMetadata(parsed,transcriptModels??(transcriptModel?[transcriptModel]:[])),...runtimeEffort,requestedModel:model,requestedEffort:effort,requestedModelSource:modelSource,requestedEffortSource:effortSource,sessionId,commandExecutions};
  if(failed){
   const structured=parsed?.is_error===true?resultError(parsed,''):undefined;
   const error=structured??(r.stderr.trim()||`Claude exited with code ${r.code}`);
   // Only an actual structured error or stderr is classification evidence.
   // Normal stdout may contain a discussion of a quota and is never evidence.
   const structuredPayload=structuredErrorEvidence(parsed,structured);
   const classification=classifyProviderError(structuredPayload??r.stderr);
   const interrupted=interruptionKind(r.timedOut,signal),errorKind=interrupted??classification.errorKind;
   if(!interrupted&&classification.limitKind){
    try{await quota.markLimited('claude',classification,'Claude CLI reported a runtime limit.',Date.now());}catch{/* Cache telemetry cannot replace the CLI result. */}
   }
   const directUsage=parsed?.usage;
   return {provider:'claude',text:partialText??'',error,errorKind,limitKind:classification.limitKind??null,resetsAt:classification.resetsAt??null,retryAfter:classification.retryAfter??null,...metadata,usage:directUsage??transcriptUsage??'unavailable',...(directUsage!==undefined?{usageSource:'cli_result',usageScope:'cli_result'}:transcriptUsage!==undefined?{usageSource:transcriptUsageSource,usageScope:transcriptUsageScope,observedUsage}:{}),rawResultType:parsed?.type??'unavailable'};
  }
  try{await quota.markAvailable('claude','runtime_success',runStartedAt);}catch{/* Cache telemetry cannot replace the CLI result. */}
  const directUsage=parsed?.usage;
  return {provider:'claude',text:resultText(parsed,r.stdout),error:null,errorKind:null,...metadata,usage:directUsage??transcriptUsage??'unavailable',...(directUsage!==undefined?{usageSource:'cli_result',usageScope:'cli_result'}:transcriptUsage!==undefined?{usageSource:transcriptUsageSource,usageScope:transcriptUsageScope,observedUsage}:{}),rawResultType:parsed?.type??'unavailable'};
 }
 async cliStatus(){return this.status();}
 async update(){const command=await exe();if(!command)return {provider:'claude',updated:false,error:'Claude CLI not found'};const r=await runCommand(command,['update'],{env:safeChildEnv({DISABLE_AUTOUPDATER:'1'}),timeoutMs:180000});cachedExecutable=undefined;return {provider:'claude',updated:r.code===0,stdout:r.stdout.trim(),stderr:r.stderr.trim(),status:await this.status()};}
}
import {providerChildEnv} from '../process.js';
