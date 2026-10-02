import {selectedInput} from './selection-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {classifyGrokFailure,runGrok, type RunGrokDependencies} from '../src/acp.js';
import {classifyGrokRunFailure,overlayGrokQuota} from '../src/providers/grok.js';
import {BillingReader} from '../src/billing.js';
import {getSessionUsage} from '../src/usage.js';

const fixtureServer=String.raw`
let buffer='',promptId,writeId=900,cwd='',model='fixture-model',effort='xhigh';
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
function reply(id,result){send({jsonrpc:'2.0',id,result});}
function receive(message){
 if(message.method==='initialize')return reply(message.id,{protocolVersion:1,authMethods:[{id:'cached_token'}],_meta:{agentVersion:'fixture-agent'}});
 if(message.method==='authenticate')return reply(message.id,{_meta:{auth_mode:'Oidc',backend_billed:false}});
 if(message.method==='session/new'){cwd=message.params.cwd;return reply(message.id,{sessionId:'fixture-session',configOptions:[]});}
 if(message.method==='session/set_config_option'){if(message.params.configId==='model')model=message.params.value;if(message.params.configId==='reasoning_effort')effort=message.params.value;return reply(message.id,{configOptions:[{id:'model',type:'select',currentValue:model},{id:'reasoning_effort',type:'select',currentValue:effort}]});}
 if(message.method==='session/prompt'){
  promptId=message.id;
  send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'fixture-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'partial fixture answer'}}}});
  send({jsonrpc:'2.0',id:writeId,method:'fs/write_text_file',params:{sessionId:'fixture-session',path:cwd+'/fixture-edit.txt',content:'fixture edit'}});
  return;
 }
 if(message.id===writeId&&promptId!==undefined)send({jsonrpc:'2.0',id:promptId,error:{code:429,message:'request throttled',data:{headers:{'retry-after':'30'}}}});
}
process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{buffer+=chunk;for(;;){const end=buffer.indexOf('\n');if(end<0)return;const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(line)receive(JSON.parse(line));}});
`;

function fixtureDependencies(stateRoot:string,telemetryFails=false):RunGrokDependencies {
 return {
  ensureHealth:async()=>({healthy:true,version:'fixture',fingerprint:'fixture',checkedAt:new Date().toISOString(),model:'fixture-model',effort:'xhigh',notices:[]}),
  getWeeklyUsage:async()=>{if(telemetryFails)throw Error('fixture billing failure');return {status:'unavailable',fresh:false,source:'unavailable',stale:true};},
  getSessionUsage:async()=>{if(telemetryFails)throw Error('fixture usage failure');return {status:'available',sessionId:'fixture-session',inputTokens:11,outputTokens:7,reasoningTokens:3,totalTokens:21};},
  spawn:((_command:string,_args:string[],options:any)=>spawn(process.execPath,['--input-type=module','--eval',fixtureServer],options) as ChildProcessWithoutNullStreams) as typeof spawn,
  terminate:async process=>{if(process.exitCode===null&&process.signalCode===null)process.kill();return true;},
  stateRoot,
 };
}
test('Grok per-call model/effort is confirmed on ACP session without changing health defaults',async()=>{
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'grok-model-override-'));
 const modelState={currentModelId:'grok-4.6',availableModels:['grok-4.6','grok-5'].map(modelId=>({modelId,_meta:{agentType:'grok-build',supportsReasoningEffort:true,reasoningEfforts:[{id:'xhigh'},{id:'high'}]}}))};
 const server=fixtureServer.replace("agentVersion:'fixture-agent'",`agentVersion:'fixture-agent',modelState:${JSON.stringify(modelState)}`).replace("send({jsonrpc:'2.0',id:promptId,error:{code:429,message:'request throttled',data:{headers:{'retry-after':'30'}}}})","reply(promptId,{stopReason:'end_turn'})");
 const deps=fixtureDependencies(path.join(cwd,'state'));
 deps.spawn=((_command:string,_args:string[],options:any)=>spawn(process.execPath,['--input-type=module','--eval',server],options) as ChildProcessWithoutNullStreams) as typeof spawn;
 try{
  const result:any=await runGrok('grok_implement',selectedInput({cwd,task:'fixture',model:'grok-5',effort:'high'}, 'grok'),undefined,undefined,deps);
  assert.equal(result.error,null);assert.equal(result.model,'unavailable');assert.equal(result.effort,'unavailable');assert.equal(result.observation.model.value,'grok-5');assert.equal(result.observation.model.verified,false);assert.equal(result.observation.model.source,'acp_session_config');assert.ok('requestedModel' in result);if('requestedModel' in result){assert.equal(result.requestedModel,'grok-5');assert.equal(result.configVerified,true);}
  const bad:any=await runGrok('grok_implement',selectedInput({cwd,task:'fixture',provider_options:{grok:{model:'grok-missing',effort:'high'}}}, 'grok'),undefined,undefined,deps);
  assert.match(bad.error??'',/UNSUPPORTED_MODEL_OR_EFFORT/);if('clientOperations' in bad)assert.equal(bad.clientOperations.writes,0);
  const defaultRun:any=await runGrok('grok_implement',{cwd,task:'fixture'},undefined,undefined,deps);
  assert.equal(defaultRun.errorKind,'MODEL_SELECTION_REQUIRED');
 }finally{await fs.rm(cwd,{recursive:true,force:true});}
});

test('ACP end_turn and nonzero cleanup exit remain distinct and successful writes are observed',async()=>{
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'grok-exit-evidence-'));
 const server=fixtureServer.replace("send({jsonrpc:'2.0',id:promptId,error:{code:429,message:'request throttled',data:{headers:{'retry-after':'30'}}}})","reply(promptId,{stopReason:'end_turn'})")+"\nprocess.stdin.on('end',()=>process.exit(1));";
 const deps=fixtureDependencies(path.join(cwd,'state'));
 deps.spawn=((_command:string,_args:string[],options:any)=>spawn(process.execPath,['--input-type=module','--eval',server],options) as ChildProcessWithoutNullStreams) as typeof spawn;
 const events:any[]=[];
 try{
  const result:any=await runGrok('grok_implement',selectedInput({cwd,task:'fixture',max_runtime_minutes:1}, 'grok'),undefined,{onActivity:e=>events.push(e)},deps);
  assert.equal(result.error,null);assert.equal(result.stopReason,'end_turn');assert.equal(result.exitCode,1);
  assert.ok('processExit' in result);if(!('processExit' in result))return;
  assert.equal(result.processExit?.phase,'cleanup');assert.equal(result.processExit?.promptCompleted,true);assert.equal(result.processExit?.intentionalShutdown,true);
  assert.equal(result.implementationProgress.successfulWrites,1);assert.ok(result.processWarnings.length);
  assert.ok(events.some(e=>e.implementationProgress?.successfulWrites===1));
 }finally{await fs.rm(cwd,{recursive:true,force:true});}
});
test('ACP process exit before turn completion remains a task failure',async()=>{
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'grok-premature-exit-'));
 const deps=fixtureDependencies(path.join(cwd,'state'));
 const server=fixtureServer.replace('promptId=message.id;', 'process.exit(7);');
 deps.spawn=((_command:string,_args:string[],options:any)=>spawn(process.execPath,['--input-type=module','--eval',server],options) as ChildProcessWithoutNullStreams) as typeof spawn;
 try{
  const result:any=await runGrok('grok_implement',selectedInput({cwd,task:'fixture',max_runtime_minutes:1}, 'grok'),undefined,undefined,deps);
  assert.ok(result.error);assert.notEqual(result.stopReason,'end_turn');assert.equal(result.exitCode,7);
  assert.ok('processExit' in result);if('processExit' in result)assert.equal(result.processExit?.promptCompleted,false);
 }finally{await fs.rm(cwd,{recursive:true,force:true});}
});

test('ACP continuation enforces narrowed write scope and persists it for later resumes',async()=>{
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'grok-resume-'));
 const stateRoot=path.join(cwd,'state'),target=path.join(cwd,'fixture-edit.txt');
 const deps=fixtureDependencies(stateRoot);
 const server=fixtureServer.replace("if(message.method==='session/new')","if(message.method==='session/new'||message.method==='session/load')");
 deps.spawn=((_command:string,_args:string[],options:any)=>spawn(process.execPath,['--input-type=module','--eval',server],options) as ChildProcessWithoutNullStreams) as typeof spawn;
 try{
  await fs.mkdir(stateRoot);await fs.writeFile(path.join(stateRoot,'fixture-session.json'),JSON.stringify({cwd:await fs.realpath(cwd),kind:'grok_implement',allowed:[await fs.realpath(cwd)]}));
  const result:any=await runGrok('grok_implement',selectedInput({cwd,task:'only edit target',session_id:'fixture-session',allowed_paths:[target],max_runtime_minutes:1}, 'grok'),undefined,undefined,deps);
  assert.equal(result.sessionId,'fixture-session');assert.equal(await fs.readFile(target,'utf8'),'fixture edit');
  const saved=JSON.parse(await fs.readFile(path.join(stateRoot,'fixture-session.json'),'utf8'));assert.deepEqual(saved.allowed,[target]);
  const expanded:any=await runGrok('grok_implement',selectedInput({cwd,task:'broader',session_id:'fixture-session',max_runtime_minutes:1}, 'grok'),undefined,undefined,deps);
  assert.match(expanded.error??'',/expands/);assert.ok('clientOperations' in expanded);if('clientOperations' in expanded)assert.equal(expanded.clientOperations.writes,0);
  await fs.writeFile(target,'preserved original');
  const denied:any=await runGrok('grok_implement',selectedInput({cwd,task:'no writes',session_id:'fixture-session',allowed_paths:[],max_runtime_minutes:1}, 'grok'),undefined,undefined,deps);
  assert.equal(await fs.readFile(target,'utf8'),'preserved original');assert.deepEqual(JSON.parse(await fs.readFile(path.join(stateRoot,'fixture-session.json'),'utf8')).allowed,[]);
  assert.equal(denied.sessionId,'fixture-session');
 }finally{await fs.rm(cwd,{recursive:true,force:true});}
});

test('Grok ACP allows parallel readers and retains each lock until cancellation',async()=>{
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'grok-reader-locks-'));
 const controllers=[new AbortController(),new AbortController(),new AbortController()];
 let entered=0;const promises:ReturnType<typeof runGrok>[]=[];
 const deps={...fixtureDependencies(path.join(cwd,'state')),getWeeklyUsage:()=>{entered++;return new Promise<any>(()=>{});}};
 const start=(kind:string,index:number)=>{const p=runGrok(kind,selectedInput({cwd,task:'fixture',max_runtime_minutes:1}, 'grok'),controllers[index].signal,undefined,deps);promises.push(p);return p;};
 const reached=async(n:number)=>{for(let i=0;i<200&&entered<n;i++)await new Promise(r=>setTimeout(r,5));assert.equal(entered,n);};
 try{
  start('grok_ask',0);await reached(1);start('grok_review',1);await reached(2);
  await assert.rejects(()=>runGrok('grok_implement',selectedInput({cwd,task:'blocked'}, 'grok'),undefined,undefined,deps),/overlapping/);
  controllers[0].abort();await promises[0];
  await assert.rejects(()=>runGrok('grok_implement',selectedInput({cwd,task:'still blocked'}, 'grok'),undefined,undefined,deps),/overlapping/);
  controllers[1].abort();await promises[1];
  start('grok_implement',2);await reached(3);
  await assert.rejects(()=>runGrok('grok_ask',selectedInput({cwd,task:'blocked reader'}, 'grok'),undefined,undefined,deps),/overlapping/);
 }finally{controllers.forEach(c=>c.abort());await Promise.allSettled(promises);await fs.rmdir(cwd);}
});

test('ACP rejects a test command once and continues the turn with parent verification metadata',async()=>{
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'grok-permission-fixture-'));
 const server=fixtureServer.replace(
  "send({jsonrpc:'2.0',id:writeId,method:'fs/write_text_file',params:{sessionId:'fixture-session',path:cwd+'/fixture-edit.txt',content:'fixture edit'}});",
  "send({jsonrpc:'2.0',id:writeId,method:'session/request_permission',params:{sessionId:'fixture-session',toolCall:{toolCallId:'test-command',title:'Run tests',kind:'execute',rawInput:{command:'gradlew.bat test --offline',cwd}},options:[{kind:'allow_once',name:'Allow',optionId:'allow'},{kind:'reject_once',name:'Reject',optionId:'reject'}]}});"
 ).replace(
  "if(message.id===writeId&&promptId!==undefined)send({jsonrpc:'2.0',id:promptId,error:{code:429,message:'request throttled',data:{headers:{'retry-after':'30'}}}});",
  "if(message.id===writeId&&promptId!==undefined){if(message.result?.outcome?.outcome!=='selected'||message.result.outcome.optionId!=='reject')throw Error('Expected rejection, not cancellation');reply(promptId,{stopReason:'end_turn'});}"
 );
 const deps=fixtureDependencies(path.join(cwd,'state'));
 deps.spawn=((_command:string,_args:string[],options:any)=>spawn(process.execPath,['--input-type=module','--eval',server],options) as ChildProcessWithoutNullStreams) as typeof spawn;
 try{
  const result:any=await runGrok('grok_review',selectedInput({task:'fixture',cwd,max_runtime_minutes:1}, 'grok'),undefined,undefined,deps);
  assert.equal(result.error,null);assert.equal(result.stopReason,'end_turn');assert.equal(result.text,'partial fixture answer');
  assert.ok('parentVerification' in result);if(!('parentVerification' in result))return;
  assert.equal(result.parentVerification.status,'required');assert.equal(result.parentVerification.requiresWorkspaceReview,false);
  assert.equal(result.parentVerification.commands[0].command,'gradlew.bat test --offline');
  assert.equal(result.parentVerification.commands[0].executionStatus,'not_executed');
  assert.equal(result.parentVerification.commands[0].cwd,cwd);
  assert.equal(result.permissionDenials[0].response,'reject_once');assert.equal(result.clientOperations.terminals,0);
  assert.equal(result.effort,'unavailable');assert.equal(result.selection.effort.value,'xhigh');assert.notEqual(result.usage,'unavailable');
  if(result.usage!=='unavailable')assert.equal(result.usage.totalTokens,21);
 }finally{await fs.rm(cwd,{recursive:true,force:true});}
});

test('implementation ACP terminal runs a local command and records real output and nonzero exit',async()=>{
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'grok-terminal-fixture-'));
 const request=JSON.stringify({jsonrpc:'2.0',id:900,method:'terminal/create',params:{sessionId:'fixture-session',command:process.execPath,args:['-e','console.log("TEST_EXECUTED");process.exit(7)']}});
 const server=fixtureServer.replace(
  "send({jsonrpc:'2.0',id:writeId,method:'fs/write_text_file',params:{sessionId:'fixture-session',path:cwd+'/fixture-edit.txt',content:'fixture edit'}});",
  `send(${request});`
 ).replace(
  "if(message.id===writeId&&promptId!==undefined)send({jsonrpc:'2.0',id:promptId,error:{code:429,message:'request throttled',data:{headers:{'retry-after':'30'}}}});",
  "if(message.id===900){if(message.error)throw Error(JSON.stringify(message.error));send({jsonrpc:'2.0',id:901,method:'terminal/wait_for_exit',params:{sessionId:'fixture-session',terminalId:message.result.terminalId}});} if(message.id===901){if(message.result?.exitCode!==7)throw Error('Wrong exit');reply(promptId,{stopReason:'end_turn'});}"
 );
 const deps=fixtureDependencies(path.join(cwd,'state'));
 deps.spawn=((_command:string,_args:string[],options:any)=>spawn(process.execPath,['--input-type=module','--eval',server],options) as ChildProcessWithoutNullStreams) as typeof spawn;
 try{
  const result:any=await runGrok('grok_implement',selectedInput({task:'fixture',cwd,max_runtime_minutes:1}, 'grok'),undefined,undefined,deps);
  assert.equal(result.error,null);assert.ok('commandExecutions' in result);if(!('commandExecutions' in result))return;
  assert.equal(result.commandExecutions[0].exitCode,7);assert.match(result.commandExecutions[0].output,/TEST_EXECUTED/);assert.equal(result.commandExecutions[0].cwd,cwd);
 }finally{await fs.rm(cwd,{recursive:true,force:true});}
});

test('runGrok fixture preserves partial work and structured ACP rate failure',async()=>{
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'grok-acp-fixture-'));const stateRoot=path.join(cwd,'state');
 try{
  const result:any=await runGrok('grok_implement',selectedInput({task:'fixture task',cwd,max_runtime_minutes:1}, 'grok'),undefined,undefined,fixtureDependencies(stateRoot));
  assert.equal(result.errorKind,'rate_limited');assert.equal(result.limitKind,'rate_limited');assert.equal(result.resetsAt,null);assert.ok(typeof result.retryAfter==='string');
  assert.equal(result.text,'partial fixture answer');assert.equal(result.sessionId,'fixture-session');assert.equal(result.model,'unavailable');assert.equal(result.selection.model.value,'fixture-model');assert.equal(result.childCleanedUp,true);
  assert.deepEqual(result.usage,{status:'available',sessionId:'fixture-session',inputTokens:11,outputTokens:7,reasoningTokens:3,totalTokens:21});
  assert.equal(await fs.readFile(path.join(cwd,'fixture-edit.txt'),'utf8'),'fixture edit');
  assert.ok(await fs.stat(path.join(stateRoot,'fixture-session.json')));
 }finally{await fs.rm(cwd,{recursive:true,force:true});}
});

test('runGrok fixture keeps the provider failure when both telemetry reads reject',async()=>{
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'grok-acp-telemetry-'));const stateRoot=path.join(cwd,'state');
 try{
  const result:any=await runGrok('grok_implement',selectedInput({task:'fixture task',cwd,max_runtime_minutes:1}, 'grok'),undefined,undefined,fixtureDependencies(stateRoot,true));
  assert.equal(result.errorKind,'rate_limited');assert.equal(result.text,'partial fixture answer');assert.equal(result.sessionId,'fixture-session');assert.equal(result.usage,'unavailable');
  assert.equal((result.weekly as {status:string}).status,'unavailable');assert.equal(await fs.readFile(path.join(cwd,'fixture-edit.txt'),'utf8'),'fixture edit');
 }finally{await fs.rm(cwd,{recursive:true,force:true});}
});

test('ACP structured rate failure keeps retry metadata and does not become a connection failure',()=>{
 const result=classifyGrokFailure({message:'request throttled',status:429,headers:{'retry-after':'30'}},undefined,1_700_000_000_000);
 assert.equal(result.errorKind,'rate_limited');
 assert.equal(result.limitKind,'rate_limited');
 assert.equal(result.retryAfter,'2023-11-14T22:13:50.000Z');
});

test('ACP failure metadata remains available to the provider cache layer',()=>{
 const result=classifyGrokRunFailure({
  error:'Grok stopped with rate_limited',errorKind:'rate_limited',limitKind:'rate_limited',
  retryAfter:'2030-01-01T00:00:30.000Z',resetsAt:null
 });
 assert.equal(result.limitKind,'rate_limited');
 assert.equal(result.retryAfter,'2030-01-01T00:00:30.000Z');
 assert.equal(result.resetsAt,null);
});

test('ACP stop reasons distinguish quota and context exhaustion',()=>{
 assert.equal(classifyGrokFailure(undefined,'quota_exhausted').errorKind,'quota_exhausted');
 assert.equal(classifyGrokFailure(undefined,'context_length_exceeded').errorKind,'context_limit');
});

test('provider result classification preserves lifecycle and connection errors',()=>{
 assert.equal(classifyGrokRunFailure({error:'request rate limit exceeded',errorKind:'deadline_exceeded'}).errorKind,'deadline_exceeded');
 assert.equal(classifyGrokRunFailure({error:'quota exhausted',errorKind:'connection_error'}).errorKind,'connection_error');
});

test('an active runtime quota block overlays a lagging billing result',()=>{
 const quota=overlayGrokQuota(
  {state:'available',source:'grok_billing',usedPercent:7,remainingPercent:93},
  {state:'exhausted',source:'runtime_limit_error',resetsAt:'2030-01-01T00:00:00.000Z',note:'runtime observed limit'}
 );
 assert.equal(quota.state,'exhausted');
 assert.equal(quota.resetsAt,'2030-01-01T00:00:00.000Z');
 assert.equal(quota.usedPercent,7);
 assert.match(quota.note??'',/runtime observed limit/);
});

test('a rate-limit cooldown never claims the billing-period end as its reset',()=>{
 const quota=overlayGrokQuota(
  {state:'available',source:'grok_billing',resetsAt:'2031-01-01T00:00:00.000Z'},
  {state:'exhausted',source:'runtime_limit_error',limitKind:'rate_limited',resetsAt:null,retryAfter:'2030-01-01T00:01:00.000Z'}
 );
 assert.equal(quota.state,'exhausted');
 assert.equal(quota.limitKind,'rate_limited');
 assert.equal(quota.resetsAt,null);
 assert.equal(quota.retryAfter,'2030-01-01T00:01:00.000Z');
});

test('Grok telemetry failures are unavailable snapshots instead of thrown task failures',async()=>{
 const billing=new BillingReader(async()=>{throw Error('billing unavailable');},async()=>{throw Error('log unavailable');});
 const weekly=await billing.read(true);
 assert.equal(weekly.status,'unavailable');
 const usage=await getSessionUsage('fixture','C:/definitely/missing/grok.exe',[],{});
 assert.equal(usage,'unavailable');
});


test('Grok exact-session usage promotes runtime model while config-only effort remains unverified',async()=>{
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'grok-observed-model-'));
 const deps=fixtureDependencies(path.join(cwd,'state'));
 deps.getSessionUsage=async()=>({status:'available',sessionId:'fixture-session',primaryModelId:'runtime-grok',inputTokens:1,outputTokens:1,reasoningTokens:1,totalTokens:3});
 try{
  const result=await runGrok('grok_implement',selectedInput({task:'fixture',cwd},'grok'),undefined,undefined,deps);
  assert.equal(result.model,'runtime-grok');assert.equal(result.modelSource,'grok_session_usage');assert.deepEqual(result.observation?.model,{value:'runtime-grok',source:'grok_session_usage',verified:true});
  assert.equal(result.effort,'unavailable');assert.equal(result.observation?.effort.verified,false);assert.equal(result.selection?.model.value,'fixture-model');
  const server=fixtureServer.replace("if(message.method==='session/new')","if(message.method==='session/new'||message.method==='session/load')");
  deps.spawn=((_command:string,_args:string[],options:any)=>spawn(process.execPath,['--input-type=module','--eval',server],options) as ChildProcessWithoutNullStreams) as typeof spawn;
  const resumed=await runGrok('grok_implement',selectedInput({task:'fixture',cwd,session_id:'fixture-session'},'grok'),undefined,undefined,deps);
  assert.equal(resumed.model,'unavailable');assert.equal(resumed.observation?.model.verified,false);
  deps.getSessionUsage=async()=>({status:'available',sessionId:'wrong-session',primaryModelId:'wrong-model',inputTokens:1,outputTokens:1,reasoningTokens:1,totalTokens:3});
  const wrong=await runGrok('grok_implement',selectedInput({task:'fixture',cwd},'grok'),undefined,undefined,deps);assert.equal(wrong.model,'unavailable');
 }finally{await fs.rm(cwd,{recursive:true,force:true});}
});
