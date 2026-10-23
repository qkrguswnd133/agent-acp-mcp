import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runCodexAppCommand,type CodexAppCommandOptions} from '../src/codex-app-execution.js';
import {runCommand,safeChildEnv} from '../src/process.js';

const thread='00000000-0000-7000-8000-000000000091',turn='turn-one';
async function fixture(body:string,options:{configuration?:unknown;settings?:Record<string,unknown>;onRequest?:string}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'codex-app-run-')),script=path.join(root,'server.cjs'),requests=path.join(root,'requests.jsonl');
 const code=`const fs=require('node:fs'),readline=require('node:readline');const threadId=${JSON.stringify(thread)},turnId=${JSON.stringify(turn)};
 const send=value=>console.log(JSON.stringify(value));const note=(method,params)=>send({method,params:{threadId,turnId,...params}});
 const reply=(r,result)=>send({id:r.id,result});
 readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);fs.appendFileSync(${JSON.stringify(requests)},line+'\\n');${options.onRequest??''}
 if(r.method==='initialize')reply(r,{});
 if(r.method==='config/read')reply(r,${JSON.stringify(options.configuration??{config:{mcp_servers:{}}})});
 if(r.method==='thread/start')reply(r,{thread:{id:threadId},cwd:process.cwd(),sandbox:{type:'readOnly'},model:'gpt-6-astra',reasoningEffort:'high',serviceTier:'priority',...${JSON.stringify(options.settings??{})}});
 if(r.method==='turn/start'){${body}}
 if(r.method==='turn/interrupt'){reply(r,{});note('turn/completed',{turn:{id:turnId,status:'interrupted'}});}
 });setInterval(()=>{},1000);`;
 await fs.writeFile(script,code);return {root,script,requests,async dispose(){await fs.rm(root,{recursive:true,force:true});}};
}
const ack=`reply(r,{turn:{id:turnId,status:'inProgress'}});`;
const complete=`note('turn/completed',{turn:{id:turnId,status:'completed'}});`;
async function run(f:Awaited<ReturnType<typeof fixture>>,extra:Partial<CodexAppCommandOptions>={}){
 return runCodexAppCommand(process.execPath,[f.script],{cwd:f.root,prompt:'Read only smoke test',model:'gpt-6-astra',effort:'high',speed:'fast',sandbox:'read-only',env:safeChildEnv(),timeoutMs:20000,completionGraceMs:10,...extra});
}
function events(result:{stdout:string}){return result.stdout.split('\n').filter(Boolean).map(line=>JSON.parse(line));}

test('app-server uses one matching thread and turn, preserves result, usage, commands and CLI-applied speed',async()=>{
 const f=await fixture(`${ack}
 note('item/started',{item:{id:'cmd',type:'commandExecution',command:'git status',cwd:process.cwd()}});
 note('item/commandExecution/outputDelta',{itemId:'cmd',delta:'한글'});
 note('item/completed',{item:{id:'cmd',type:'commandExecution',command:'git status',cwd:process.cwd(),exitCode:0,status:'completed'}});
 note('item/completed',{item:{id:'patch',type:'fileChange',changes:[{path:'file.ts'}],status:'completed'}});
 note('item/agentMessage/delta',{itemId:'msg',delta:'Hello '});note('item/agentMessage/delta',{itemId:'msg',delta:'world'});
 note('item/completed',{item:{id:'msg',type:'agentMessage',text:'Hello world'}});
 note('thread/tokenUsage/updated',{tokenUsage:{total:{inputTokens:40,cachedInputTokens:12,outputTokens:6,totalTokens:46}}});${complete}`);
 try{
  const result=await run(f);assert.equal(result.completion.confirmed,true);assert.equal(result.completion.source,'app_server');assert.equal(result.stopReason,'completed');
  assert.equal(result.appliedSettings?.speed,'fast');assert.equal(result.appliedSettings?.model,'gpt-6-astra');assert.equal(result.appliedSettings?.effort,'high');assert.equal(result.appliedSettings?.threadId,thread);assert.equal(result.appliedSettings?.turnId,turn);
  const parsed=events(result);assert.equal(parsed.filter(row=>row.item?.text==='Hello world').length,1);assert.equal(parsed.find(row=>row.type==='turn.completed').usage.total_tokens,46);
  assert.equal([...parsed].reverse().find(row=>row.item?.id==='cmd').item.aggregated_output,'한글');assert.equal((result.implementationProgress as any).commandsCompleted,1);assert.equal((result.implementationProgress as any).successfulWrites,1);
  assert.equal(parsed.some(row=>row.model||row.reasoning_effort||row.service_tier),false,'Configuration is not backend observation');
  const requests=(await fs.readFile(f.requests,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(requests.filter(row=>row.method==='thread/start').length,1);assert.equal(requests.filter(row=>row.method==='turn/start').length,1);
  assert.equal(requests.find(row=>row.method==='thread/start').params.serviceTier,'priority');assert.equal(requests.find(row=>row.method==='turn/start').params.serviceTier,undefined);
 }finally{await f.dispose();}
});
test('explicit standard plus present null tier is applied standard; missing tier remains unavailable',async()=>{
 for(const omitted of [false,true]){
  const f=await fixture(`${ack}${complete}`,{settings:{serviceTier:null},onRequest:omitted?`if(r.method==='thread/start'){reply(r,{thread:{id:threadId},cwd:process.cwd(),model:'gpt-6-astra',reasoningEffort:'high'});return;}`:undefined});
  try{const result=await run(f,{speed:'standard'});assert.equal(result.appliedSettings?.speed,omitted?undefined:'standard');assert.equal(result.appliedSettings?.serviceTierPresent,!omitted);}finally{await f.dispose();}
 }
});
test('notifications before turn acknowledgement are queued; other threads and turns never contaminate results',async()=>{
 const f=await fixture(`note('item/completed',{item:{id:'early',type:'agentMessage',text:'Same turn'}});
 note('item/completed',{turnId:'other',item:{id:'bad',type:'agentMessage',text:'Wrong turn'}});
 note('item/completed',{threadId:'other',item:{id:'bad2',type:'agentMessage',text:'Wrong thread'}});
 ${ack}${complete}`);
 try{const result=await run(f);assert.match(result.stdout,/Same turn/);assert.doesNotMatch(result.stdout,/Wrong turn|Wrong thread/);assert.doesNotMatch(result.rawProtocolStdout,/Wrong turn|Wrong thread/);assert.equal(result.completion.confirmed,true);}finally{await f.dispose();}
});
test('inherited MCP servers are disabled explicitly and config secrets never leave runner',async()=>{
 const f=await fixture(`${ack}${complete}`,{configuration:{config:{mcp_servers:{company:{command:'sensitive',env:{TOKEN:'never-return-this'}},nested:{enabled:true}},anotherSecret:'never-return-that'}}});
 try{
  const result=await run(f);assert.doesNotMatch(JSON.stringify(result),/never-return-this|never-return-that|sensitive/);
  const requests=(await fs.readFile(f.requests,'utf8')).trim().split('\n').map(line=>JSON.parse(line));const p=requests.find(row=>row.method==='thread/start').params;
  assert.deepEqual(p.config.mcp_servers,{company:{enabled:false},nested:{enabled:false}});assert.equal(p.config['features.plugins'],false);assert.equal(p.config['features.apps'],false);assert.equal(p.approvalPolicy,'never');
 }finally{await f.dispose();}
});
test('unavailable configuration fails before model work, without fallback or replay',async()=>{
 const f=await fixture(`${ack}${complete}`,{configuration:{other:'not configuration'}});
 try{const result=await run(f);assert.equal(result.completion.confirmed,false);assert.equal(result.protocolError?.code,'app_server_config_unavailable');const requests=await fs.readFile(f.requests,'utf8');assert.doesNotMatch(requests,/thread\/start|turn\/start/);}finally{await f.dispose();}
});
test('same-thread settings updates preserve history and are associated with the executed turn',async()=>{
 const f=await fixture(`${ack}note('thread/settings/updated',{threadSettings:{model:'gpt-6-astra',effort:'xhigh',serviceTier:'default'}});${complete}note('thread/settings/updated',{threadSettings:{model:'other',effort:'low',serviceTier:'ultrafast'}});`);
 try{const result=await run(f);assert.equal(result.settingsHistory.length,2);assert.equal(result.appliedSettings?.source,'app_server.thread/settings/updated');assert.equal(result.appliedSettings?.speed,'standard');assert.equal(result.appliedSettings?.effort,'xhigh');assert.equal(result.appliedSettings?.turnId,turn);}finally{await f.dispose();}
});
test('individual permission refusal does not cancel a completed turn',async()=>{
 const f=await fixture(`${ack}send({id:'approve-command',method:'item/commandExecution/requestApproval',params:{threadId,turnId}});send({id:'approve-file',method:'item/fileChange/requestApproval',params:{threadId,turnId}});send({id:'approve-permissions',method:'item/permissions/requestApproval',params:{threadId,turnId}});send({id:'unknown-request',method:'item/arbitrary/execute',params:{threadId,turnId}});
 setTimeout(()=>{${complete}},100);`);
 try{const result=await run(f);assert.equal(result.completion.confirmed,true);const requests=(await fs.readFile(f.requests,'utf8')).trim().split('\n').map(line=>JSON.parse(line));for(const id of ['approve-command','approve-file'])assert.equal(requests.find(row=>row.id===id).result.decision,'decline');assert.deepEqual(requests.find(row=>row.id==='approve-permissions').result,{permissions:{},scope:'turn'});assert.equal(requests.find(row=>row.id==='unknown-request').error.code,-32601);}finally{await f.dispose();}
});
test('structured terminal errors preserve partial response, token usage and exact evidence',async()=>{
 const f=await fixture(`${ack}note('item/agentMessage/delta',{itemId:'partial',delta:'Work remains'});note('thread/tokenUsage/updated',{tokenUsage:{total:{inputTokens:12,outputTokens:2}}});
 note('turn/completed',{turn:{id:turnId,status:'failed',error:{message:'Usage exhausted',codexErrorInfo:'UsageLimitExceeded'}}});`);
 try{const result=await run(f);assert.equal(result.completion.confirmed,false);assert.equal(result.protocolError?.code,'UsageLimitExceeded');assert.match(result.stdout,/Work remains/);assert.match(result.stdout,/input_tokens/);}finally{await f.dispose();}
});
test('retryable provider errors do not become failed completed turns',async()=>{
 const f=await fixture(`${ack}note('error',{willRetry:true,error:{message:'Reconnect retry'}});${complete}`);
 try{const result=await run(f);assert.equal(result.completion.confirmed,true);assert.equal(result.protocolError,undefined);}finally{await f.dispose();}
});
test('deadline and cancellation interrupt only this turn and retain partial deltas',async()=>{
 for(const cancel of [false,true]){
  const f=await fixture(`${ack}note('item/agentMessage/delta',{itemId:'partial',delta:'Partial kept'});`);const controller=new AbortController();const started=Date.now();
  try{
   const result=await run(f,{timeoutMs:cancel?10000:1000,signal:controller.signal,onActivity:event=>{if(cancel&&event.type==='codex_text_delta')controller.abort();}});
   assert.equal(result.stopReason,cancel?'cancelled':'deadline_exceeded');assert.equal(result.completion.confirmed,false);assert.match(result.stdout,/Partial kept/);assert.ok(Date.now()-started<15000);
   const requests=(await fs.readFile(f.requests,'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.deepEqual(requests.find(row=>row.method==='turn/interrupt').params,{threadId:thread,turnId:turn});
  }finally{await f.dispose();}
 }
});
test('clean process exit without a matching terminal notification is failure, not success',async()=>{
 const f=await fixture(`${ack}note('item/completed',{item:{id:'msg',type:'agentMessage',text:'Not terminal'}});process.exit(0);`);
 try{const result=await run(f);assert.equal(result.code,0);assert.equal(result.completion.confirmed,false);assert.equal(result.protocolError?.code,'app_server_incomplete');assert.match(result.stdout,/Not terminal/);}finally{await f.dispose();}
});
test('protocol timeout is bounded and does not start or replay a turn',async()=>{
 const f=await fixture(`${ack}${complete}`,{onRequest:`if(r.method==='config/read')return;`});const started=Date.now();
 try{const result=await run(f,{requestTimeoutMs:100});assert.equal(result.protocolError?.code,'app_server_protocol_timeout');assert.ok(Date.now()-started<15000);assert.doesNotMatch(await fs.readFile(f.requests,'utf8'),/turn\/start/);}finally{await f.dispose();}
});
test('read-only request refuses a broader acknowledged sandbox before starting work',async()=>{
 const f=await fixture(`${ack}${complete}`,{settings:{sandbox:{type:'workspaceWrite'}}});
 try{const result=await run(f);assert.equal(result.protocolError?.code,'app_server_sandbox_mismatch');assert.doesNotMatch(await fs.readFile(f.requests,'utf8'),/turn\/start/);}finally{await f.dispose();}
});
test('acknowledged working directory mismatch is rejected before work',async()=>{
 const f=await fixture(`${ack}${complete}`,{settings:{cwd:os.tmpdir()}});
 try{const result=await run(f);assert.equal(result.protocolError?.code,'app_server_cwd_mismatch');assert.doesNotMatch(await fs.readFile(f.requests,'utf8'),/turn\/start/);}finally{await f.dispose();}
});
test('an unresponsive interactive stop hook cannot suppress cancellation',async()=>{
 const controller=new AbortController(),started=Date.now();
 const result=await runCommand(process.execPath,['-e','console.log("ready");setInterval(()=>{},1000)'],{env:safeChildEnv(),signal:controller.signal,onStdoutLine(){controller.abort();},onStopping:()=>new Promise(()=>{})});
 assert.equal(result.stopReason,'cancelled');assert.ok(Date.now()-started<10000);
});
test('a thread acknowledgement arriving after the deadline cannot start new model work during teardown',async()=>{
 let release=()=>{},acknowledged!:()=>void;const replySeen=new Promise<void>(resolve=>{acknowledged=resolve;});
 const f=await fixture(`${ack}${complete}`,{onRequest:`if(r.method==='thread/start'){globalThis.delayedThread=r;return;}if(r.method==='fixture/release'){reply(globalThis.delayedThread,{thread:{id:threadId},cwd:process.cwd(),model:'gpt-6-astra',serviceTier:null});return;}`});
 try{
  const result=await run(f,{timeoutMs:1000,onSpawn:child=>{release=()=>{child.stdin?.write(JSON.stringify({method:'fixture/release'})+'\n');};},onStdoutLine:line=>{if(line.includes('"thread"'))acknowledged();},onStopping:async()=>{release();await replySeen;}});
  assert.equal(result.stopReason,'deadline_exceeded');assert.equal(result.completion.confirmed,false);
  assert.match(result.rawProtocolStdout,/"thread"/,'The delayed acknowledgement must arrive during the bounded stop hook');
  assert.doesNotMatch(await fs.readFile(f.requests,'utf8'),/turn\/start/);
 }finally{await f.dispose();}
});
