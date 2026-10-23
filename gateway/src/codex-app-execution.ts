import type {ChildProcess} from 'node:child_process';
import path from 'node:path';
import {runCommand,type CommandOptions,type LaunchCommand} from './process.js';
import {CodexProgress} from './codex-progress.js';
import {readCodexSessionTelemetry,CodexSessionProgressReader,type CodexSessionEvidence} from './codex-session.js';
import {observedSpeed,type ExecutionSpeed,type CliAppliedSettings} from './execution-speed.js';

export interface CodexAppliedSettings extends CliAppliedSettings {
 threadId:string;turnId:string|null;source:'app_server.thread/start'|'app_server.thread/settings/updated';observedAt:string;
 model?:string;effort?:string;serviceTierPresent:boolean;serviceTier?:unknown;speed?:ExecutionSpeed;
}
export interface CodexAppCommandOptions extends CommandOptions {
 cwd:string;prompt:string;model?:string;effort?:string;speed:ExecutionSpeed;
 sandbox:'read-only'|'workspace-write'|'danger-full-access';config?:Record<string,unknown>;
 /** Only protocol handshakes have this short timeout; model work uses timeoutMs. */
 requestTimeoutMs?:number;
}
type Row=Record<string,any>;
function record(value:unknown):value is Row{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function errorValue(value:any,fallback='Codex app-server request failed'){
 const row=record(value)?value:{message:typeof value==='string'?value:fallback};
 const info=row.codexErrorInfo;
 // Preserve structured evidence for the shared limit classifier, which does
 // not inspect arbitrary successful assistant text.
 const code=row.code??(typeof info==='string'?info:record(info)?Object.keys(info)[0]:undefined);
 return {...row,...(code!==undefined?{code}:{}),message:typeof row.message==='string'?row.message:fallback};
}
function tokenUsage(value:any){
 if(!record(value))return undefined;
 const result:Row={};
 for(const [source,target] of Object.entries({inputTokens:'input_tokens',cachedInputTokens:'cached_input_tokens',cacheWriteInputTokens:'cache_write_input_tokens',outputTokens:'output_tokens',reasoningOutputTokens:'reasoning_output_tokens',totalTokens:'total_tokens'}))
  if(typeof value[source]==='number'&&Number.isFinite(value[source]))result[target]=value[source];
 return Object.keys(result).length?result:undefined;
}
function samePath(a:string,b:string){const normalize=(v:string)=>{const result=path.resolve(v);return process.platform==='win32'?result.toLowerCase():result;};return normalize(a)===normalize(b);}

/** One subscription-backed app-server thread and one turn per gateway run.
 * Configuration acknowledgements remain separate from backend observations.
 * No failed handshake or turn is automatically replayed through another CLI. */
export async function runCodexAppCommand(command:LaunchCommand,args:string[],options:CodexAppCommandOptions,startedAt=Date.now()){
 let child:ChildProcess|undefined,sequence=0,finished=false,stopping=false,terminal=false,turnSubmitted=false;
 let threadId:string|undefined,turnId:string|undefined,completedAt:string|undefined,lastOutput=Date.now(),lastProbe=0;
 let appliedSettings:CodexAppliedSettings|undefined,recovered:CodexSessionEvidence|undefined,protocolError:Row|undefined,sessionReader:CodexSessionProgressReader|undefined;
 const settingsHistory:CodexAppliedSettings[]=[],normalized:string[]=[],protocolLines:string[]=[],progress=new CodexProgress(startedAt);
 const pending=new Map<string,{method:string;resolve:(v:any)=>void;reject:(v:any)=>void;timer:NodeJS.Timeout}>();
 const queued:Row[]=[],messages=new Map<string,{text:string;completed:boolean}>(),commands=new Map<string,Row>();
 let lastUsage:Row|undefined;
 const snapshot=()=>{const value=progress.snapshot();return {...value,source:value.source==='cli_json'?'app_server':value.source,coverage:'Codex app-server events from this thread and turn, plus matching session tool events after launch; command classifications are inferred from syntax. Counts use the maximum per source to avoid duplicates. No unobserved changes or test totals are inferred.'};};
 const activity=(event:Row)=>{try{const state=snapshot();options.onActivity?.({...event,provider:'codex',sessionId:threadId??null,turnId:turnId??null,phase:state.phase,implementationProgress:state});}catch{/* Telemetry observers cannot change execution. */}};
 const emit=(event:Row)=>{normalized.push(JSON.stringify(event));if(progress.observeCli(event))activity({type:'codex_progress',at:new Date().toISOString(),source:'app_server'});};
 const write=(value:unknown)=>{if(finished||!child?.stdin?.writable)return false;try{return child.stdin.write(JSON.stringify(value)+'\n');}catch{return false;}};
 const request=(method:string,params:unknown,timeout=options.requestTimeoutMs??15000)=>new Promise<any>((resolve,reject)=>{
  if(finished||stopping&&method!=='turn/interrupt'){reject(Error('Codex app-server already stopping'));return;}
  const id=`gateway-${++sequence}`,timer=setTimeout(()=>{pending.delete(id);reject({code:'app_server_protocol_timeout',message:`Codex app-server ${method} did not reply within ${timeout}ms`});},timeout);
  pending.set(id,{method,resolve,reject,timer});write({id,method,params});
 });
 const fail=(error:unknown)=>{if(terminal||finished)return;terminal=true;protocolError=errorValue(error);emit({type:'turn.failed',error:protocolError});};
 const captureSettings=(row:Row,source:CodexAppliedSettings['source'])=>{
  if(!threadId)return;
  const serviceTierPresent=Object.hasOwn(row,'serviceTier'),serviceTier=row.serviceTier;
  // null is the CLI's standard-tier representation only when the property is
  // actually present in this same run's acknowledgement. Missing is unknown.
  const speed=serviceTierPresent?(serviceTier===null&&options.speed==='standard'?'standard':observedSpeed(serviceTier)):undefined;
  const effort=row.reasoningEffort??row.effort;
  const value:CodexAppliedSettings={threadId,turnId:turnId??null,source,observedAt:new Date().toISOString(),serviceTierPresent,
   ...(typeof row.model==='string'?{model:row.model}:{}),...(typeof effort==='string'?{effort}:{}),
   ...(serviceTierPresent?{serviceTier}:{}),...(speed?{speed}:{})};
  appliedSettings=value;settingsHistory.push(value);activity({type:'codex_applied_settings',...value});
 };
 const recordProtocol=(row:Row)=>{const line=JSON.stringify(row);protocolLines.push(line);options.onStdoutLine?.(line);};
 const flushPartial=()=>{for(const [id,message] of messages)if(!message.completed&&message.text){emit({type:'item.completed',item:{id,type:'agent_message',text:message.text,partial:true}});message.completed=true;}};
 const itemEvent=(method:string,item:Row)=>{
  if(typeof item.id!=='string')return;
  const kind=method==='item/completed'?'item.completed':'item.started';
  if(item.type==='agentMessage'){
   const previous=messages.get(item.id);const text=typeof item.text==='string'?item.text:previous?.text??'';
   messages.set(item.id,{text,completed:kind==='item.completed'});
   emit({type:kind,item:{id:item.id,type:'agent_message',text}});return;
  }
  if(item.type==='commandExecution'){
   const previous=commands.get(item.id)??{},command={...previous,id:item.id,type:'command_execution',
    ...(typeof item.command==='string'?{command:item.command}:{}),...(typeof item.cwd==='string'?{cwd:item.cwd}:{}),
    ...(typeof item.aggregatedOutput==='string'?{aggregated_output:item.aggregatedOutput}:{}),
    ...(typeof item.exitCode==='number'?{exit_code:item.exitCode}:{}),...(typeof item.status==='string'?{status:item.status}:{})};
   commands.set(item.id,command);emit({type:kind,item:command});return;
  }
  if(item.type==='fileChange'){emit({type:kind,item:{...item,type:'file_change'}});return;}
  if(item.type==='reasoning')emit({type:kind,item:{...item,type:'reasoning'}});
 };
 const notification=(row:Row)=>{
  const p=row.params;if(!record(p)||!threadId||p.threadId!==threadId)return;
  if(row.method==='thread/settings/updated'){if(!terminal&&record(p.threadSettings)){recordProtocol(row);captureSettings(p.threadSettings,'app_server.thread/settings/updated');}return;}
  if(!turnId){if(turnSubmitted){if(queued.length<1000)queued.push(row);else fail({code:'app_server_protocol_error',message:'Too many notifications before the turn/start acknowledgement'});}return;}
  const eventTurn=p.turnId??p.turn?.id;if(eventTurn!==turnId)return;
  if(terminal&&row.method!=='thread/tokenUsage/updated')return;
  recordProtocol(row);
  if(row.method==='thread/tokenUsage/updated'){
   const usage=tokenUsage(p.tokenUsage?.total);if(usage){lastUsage=usage;emit({type:'usage.updated',usage});}return;
  }
  if(row.method==='item/started'||row.method==='item/completed'){if(record(p.item))itemEvent(row.method,p.item);return;}
  if(row.method==='item/agentMessage/delta'&&typeof p.itemId==='string'&&typeof p.delta==='string'){
   const previous=messages.get(p.itemId)??{text:'',completed:false};previous.text+=p.delta;messages.set(p.itemId,previous);
   // Delta text is accumulated once, then emitted in full on item completion
   // or cancellation. Progress events intentionally contain no duplicate text.
   progress.observeCli({type:'item.updated',item:{id:p.itemId,type:'agent_message'}});activity({type:'codex_text_delta',at:new Date().toISOString()});return;
  }
  if(row.method==='item/commandExecution/outputDelta'&&typeof p.itemId==='string'&&typeof p.delta==='string'){
   const item=commands.get(p.itemId)??{id:p.itemId,type:'command_execution'};item.aggregated_output=(item.aggregated_output??'')+p.delta;commands.set(p.itemId,item);emit({type:'item.updated',item});return;
  }
  if(row.method==='turn/started'){emit({type:'turn.started',turn_id:turnId});return;}
  if(row.method==='error'){
   const error=errorValue(p.error);if(p.willRetry===true){activity({type:'codex_retryable_error',error,at:new Date().toISOString()});return;}
   fail(error);return;
  }
  if(row.method==='turn/completed'){
   if(terminal)return;
   flushPartial();terminal=true;
   if(p.turn?.status==='completed'){
    completedAt=new Date().toISOString();emit({type:'turn.completed',...(lastUsage?{usage:lastUsage}:{})});activity({type:'codex_turn_completed',at:completedAt,source:'app_server'});
   }else{
    protocolError=errorValue(p.turn?.error??{code:p.turn?.status==='interrupted'?'cancelled':'app_server_turn_failed',message:`Codex turn ended with status ${String(p.turn?.status??'unknown')}`});emit({type:'turn.failed',error:protocolError});
   }
  }
 };
 const serverRequest=(row:Row)=>{
  // A command denial is not a cancellation of the entire implementation.
  if(['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(row.method)){
   write({id:row.id,result:{decision:'decline'}});activity({type:'codex_permission_denied',method:row.method,at:new Date().toISOString()});return;
  }
  if(row.method==='item/permissions/requestApproval'){
   write({id:row.id,result:{permissions:{},scope:'turn'}});activity({type:'codex_permission_denied',method:row.method,at:new Date().toISOString()});return;
  }
  // No authentication refresh, arbitrary tool, permission or input request is
  // fulfilled by executing provider-supplied code in the gateway process.
  write({id:row.id,error:{code:-32601,message:`Gateway does not support client request ${String(row.method)}`}});
  activity({type:'codex_unsupported_client_request',method:row.method,at:new Date().toISOString()});
 };
 const receive=(line:string)=>{
  lastOutput=Date.now();let row:Row;try{const value=JSON.parse(line);if(!record(value))return;row=value;}catch{return;}
  if(typeof row.method==='string'){
   if(row.id!==undefined)serverRequest(row);else notification(row);return;
  }
  if(row.id===undefined)return;const waiting=pending.get(String(row.id));if(!waiting)return;
  // config/read can include inherited credentials and private plugin settings.
  // It is used only to discover which MCP entries must be disabled, never saved.
  if(['thread/start','turn/start','turn/interrupt'].includes(waiting.method)){protocolLines.push(line);options.onStdoutLine?.(line);}
  pending.delete(String(row.id));clearTimeout(waiting.timer);if(row.error!==undefined)waiting.reject(errorValue(row.error));else waiting.resolve(row.result);
 };
 const start=async()=>{
  await request('initialize',{clientInfo:{name:'agent-acp-mcp',version:'1'},capabilities:{experimentalApi:true}});if(finished||stopping||options.signal?.aborted)return;
  write({method:'initialized',params:{}});
  const configuration=await request('config/read',{cwd:options.cwd,includeLayers:false});
  if(finished||stopping||options.signal?.aborted)return;
  if(!record(configuration?.config)||configuration.config.mcp_servers!==undefined&&!record(configuration.config.mcp_servers))throw {code:'app_server_config_unavailable',message:'Codex app-server configuration could not be inspected; no turn was started'};
  // An empty table is merged into user config, not a replacement. Disable each
  // inherited server explicitly to prevent recursive or unrelated delegation.
  const disabledMcp=Object.fromEntries(Object.keys(configuration.config.mcp_servers??{}).map(name=>[name,{enabled:false}]));
  const response=await request('thread/start',{cwd:options.cwd,model:options.model,approvalPolicy:'never',sandbox:options.sandbox,
   serviceTier:options.speed==='standard'?'default':options.speed==='fast'?'priority':'ultrafast',
   config:{...options.config,...(options.effort?{model_reasoning_effort:options.effort}:{}),'mcp_servers':disabledMcp,'features.plugins':false,'features.apps':false,'features.hooks':false,'features.multi_agent':false,'notify':[],'model_provider':'openai','allow_login_shell':false}});
  if(finished||stopping||options.signal?.aborted)return;
  if(typeof response?.thread?.id!=='string'||!response.thread.id)throw {code:'app_server_protocol_error',message:'Codex thread/start omitted the thread ID'};
  threadId=String(response.thread.id);sessionReader=new CodexSessionProgressReader(options.cwd,threadId,startedAt,undefined,{returnedThreadId:threadId});emit({type:'thread.started',thread_id:threadId});captureSettings(response,'app_server.thread/start');
  if(typeof response.cwd==='string'&&!samePath(response.cwd,options.cwd))throw {code:'app_server_cwd_mismatch',message:'Codex acknowledged a different working directory; no turn was started'};
  const actualSandbox=response.sandbox?.type??response.sandbox;
  const sandboxRank:Record<string,number>={'read-only':0,readOnly:0,'workspace-write':1,workspaceWrite:1,'danger-full-access':2,dangerFullAccess:2,externalSandbox:2};
  if(typeof actualSandbox==='string'&&sandboxRank[actualSandbox]>sandboxRank[options.sandbox])throw {code:'app_server_sandbox_mismatch',message:'Codex acknowledged broader sandbox access than requested; no turn was started'};
  turnSubmitted=true;
  // No turn-level model/effort/tier override: the thread acknowledgement above
  // is exactly the configuration inherited by the single submitted turn.
  const result=await request('turn/start',{threadId,input:[{type:'text',text:options.prompt}]});
  if(finished||stopping||options.signal?.aborted)return;
  if(typeof result?.turn?.id!=='string'||!result.turn.id)throw {code:'app_server_protocol_error',message:'Codex turn/start omitted the turn ID'};
  turnId=String(result.turn.id);for(const settings of settingsHistory)settings.turnId=turnId;
  emit({type:'turn.started',turn_id:turnId});
  for(const row of queued.splice(0))notification(row);
  if(['completed','failed','interrupted'].includes(result.turn.status))notification({method:'turn/completed',params:{threadId,turn:result.turn}});
 };
 const result=await runCommand(command,args,{...options,stdin:undefined,keepStdinOpen:true,trackDescendants:true,onStdoutChunk:undefined,onSpawn(p){child=p;options.onSpawn?.(p);queueMicrotask(()=>void start().catch(fail));},onStdoutLine:receive,onActivity:activity,
  async onStopping(reason){
   stopping=true;
   if(reason!=='completed'&&threadId&&turnId&&!terminal){await request('turn/interrupt',{threadId,turnId},300).catch(()=>{});}
   await options.onStopping?.(reason);
  },
  async completion(){
   if(terminal)return true;
   // Recover a missing terminal notification only from this newly returned
   // thread's authenticated task_complete, never from final assistant prose.
   if(!threadId||!turnId||!sessionReader||Date.now()-lastProbe<5000)return false;
   lastProbe=Date.now();const observation=await sessionReader.read();
   if(finished||stopping||terminal||options.signal?.aborted)return false;
   if(observation.truncated)progress.markPartial();let changed=false;
   for(const event of observation.events)changed=progress.observeSession(event)||changed;
   if(changed)activity({type:'codex_session_progress',at:progress.snapshot().lastActivityAt,source:'session_jsonl'});
   if(Date.now()-lastOutput<5000)return false;
   const evidence=await readCodexSessionTelemetry(options.cwd,threadId,startedAt,undefined,undefined,{returnedThreadId:threadId});
   if(finished||stopping||terminal||options.signal?.aborted)return false;
   if(!evidence.completed)return false;
   recovered=evidence;completedAt=evidence.completedAt??new Date().toISOString();terminal=true;
   if(evidence.text)emit({type:'item.completed',item:{id:'session-recovery',type:'agent_message',text:evidence.text}});
   emit({type:'turn.completed',...(evidence.usage?{usage:evidence.usage}:{})});activity({type:'codex_turn_completed',at:completedAt,source:'session_jsonl'});return true;
  }});
 finished=true;for(const request of pending.values()){clearTimeout(request.timer);request.reject(Error('Codex app-server stopped'));}pending.clear();
 flushPartial();
 if(!terminal&&!result.stopReason){protocolError={code:'app_server_incomplete',message:'Codex app-server exited without a terminal event for this turn'};emit({type:'turn.failed',error:protocolError});}
 progress.finalized();activity({type:'codex_execution_finalized',at:new Date().toISOString()});
 return {...result,stdout:normalized.join('\n'),rawProtocolStdout:protocolLines.join('\n'),threadId,turnId,appliedSettings,settingsHistory,
  implementationProgress:snapshot(),completion:{confirmed:!!completedAt,source:recovered?'session_jsonl':completedAt?'app_server':'unavailable',completedAt:completedAt??null,processStoppedAfterCompletion:!!completedAt&&result.stopReason==='completed'},recovered,
  ...(protocolError?{protocolError}:{})};
}
