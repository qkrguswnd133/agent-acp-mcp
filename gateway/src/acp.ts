import {validateContinuationScope} from './continuation-scope.js';
import {implementationWorkflow,readOnlyWorkflow} from './prompt.js';
import {spawn,execFile, type ChildProcess, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {Readable,Writable} from 'node:stream';
import fs from 'node:fs/promises';
import {TestTerminal} from './test-terminal.js';
import {resolveExecutable,spawnPlan,type LaunchCommand} from './process.js';
import {permissionResponse} from './permission-response.js';
import {workspaceConflict,workspaceConflictMessage} from './workspace-lock.js';
import path from 'node:path';
import {client,ndJsonStream, type ClientConnection, type ToolCallUpdate} from '@agentclientprotocol/sdk';
import {Policy,canonical,within} from './policy.js';
import {getSessionUsage,weeklyDelta} from './usage.js';
import {getWeeklyUsage,forDelta} from './billing.js';
import {LifecycleController, type LifecycleErrorKind} from './lifecycle.js';
import {root,childEnv,active,terminate,shutdown,grokLaunch} from './runtime.js';
export {root,executable,childEnv,terminate,shutdown} from './runtime.js';
import {ensureHealth,markUnhealthy} from './health.js';
import {resolveProviderSettings,validateCatalog,withSelection,selectionFailure,ModelSelectionError} from './model-settings.js';
import {grokCatalog} from './model-catalog.js';
import type {RunInput as GatewayRunInput,ProviderRunResult} from './types.js';
import {confirmSessionConfig} from './session-config.js';
import {classifyProviderError, type LimitClassification} from './limits.js';

type ProcessExit={code:number|null;signal:string|null;phase:string;at:string;intentionalShutdown:boolean;promptCompleted:boolean};
const locks=new Map<symbol,{cwd:string;kind:string;provider:string}>();
export interface RunInput extends GatewayRunInput {}
export interface RunHooks { onActivity?:(event:Record<string,unknown>)=>void }
/** Test-only seams for exercising the real ACP lifecycle without an account. */
export interface RunGrokDependencies {
  ensureHealth?: typeof ensureHealth;
  getWeeklyUsage?: typeof getWeeklyUsage;
  getSessionUsage?: typeof getSessionUsage;
  spawn?: typeof spawn;
  launch?: () => Promise<LaunchCommand>;
  terminate?: typeof terminate;
  stateRoot?: string;
}
function errorMessage(error:unknown): string { return error instanceof Error ? error.message : String(error); }
function connectionFailure(message:string):boolean { return /auth|cached_token|oidc|protocol|connection|socket|pipe|epipe|econn|unknown model|reasoning|ACP did not confirm/i.test(message); }

/**
 * ACP puts terminal failures in either a structured request error or a stop
 * reason. Keep this pure so provider-limit behavior can be tested without a
 * live Grok session.
 */
export function classifyGrokFailure(error:unknown, stopReason?:unknown, now=Date.now()):LimitClassification {
  return classifyProviderError({error,reason:stopReason},now);
}

function stoppedError(kind:LifecycleErrorKind):Error {
  return Error(kind==='deadline_exceeded'?'Task runtime deadline exceeded':'Cancelled');
}

async function whileActive<T>(operation:Promise<T>, lifecycle:LifecycleController):Promise<T> {
  if(lifecycle.reason){operation.catch(()=>{});throw stoppedError(lifecycle.reason);}
  return await new Promise<T>((resolve,reject)=>{
    const abort=()=>reject(stoppedError(lifecycle.reason??'cancelled'));
    lifecycle.signal.addEventListener('abort',abort,{once:true});
    operation.then(value=>{lifecycle.signal.removeEventListener('abort',abort);resolve(value);},cause=>{lifecycle.signal.removeEventListener('abort',abort);reject(cause);});
  });
}

function unavailableBilling(){return {status:'unavailable' as const,fresh:false as const,source:'unavailable' as const,stale:true};}

export async function runGrok(kind:string,input:RunInput,signal?:AbortSignal,hooks?:RunHooks,deps:RunGrokDependencies={}):Promise<ProviderRunResult> {
 let settings:ReturnType<typeof resolveProviderSettings>|undefined;
 try{settings=resolveProviderSettings('grok',input);return withSelection({provider:'grok',...await executeGrok(kind,input,settings,signal,hooks,deps)},settings.selection);}
 catch(error){if(error instanceof ModelSelectionError)return selectionFailure('grok',error,settings?.selection);if(error instanceof Error)Object.assign(error,{selection:settings?.selection});throw error;}
}
async function executeGrok(kind:string,input:RunInput,requested:ReturnType<typeof resolveProviderSettings>,signal?:AbortSignal,hooks?:RunHooks,deps:RunGrokDependencies={}) {
  const healthCheck=deps.ensureHealth??ensureHealth,weeklyUsage=deps.getWeeklyUsage??getWeeklyUsage,sessionUsage=deps.getSessionUsage??getSessionUsage;
  const spawnChild=deps.spawn??spawn,terminateChild=deps.terminate??terminate,stateRoot=deps.stateRoot??path.join(root,'state'),resolveLaunch=deps.launch??grokLaunch;
  let launch:LaunchCommand|undefined;
  const earlyStopped=(kind:LifecycleErrorKind='cancelled',_model='unavailable',_effort='unavailable')=>({text:'',stopReason:'cancelled',error:kind==='deadline_exceeded'?'Task runtime deadline exceeded':'Cancelled',errorKind:kind,sessionId:'unavailable',model:'unavailable',effort:'unavailable',phase:'preflight',startedAt:new Date().toISOString(),lastActivityAt:null,exitCode:null,exitSignal:null,partialWork:{messageChunks:0,toolCalls:0,fsReads:0,fsWrites:0,terminalOperations:0},childCleanedUp:true});
  // Do not probe health or spawn a child for a queued task that has already stopped.
  if(signal?.aborted) return earlyStopped();
  let p:ChildProcessWithoutNullStreams|undefined, conn:ClientConnection|undefined;
  let sessionId:string|undefined, resultText='', stopReason='unavailable', error:string|undefined, errorKind:string|undefined, limitClassification:LimitClassification|undefined;
  let verified=false, authenticated=false, agentVersion='unavailable', handshakeTimedOut=false, promptCompleted=false;
  let childCleanedUp=true, intentionalShutdown=false, unexpectedProcessExit=false;
  let processExit:ProcessExit|null=null;
  let exitCode:number|null=null, exitSignal:string|null=null, phase='preflight', failurePhase:string|null=null, endedPhase:string|null=null, lastActivityAt:string|null=null;
  const denied:string[]=[];
  const permissionDenials:Array<{toolCallId:string;reason:string;response:string}>=[];
  const blockedCommands:Array<{command:string;cwd:string;requestedCwd:string|null;reason:string;executionStatus:string;requiresReview:boolean}>=[];
  const recordBlockedCommand=(command:unknown,requestedCwd:unknown,reason:string)=>{
    if(typeof command!=='string'||!command.trim())return;
    const entry={command,cwd:input.cwd,requestedCwd:typeof requestedCwd==='string'?requestedCwd:null,reason,executionStatus:'not_executed',requiresReview:true};
    if(!blockedCommands.some(value=>value.command===entry.command&&value.requestedCwd===entry.requestedCwd&&value.reason===entry.reason))blockedCommands.push(entry);
  };
  const clientOperations={reads:0,writes:0,terminals:0};
  const partialWork={messageChunks:0,toolCalls:0,fsReads:0,fsWrites:0,terminalOperations:0};
  const calls = new Map<string,ToolCallUpdate>();
  const taskTerminals=new Set<TestTerminal>();
  const startedAt = new Date().toISOString();
  const progress={startedAt,successfulReads:0,successfulWrites:0,commandsStarted:0};
  const explicitDeadline=typeof input.deadlineAt==='number'&&Number.isFinite(input.deadlineAt)?input.deadlineAt:undefined;
  const taskDeadlineAt=explicitDeadline??(Date.now()+(input.max_runtime_minutes ?? 120)*60*1000);
  const lifecycle=new LifecycleController({
    // Router retries share this absolute deadline. Never reset it per ACP phase.
    deadlineMs:Math.max(1,taskDeadlineAt-Date.now()),
    onCancel:()=>{phase='cancelling';if(sessionId) void conn?.agent.notify('session/cancel',{sessionId}).catch(()=>{});},
    onForce:()=>{intentionalShutdown=true;conn?.close();if(p)void terminateChild(p);for(const terminal of taskTerminals)void terminal.stop('cancelled');},
  });
  lifecycle.attach(signal);lifecycle.startDeadline();
  if(explicitDeadline!==undefined&&explicitDeadline<=Date.now())lifecycle.requestStop('deadline_exceeded');
  if(lifecycle.reason){const reason=lifecycle.reason;lifecycle.dispose(signal);return earlyStopped(reason);}
  let health:Awaited<ReturnType<typeof ensureHealth>>;
  try{health=await whileActive(healthCheck(),lifecycle);}catch(cause){const reason=lifecycle.reason;lifecycle.dispose(signal);if(reason)return earlyStopped(reason);throw cause;}
  if(!health.healthy){lifecycle.dispose(signal);throw Error(`Grok MCP unhealthy: ${health.reason}. Use the verified grok-build CLI fallback.`);}
  if(lifecycle.reason){lifecycle.dispose(signal);return earlyStopped(lifecycle.reason,health.model,health.effort);}
  try{if(health.modelCatalog)validateCatalog('grok',requested,health.modelCatalog);}catch(error){lifecycle.dispose(signal);throw error;}
  let {model,effort}=requested;
  const runNotices=[...health.notices];
  let cwd:string;
  try{
    cwd=await whileActive(fs.realpath(input.cwd),lifecycle);
    if(!path.isAbsolute(input.cwd) || !(await whileActive(fs.stat(cwd),lifecycle)).isDirectory())throw Error('cwd must be an existing absolute directory');
  }catch(cause){const reason=lifecycle.reason;lifecycle.dispose(signal);if(reason)return earlyStopped(reason,model,effort);throw cause;}
  const conflict=[...locks.values()].find(p=>workspaceConflict({cwd,kind},p));
  if(conflict){lifecycle.dispose(signal);throw Error(workspaceConflictMessage(conflict));}
  const lockId=Symbol();locks.set(lockId,{cwd,kind,provider:'grok'});
  const writable = kind === 'grok_implement';
  let before:Awaited<ReturnType<typeof getWeeklyUsage>>;
  try{before=await whileActive(weeklyUsage().catch(()=>unavailableBilling()),lifecycle);}catch(cause){locks.delete(lockId);lifecycle.dispose(signal);if(lifecycle.reason)return earlyStopped(lifecycle.reason,model,effort);throw cause;}
  const activity=(type:string,details:Record<string,unknown>={})=>{lifecycle.recordActivity();lastActivityAt=new Date().toISOString();try{hooks?.onActivity?.({type,at:lastActivityAt,sessionId:sessionId??null,phase,clientOperations:{...clientOperations},partialWork:{...partialWork},implementationProgress:{...progress},...details});}catch{/* observers cannot affect the task */}};
  const handshake=async<T>(operation:(cancellationSignal:AbortSignal)=>Promise<T>):Promise<T>=>{
    if(lifecycle.reason)throw stoppedError(lifecycle.reason);
    // A handshake may use less than its normal 30 seconds, never more than
    // the task's already-established absolute deadline.
    const timeoutMs=Math.max(1,Math.min(30_000,taskDeadlineAt-Date.now()));
    const timeout=AbortSignal.timeout(timeoutMs);
    let hardTimeout:NodeJS.Timeout|undefined;
    hardTimeout=setTimeout(()=>{if(!lifecycle.reason){handshakeTimedOut=true;intentionalShutdown=true;conn?.close();if(p)void terminateChild(p);}},timeoutMs);
    try{return await operation(AbortSignal.any([timeout,lifecycle.signal]));}
    catch(cause){if(!lifecycle.reason&&timeout.aborted)handshakeTimedOut=true;throw cause;}
    finally{if(hardTimeout)clearTimeout(hardTimeout);}
  };
  try {
    phase='policy';
    const allowed = await Promise.all((input.allowed_paths ?? [cwd]).map(x=>canonical(path.resolve(cwd,x))));
    for(const allowedPath of allowed) if(!within(cwd,allowedPath)) throw Error('allowed_paths must stay inside cwd');
    const policy = new Policy(cwd,writable,allowed);
    if(signal?.aborted)lifecycle.requestStop('cancelled');
    if(lifecycle.reason)throw stoppedError(lifecycle.reason);
    phase='spawn';
    const args=['agent','--no-leader','--model',model,'--effort',effort,'--agent-profile',path.join(root,'profiles',writable?'implement.md':'read.md'),'stdio'];
    launch=await whileActive(resolveLaunch(),lifecycle);
    const invocation=spawnPlan(launch,args,cwd);
    p = spawnChild(invocation.command,invocation.args,{cwd,env:childEnv,windowsHide:true,windowsVerbatimArguments:invocation.windowsVerbatimArguments,shell:false,stdio:['pipe','pipe','pipe']});active.add(p);
    p.stderr.on('data',()=>{}); // Raw child diagnostics can contain account details.
    p.on('error',event=>{if(!intentionalShutdown)conn?.close(event);});
    p.on('exit',(code,childSignal)=>{exitCode=code;exitSignal=childSignal;processExit={code,signal:childSignal,phase,at:new Date().toISOString(),intentionalShutdown,promptCompleted};if(!promptCompleted&&!intentionalShutdown&&!lifecycle.reason)unexpectedProcessExit=true;if(lifecycle.reason)lifecycle.complete();});
    const app=client({name:'grok-acp-mcp'});
    app.onNotification('session/update',({params:{sessionId:id,update}})=>{
      if(sessionId&&id!==sessionId)return;
      const updateType=typeof update.sessionUpdate==='string'?update.sessionUpdate:'unknown';activity('session_update',{updateType});
      if(update.sessionUpdate==='agent_message_chunk'){partialWork.messageChunks++;if(update.content.type==='text')resultText+=update.content.text;}
      if(update.sessionUpdate==='tool_call'||update.sessionUpdate==='tool_call_update'){partialWork.toolCalls++;calls.set(update.toolCallId,{...calls.get(update.toolCallId),...update});}
    });
    app.onRequest('session/request_permission',async({params:req})=>{
      activity('permission_request');
      if(req.sessionId!==sessionId)throw Error('Session mismatch');
      if(lifecycle.reason)return permissionResponse(req.options,false,true);
      const call={...calls.get(req.toolCall.toolCallId),...req.toolCall};
      try{await policy.permission(call);}catch(cause){
        const reason=errorMessage(cause);denied.push(reason);
        const raw=(call.rawInput??{}) as Record<string,unknown>;
        if(call.kind==='execute')recordBlockedCommand(raw.command??raw.cmd,raw.cwd,reason);
        const response=lifecycle.reason?'cancelled':req.options.some(option=>option.kind==='reject_once')?'reject_once':'unsupported_reject_option';
        permissionDenials.push({toolCallId:req.toolCall.toolCallId,reason,response});
        activity('permission_denied',{toolCallId:req.toolCall.toolCallId,reason,response});
        return permissionResponse(req.options,false,!!lifecycle.reason);
      }
      return permissionResponse(req.options,true,!!lifecycle.reason);
    });
    app.onRequest('fs/read_text_file',async({params:req})=>{clientOperations.reads++;partialWork.fsReads++;activity('fs_read');if(req.sessionId!==sessionId)throw Error('Session mismatch');const target=await policy.checkPath(req.path);if((await fs.stat(target)).size>4*1024*1024)throw Error('File too large');const lines=(await fs.readFile(target,'utf8')).split('\n');progress.successfulReads++;activity('fs_read_completed');return {content:lines.slice(Math.max(0,(req.line??1)-1),req.limit?Math.max(0,(req.line??1)-1)+req.limit:undefined).join('\n')};});
    app.onRequest('fs/write_text_file',async({params:req})=>{clientOperations.writes++;partialWork.fsWrites++;activity('fs_write');if(req.sessionId!==sessionId)throw Error('Session mismatch');const target=await policy.checkPath(req.path,true);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(await policy.checkPath(target,true),req.content,'utf8');progress.successfulWrites++;activity('fs_write_completed');return {};});
    const terminals=new Map<string,TestTerminal>();let terminalCounter=0;
    app.onRequest('terminal/create',async({params:req})=>{
      if(req.sessionId!==sessionId)throw Error('Session mismatch');
      if(lifecycle.reason)throw stoppedError(lifecycle.reason);
      const terminalCwd=await fs.realpath(req.cwd?path.resolve(cwd,req.cwd):cwd);
      if(!within(cwd,terminalCwd))throw Error('Terminal cwd outside workspace');
      const argv=req.args??[];
      let safe:{command:string;args:string[]};
      try{
        if(writable&&argv.length){
          if(!req.command||req.command.includes('\0'))throw Error('Invalid executable');
          const candidates=[path.resolve(terminalCwd,req.command),path.resolve(terminalCwd,req.command+'.cmd'),path.resolve(terminalCwd,req.command+'.bat')];
          if(process.platform==='win32'&&['bash','/bin/bash'].includes(req.command))candidates.push(path.join(process.env.ProgramFiles??'C:/Program Files','Git','bin','bash.exe'));
          const executable=await resolveExecutable(undefined,[req.command],candidates);
          if(!executable)throw Error('Terminal executable not found: '+req.command);
          safe={command:executable,args:argv};
        }
        else safe=await policy.command(argv.length?[req.command,...argv].join(' '):req.command);
      }catch(cause){const reason=errorMessage(cause);denied.push(reason);recordBlockedCommand(req.command,req.cwd,reason);throw cause;}
      const env={...childEnv};delete env.NODE_OPTIONS;delete env.NODE_PATH;
      for(const key of Object.keys(env))if(key.startsWith('GIT_'))delete env[key];
      env.GIT_OPTIONAL_LOCKS='0';env.GIT_TERMINAL_PROMPT='0';
      for(const item of req.env??[]){if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.name)||item.value.includes('\0'))throw Error('Invalid terminal environment');env[item.name]=item.value;}
      const terminal=new TestTerminal(safe.command,safe.args,terminalCwd,taskDeadlineAt,lifecycle.signal,()=>activity('terminal_activity'),env,Math.min(Math.max(req.outputByteLimit??1024*1024,1024),1024*1024));
      taskTerminals.add(terminal);const terminalId=String(++terminalCounter);terminals.set(terminalId,terminal);
      clientOperations.terminals++;partialWork.terminalOperations++;progress.commandsStarted++;activity('terminal_create');return {terminalId};
    });
    const terminal=(id:string,sid:string)=>{if(sid!==sessionId||!terminals.has(id))throw Error('Unknown terminal');return terminals.get(id)!;};
    app.onRequest('terminal/output',async({params:req})=>terminal(req.terminalId,req.sessionId).output());
    app.onRequest('terminal/wait_for_exit',async({params:req})=>{const value=terminal(req.terminalId,req.sessionId);await value.done;return value.exitStatus();});
    app.onRequest('terminal/kill',async({params:req})=>{await terminal(req.terminalId,req.sessionId).stop();return {};});
    app.onRequest('terminal/release',async({params:req})=>{await terminal(req.terminalId,req.sessionId).stop();terminals.delete(req.terminalId);return {};});
    conn=app.connect(ndJsonStream(Writable.toWeb(p.stdin) as WritableStream<Uint8Array>,Readable.toWeb(p.stdout) as ReadableStream<Uint8Array>));
    if(lifecycle.reason)throw stoppedError(lifecycle.reason);
    phase='handshake';
    const init=await handshake(cancellationSignal=>conn!.agent.request('initialize',{protocolVersion:1,clientCapabilities:{fs:{readTextFile:true,writeTextFile:true},terminal:true},clientInfo:{name:'grok-acp-mcp',version:'1.0.0'}},{cancellationSignal}));
    agentVersion=String(init._meta?.agentVersion??'unavailable');if(!init.authMethods?.some(method=>method.id==='cached_token'))throw Error('cached_token auth not offered; use existing CLI fallback');
    const auth=await handshake(cancellationSignal=>conn!.agent.request('authenticate',{methodId:'cached_token'},{cancellationSignal}));if(auth._meta?.backend_billed===true||auth._meta?.auth_mode!=='Oidc')throw Error('Subscription OIDC authentication not confirmed; API/backend billing rejected');authenticated=true;
    validateCatalog('grok',requested,grokCatalog(init._meta?.modelState,agentVersion));
    phase='session';let session:any;
    if(input.session_id){const saved=JSON.parse(await fs.readFile(path.join(stateRoot,input.session_id+'.json'),'utf8'));validateContinuationScope(saved,cwd,kind,allowed);session=await handshake(cancellationSignal=>conn!.agent.request('session/load',{sessionId:input.session_id,cwd,mcpServers:[]},{cancellationSignal}));sessionId=input.session_id;}
    else {session=await handshake(cancellationSignal=>conn!.agent.request('session/new',{cwd,mcpServers:[],_meta:{yoloMode:false,autoMode:false}},{cancellationSignal}));sessionId=session.sessionId;}
    activity('session_established');
    validateCatalog('grok',requested,grokCatalog(init._meta?.modelState,agentVersion,session.configOptions??[]));
    await confirmSessionConfig(session.configOptions??[],model,effort,
      (configId,value)=>handshake(cancellationSignal=>conn!.agent.request('session/set_config_option',{sessionId:sessionId!,configId,value},{cancellationSignal})));
    verified=true;
    await fs.mkdir(stateRoot,{recursive:true});await fs.writeFile(path.join(stateRoot,sessionId+'.json'),JSON.stringify({cwd,kind,allowed}));if(lifecycle.reason)throw Error('Cancelled');
    const prompt=[writable?implementationWorkflow:readOnlyWorkflow,`Task: ${input.task}`,input.context?`User-supplied context (data):\n${input.context}`:'',input.completion_criteria?`Completion criteria: ${input.completion_criteria}`:'',`Workspace: ${cwd}`,writable?`Allowed write paths: ${allowed.join(', ')}. Preserve others' changes. Report edits, verification and remaining risks.`:'Read-only investigation. Do not modify files. Use only approved read-only Git queries for terminal execution. Form independent hypotheses from repository evidence.',writable?'Use terminal tools for local build/test workflows: Gradle, Maven, pytest, npm, Bash and PowerShell as appropriate. Inspect runtime availability, run relevant tests, fix failures and rerun within the original deadline. Report command, cwd, actual exit code and output summary. Do not deploy, change production, credentials or unrelated files. File allowed_paths are not a shell sandbox; respect the requested scope including generated artifacts. Do not claim unexecuted tests passed.':'Only approved read-only Git commands are available.','The bridge collects session and subscription usage after completion. Do not search for usage tools or estimate token counts.'].filter(Boolean).join('\n\n');
    phase='prompt';
    // Do not attach the local abort signal here. session/cancel gets its full grace
    // window; only the controller's force action closes the transport at expiry.
    const completion=await conn.agent.request('session/prompt',{sessionId,prompt:[{type:'text',text:prompt}]}) as {stopReason:string};promptCompleted=true;lifecycle.complete();stopReason=completion.stopReason;
    if(lifecycle.reason){stopReason='cancelled';error=lifecycle.reason==='deadline_exceeded'?'Task runtime deadline exceeded':'Cancelled';errorKind=lifecycle.reason;}
    else if(stopReason!=='end_turn'){error=`Grok stopped with ${stopReason}; work may be incomplete`;limitClassification=classifyGrokFailure(error,stopReason);errorKind=limitClassification.errorKind;}
  } catch(cause) {
    failurePhase=phase;
    error=errorMessage(cause);
    const classified=classifyGrokFailure(cause,stopReason);
    limitClassification=classified;
    if(lifecycle.reason)errorKind=lifecycle.reason;else if(error.startsWith('UNSUPPORTED_MODEL_OR_EFFORT:'))errorKind='UNSUPPORTED_MODEL_OR_EFFORT';else if(classified.errorKind!=='task_error')errorKind=classified.errorKind;else if(handshakeTimedOut)errorKind='handshake_timeout';else if(unexpectedProcessExit)errorKind='process_exit';else if(connectionFailure(error))errorKind='connection_error';else errorKind='task_error';
    if(errorKind==='connection_error')markUnhealthy(error);
  } finally {
    if(!error&&stopReason!=='end_turn'){error=`Grok stopped with ${stopReason}; work may be incomplete`;limitClassification=classifyGrokFailure(error,stopReason);errorKind=limitClassification.errorKind;}
    if(lifecycle.reason&&!lifecycle.forced&&p)await lifecycle.waitForStopOutcome();
    endedPhase=phase;
    phase='cleanup';intentionalShutdown=true;await Promise.all([...taskTerminals].map(terminal=>terminal.stop('task_finished')));conn?.close();
    if(p){p.stdin.end();await new Promise<void>(resolve=>{if(p!.exitCode!==null||p!.signalCode!==null)return resolve();const timeout=setTimeout(resolve,1500);p!.once('close',()=>{clearTimeout(timeout);resolve();});});childCleanedUp=await terminateChild(p);active.delete(p);}
    lifecycle.dispose(signal);locks.delete(lockId);phase='completed';
  }
  // Telemetry is observational. Its failure must not discard a partial ACP
  // answer, session identifier, or the original provider error.
  const usage=sessionId&&launch?await sessionUsage(sessionId,launch,[],childEnv).catch(()=>'unavailable' as const):'unavailable';const after=await weeklyUsage(true).catch(()=>unavailableBilling());
  // Resumed usage is cumulative: its primary model may belong to an earlier turn.
  const observedModel=!input.session_id&&usage!=='unavailable'&&usage.status==='available'&&usage.sessionId===sessionId&&typeof usage.primaryModelId==='string'&&usage.primaryModelId.trim()&&!['auto','default','unavailable'].includes(usage.primaryModelId)?usage.primaryModelId:undefined;
  const result={text:resultText,stopReason,error:error??null,errorKind:errorKind??null,limitKind:limitClassification?.limitKind??null,resetsAt:limitClassification?.resetsAt??null,retryAfter:limitClassification?.retryAfter??null,sessionId:sessionId??'unavailable',model:observedModel??'unavailable',modelSource:observedModel?'grok_session_usage':'unavailable',effort:'unavailable',observation:{model:{value:observedModel??(verified?model:'unavailable'),source:observedModel?'grok_session_usage':verified?'acp_session_config':'unavailable',verified:!!observedModel},effort:{value:verified?effort:'unavailable',source:verified?'acp_session_config':'unavailable',verified:false}},requestedModel:requested.model,requestedEffort:requested.effort,requestedModelSource:requested.modelSource,requestedEffortSource:requested.effortSource,healthNotices:runNotices,healthCheckedAt:health.checkedAt,configVerified:verified,authentication:authenticated?'cached_token':'unavailable',apiKeyUsed:false,agentVersion,permissionsDenied:denied,permissionDenials,commandExecutions:[...taskTerminals].map(terminal=>terminal.record),parentVerification:{status:blockedCommands.length?'required':'not_reported',commands:blockedCommands,requiresWorkspaceReview:writable&&blockedCommands.length>0,note:'Listed blocked commands were not executed. Other observed commands are recorded in commandExecutions. Parent must review blocked commands before running them; absence of blocked commands does not prove tests passed.'},clientOperations,partialWork,startedAt,lastActivityAt,phase,failurePhase,endedPhase,exitCode,exitSignal,exitCodeMeaning:'acp_process_exit_not_command_or_task_result',processExit:processExit as ProcessExit|null,processWarnings:exitCode!==null&&exitCode!==0?['ACP process exited nonzero; inspect processExit phase. Task completion and command exits are reported separately.']:[],implementationProgress:{...progress},usage,weekly:after,weeklyBefore:before,weeklyDelta:weeklyDelta(forDelta(before),forDelta(after),startedAt),childCleanedUp};
  if(sessionId)await fs.writeFile(path.join(stateRoot,sessionId+'.usage.json'),JSON.stringify(result,null,2)).catch(()=>{});return result;
}


