import './isolated-environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {runGrok,type RunGrokDependencies} from '../src/acp.js';
import {terminateProcess,terminateProcessWithSnapshot} from '../src/process.js';
import {selectedInput} from './selection-fixture.js';

async function fixture(t:any,mode:'completed'|'hang'|'closed'|'terminal'){
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'grok-completion-')),children:ChildProcessWithoutNullStreams[]=[];
 const source=`
import readline from 'node:readline';
const mode=${JSON.stringify(mode)},sid='completion-fixture';let model='fixture-model',effort='xhigh',promptId,terminalId;
const send=v=>process.stdout.write(JSON.stringify(v)+'\\n'),reply=(id,result)=>send({jsonrpc:'2.0',id,result});
const message=text=>send({jsonrpc:'2.0',method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}});
setInterval(()=>{},1000);
for await(const line of readline.createInterface({input:process.stdin})){
 const m=JSON.parse(line);
 if(m.method==='initialize')reply(m.id,{protocolVersion:1,authMethods:[{id:'cached_token'}],_meta:{agentVersion:'fixture'}});
 else if(m.method==='authenticate')reply(m.id,{_meta:{auth_mode:'Oidc',backend_billed:false}});
 else if(m.method==='session/new')reply(m.id,{sessionId:sid,configOptions:[]});
 else if(m.method==='session/set_config_option'){
  if(m.params.configId==='model')model=m.params.value;else effort=m.params.value;
  reply(m.id,{configOptions:[{id:'model',type:'select',currentValue:model},{id:'reasoning_effort',type:'select',currentValue:effort}]});
 }else if(m.method==='session/prompt'){
  promptId=m.id;message('partial answer; Gradle='+String(process.env.GRADLE_USER_HOME));
  if(mode==='completed')reply(m.id,{stopReason:'end_turn'});
  else if(mode==='closed')process.exit(1);
  else if(mode==='terminal')send({jsonrpc:'2.0',id:900,method:'terminal/create',params:{sessionId:sid,command:process.execPath,args:['-e','console.log(process.env.GRADLE_USER_HOME)'],env:[{name:'GRADLE_USER_HOME',value:'do-not-use-shared-daemons'}]}});
 }else if(m.id===900){terminalId=m.result.terminalId;send({jsonrpc:'2.0',id:901,method:'terminal/wait_for_exit',params:{sessionId:sid,terminalId}});}
 else if(m.id===901)reply(promptId,{stopReason:'end_turn'});
 // Cancellation deliberately has no acknowledgement.
}
`;
 const deps:RunGrokDependencies={
  stateRoot:path.join(cwd,'state'),launch:async()=>process.execPath,
  ensureHealth:async()=>({healthy:true,version:'fixture',fingerprint:'fixture',checkedAt:new Date().toISOString(),model:'fixture-model',effort:'xhigh',notices:[]}),
  getWeeklyUsage:async()=>({status:'unavailable',fresh:false,source:'unavailable',stale:true}),
  getSessionUsage:async()=>({status:'available',sessionId:'completion-fixture',inputTokens:10,outputTokens:5,reasoningTokens:2,totalTokens:15,primaryModelId:'fixture-model'}),
  spawn:((_file:string,_args:string[],options:any)=>{const child=spawn(process.execPath,['--input-type=module','--eval',source],options) as ChildProcessWithoutNullStreams;children.push(child);return child;}) as typeof spawn,
  // This fixture has only its owned root; OS inventory latency is tested in
  // process-reuse, not inside the ACP protocol's one-second cleanup budget.
  terminate:child=>terminateProcessWithSnapshot(child,{snapshot:async()=>[]}),
  trackProcessTree:()=>({knownPids:()=>[],cancelCleanup:()=>{},cleanup:async()=>({trackedPids:[],remainingPids:[],verified:true,scope:'observed_descendants'})}),
  timing:{cancelGraceMs:100,cleanupMs:1000,telemetryMs:150,exitGraceMs:10}
 };
 t.after(async()=>{await Promise.all(children.map(terminateProcess));await fs.rm(cwd,{recursive:true,force:true});});
 return {cwd,deps,children};
}
function assertPartial(result:any){assert.match(result.text,/partial answer/);assert.equal(result.sessionId,'completion-fixture');assert.equal(result.usage.totalTokens,15);assert.equal(result.model,'fixture-model');assert.equal(result.observation.effort.value,'xhigh');assert.equal(result.observation.effort.verified,false);}

test('Grok explicit ACP completion survives hanging root cleanup and preserves result metadata',async t=>{
 const {cwd,deps}=await fixture(t,'completed');deps.terminate=async()=>new Promise<boolean>(()=>{});deps.timing!.cleanupMs=80;
 const events:any[]=[],start=Date.now();
 const result:any=await runGrok('grok_implement',selectedInput({cwd,task:'fixture'},'grok'),undefined,{onActivity:event=>events.push(event)},deps);
 assert.ok(Date.now()-start<4000);assertPartial(result);assert.equal(result.error,null);assert.equal(result.completion.confirmed,true);assert.equal(result.childCleanedUp,false);assert.ok(result.processCleanup.remainingPids.length>0);assert.ok(events.some(event=>event.type==='grok_turn_completed'));
 assert.equal(JSON.parse(await fs.readFile(path.join(cwd,'state','completion-fixture.usage.json'),'utf8')).usage.totalTokens,15);
});
test('Grok cancellation and deadline finish without ACP acknowledgement and preserve partial telemetry',async t=>{
 for(const kind of ['cancelled','deadline_exceeded'] as const){
  const {cwd,deps}=await fixture(t,'hang'),controller=new AbortController(),start=Date.now();
  const input=selectedInput({cwd,task:'fixture',...(kind==='deadline_exceeded'?{deadlineAt:Date.now()+1200}:{})},'grok');
  const result:any=await runGrok('grok_implement',input,controller.signal,{onActivity:event=>{if(kind==='cancelled'&&event.updateType==='agent_message_chunk')controller.abort();}},deps);
  assert.ok(Date.now()-start<5000);assertPartial(result);assert.equal(result.errorKind,kind);assert.equal(result.completion.confirmed,false);assert.equal(result.childCleanedUp,true);
 }
});
test('Grok abrupt ACP exit retains partial response and usage',async t=>{
 const {cwd,deps}=await fixture(t,'closed');
 const result:any=await runGrok('grok_review',selectedInput({cwd,task:'fixture'},'grok'),undefined,undefined,deps);
 assertPartial(result);assert.ok(result.error);assert.ok(['connection_error','process_exit'].includes(result.errorKind));assert.equal(result.completion.confirmed,false);
});
test('hanging Grok telemetry cannot hold or replace an already completed task',async t=>{
 const {cwd,deps}=await fixture(t,'completed');
 deps.getWeeklyUsage=async()=>new Promise(()=>{});
 deps.getSessionUsage=async()=>new Promise(()=>{});
 const start=Date.now(),result:any=await runGrok('grok_review',selectedInput({cwd,task:'fixture'},'grok'),undefined,undefined,deps);
 assert.ok(Date.now()-start<4000);assert.equal(result.error,null);assert.match(result.text,/partial answer/);assert.equal(result.sessionId,'completion-fixture');assert.equal(result.usage,'unavailable');assert.equal(result.weekly.status,'unavailable');assert.equal(result.weeklyBefore.status,'unavailable');assert.equal(result.observation.effort.value,'xhigh');
});
test('Grok implementation and client terminals reuse the configured user Gradle cache',async t=>{
 const {cwd,deps}=await fixture(t,'terminal');deps.timing!.cleanupMs=7000;
 const previous=process.env.GRADLE_USER_HOME;process.env.GRADLE_USER_HOME=path.join(cwd,'existing-gradle-cache');t.after(()=>{if(previous===undefined)delete process.env.GRADLE_USER_HOME;else process.env.GRADLE_USER_HOME=previous;});
 const result:any=await runGrok('grok_implement',selectedInput({cwd,task:'fixture'},'grok'),undefined,undefined,deps);
 assert.equal(result.error,null);assert.equal(result.gradleUserHome,path.join(cwd,'existing-gradle-cache'));assert.ok(result.text.includes(result.gradleUserHome));assert.ok(result.commandExecutions[0].output.includes(result.gradleUserHome));assert.equal(result.commandExecutions[0].exitCode,0);assert.equal(result.gradle.policy,'reuse_user_cache');assert.equal(result.gradle.createdByGateway,false);assert.equal(result.gradle.cleanup.removedBytes,0);await assert.rejects(fs.stat(path.join(cwd,'state','gradle')));
});
