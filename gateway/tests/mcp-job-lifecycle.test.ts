import './isolated-environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {terminateProcess} from '../src/process.js';

const sourceGateway=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const terminal=new Set(['completed','failed','cancelled','interrupted']);
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function bounded<T>(promise:Promise<T>,ms:number,message:string){let timer:NodeJS.Timeout;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error(message)),ms);})]);}finally{clearTimeout(timer!);}}
function decoded(reply:any){assert.equal(reply.error,undefined,JSON.stringify(reply.error));const value=JSON.parse(reply.result.content[0].text);assert.notEqual(reply.result.isError,true,JSON.stringify(value));return value;}

async function fixture(t:any){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'mcp-job-lifecycle-'));
 const gateway=path.join(root,'gateway'),home=path.join(root,'home'),cwd=path.join(root,'workspace'),marker=path.join(root,'exec-started.json');
 await Promise.all([fs.mkdir(path.join(gateway,'dist'),{recursive:true}),fs.mkdir(home),fs.mkdir(cwd)]);
 await fs.cp(path.join(sourceGateway,'dist','src'),path.join(gateway,'dist','src'),{recursive:true});
 await fs.writeFile(path.join(gateway,'package.json'),JSON.stringify({type:'module'}));
 await fs.symlink(path.join(sourceGateway,'node_modules'),path.join(gateway,'node_modules'),process.platform==='win32'?'junction':'dir');
 // Windows shell preflight validates the bundled runtime even though the fake
 // provider never launches shell commands. Share these read-only binaries only.
 if(process.platform==='win32')await fs.symlink(path.join(sourceGateway,'runtime'),path.join(gateway,'runtime'),'junction');
 const cli=path.join(root,process.platform==='win32'?'fixture-codex.cmd':'fixture-codex.sh');
 await fs.writeFile(path.join(root,'fake.mjs'),`
import fs from 'node:fs/promises';
import readline from 'node:readline';
const args=process.argv.slice(2),emit=value=>process.stdout.write(JSON.stringify(value)+'\\n');
if(args[0]==='--version'){console.log('codex-cli 0.162.1-fixture');}
else if(args[0]==='login'&&args[1]==='status'){console.log('Logged in using ChatGPT fixture');}
else if(args[0]==='app-server'){
 for await(const line of readline.createInterface({input:process.stdin})){
  const request=JSON.parse(line);if(request.id===undefined)continue;
  let result={};
  if(request.method==='account/read')result={account:{type:'chatgpt',email:'fixture@example.invalid'}};
  else if(request.method==='account/rateLimits/read')result={rateLimits:{primary:{usedPercent:1,windowDurationMins:300,resetsAt:2000000000}}};
  else if(request.method==='model/list')result={data:[{model:'gpt-6-astra',supportedReasoningEfforts:[{reasoningEffort:'high'}]}],nextCursor:null};
  else if(request.method!=='initialize')throw Error('Unexpected fixture RPC '+request.method);
  emit({jsonrpc:'2.0',id:request.id,result});
 }
}else if(args[0]==='exec'){
 for await(const chunk of process.stdin){};
 await fs.writeFile(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,startedAt:Date.now()}));
 emit({type:'thread.started',thread_id:'ba72a0ee-c4e5-4f41-a4f4-f1e138f382a3',model:'gpt-6-astra',reasoning_effort:'high'});
 emit({type:'item.completed',item:{type:'agent_message',text:'Fixture partial response'}});
 await new Promise(resolve=>setTimeout(resolve,2500));
 emit({type:'item.completed',item:{type:'agent_message',text:'MCP_JOB_COMPLETED'}});
 emit({type:'turn.completed',usage:{input_tokens:10,output_tokens:4}});
}else{throw Error('Unexpected CLI invocation '+JSON.stringify(args));}
`);
 await fs.writeFile(cli,process.platform==='win32'?`@echo off\r\n"${process.execPath}" "%~dp0fake.mjs" %*\r\n`:`#!/bin/sh\nexec "${process.execPath}" "${path.join(root,'fake.mjs')}" "$@"\n`);
 if(process.platform!=='win32')await fs.chmod(cli,0o755);
 const child=spawn(process.execPath,[path.join(gateway,'dist','src','index.js')],{
  cwd:gateway,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,
   HOME:home,USERPROFILE:home,CODEX_HOME:path.join(home,'.codex'),CLAUDE_CONFIG_DIR:path.join(home,'.claude'),
   APPDATA:path.join(home,'AppData','Roaming'),LOCALAPPDATA:path.join(home,'AppData','Local'),
   GROK_ENABLED:'false',CLAUDE_ENABLED:'false',CODEX_ENABLED:'true',CODEX_CLI:cli,CODEX_MODEL:'gpt-6-astra',CODEX_EFFORT:'high',
   ALLOW_SELF_PROVIDER:'false',AGENT_ACP_MCP_DELEGATED:'0',AGENT_MCP_STATE_DIR:path.join(root,'runtime-state'),AGENT_MCP_WORKTREE_DIR:path.join(root,'worktrees')}
 });
 let stderr='';child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-8000);});
 const exited=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
 const lines=createInterface({input:child.stdout}),pending=new Map<number,{resolve:(reply:any)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>();let nextId=0;
 lines.on('line',line=>{try{const reply=JSON.parse(line),waiter=pending.get(reply.id);if(waiter){clearTimeout(waiter.timer);pending.delete(reply.id);waiter.resolve(reply);}}catch{}});
 t.after(async()=>{
  if(child.exitCode===null&&child.signalCode===null){child.stdin.end();await bounded(exited,15000,'Fixture cleanup timeout').catch(()=>{});if(child.exitCode===null&&child.signalCode===null)await terminateProcess(child);}
  for(const waiter of pending.values()){clearTimeout(waiter.timer);waiter.reject(Error('Fixture closed'));}pending.clear();lines.close();
  // Remove only this fixture-owned link, never its real dependency directory.
  await fs.unlink(path.join(gateway,'node_modules'));if(process.platform==='win32')await fs.unlink(path.join(gateway,'runtime'));await fs.rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});
 });
 const notify=(method:string,params?:any)=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',method,...(params?{params}:{})})+'\n');
 const request=(method:string,params:any)=>{
  const id=++nextId;
  const promise=new Promise<any>((resolve,reject)=>{
   const timer=setTimeout(()=>{pending.delete(id);reject(Error('MCP fixture request timed out: '+method+'; '+stderr));},30000);
   pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  });
  return {id,promise};
 };
 const call=async(name:string,args:any={})=>decoded(await request('tools/call',{name,arguments:args}).promise);
 const init=await request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'Claude Desktop',version:'lifecycle-fixture'}}).promise;assert.equal(init.error,undefined);notify('notifications/initialized');
 const start=async()=>{
  const job=await call('agent_ask',{provider:'codex',cwd,task:'Read-only protocol fixture. Do not change files.',max_runtime_minutes:1});assert.match(job.job_id,/^[0-9a-f-]{36}$/);
  for(let i=0;i<200;i++){if(await fs.stat(marker).catch(()=>undefined))return job;await delay(50);}
  assert.fail('Mock Codex exec did not start: '+JSON.stringify(await call('agent_job_status',{job_id:job.job_id}))+'; '+stderr);
 };
 return {child,exited,request,notify,call,start,gateway,stderr:()=>stderr};
}

function assertSuccessful(job:any){
 assert.equal(job.status,'completed',JSON.stringify(job));assert.ok(job.finishedAt);assert.equal(job.result.outcome,'success');
 const result=job.result.results.find((item:any)=>item.provider==='codex');assert.ok(result);assert.equal(result.error,null);assert.match(result.text,/MCP_JOB_COMPLETED/);assert.equal(result.usage.input_tokens,10);assert.equal(result.model,'gpt-6-astra');assert.equal(result.effort,'high');
}

test('actual MCP cancellation of agent_job_wait never cancels accepted provider work; legacy wait is capped',async t=>{
 const b=await fixture(t),job=await b.start();
 const waiting=b.request('tools/call',{name:'agent_job_wait',arguments:{job_id:job.job_id,timeout_seconds:60}});
 // Hosts may discard the cancelled request response entirely. Its promise is
 // observed but cannot serve as evidence of the independent job's outcome.
 void waiting.promise.catch(()=>{});
 await delay(100);b.notify('notifications/cancelled',{requestId:waiting.id,reason:'Fixture host wait deadline'});
 await delay(100);
 const active=await b.call('agent_job_status',{job_id:job.job_id});assert.equal(active.status,'running',JSON.stringify(active));assert.equal(active.error,undefined);
 const done=await b.call('agent_job_wait',{job_id:job.job_id,timeout_seconds:60});assertSuccessful(done);assert.equal(done.wait.effective_timeout_seconds,25);assert.equal(done.wait.requested_timeout_seconds,60);assert.equal(done.wait.completed,true);
});

test('actual MCP stdin EOF drains accepted work and persists success before gateway exits',async t=>{
 const b=await fixture(t),job=await b.start();
 assert.equal((await b.call('agent_job_status',{job_id:job.job_id})).status,'running');
 b.child.stdin.end();
 const exit=await bounded(b.exited,20000,'Gateway did not exit after draining');assert.equal(exit.code,0,b.stderr());
 const stored=JSON.parse(await fs.readFile(path.join(b.gateway,'state','jobs',job.job_id+'.json'),'utf8'));assertSuccessful(stored);assert.ok(terminal.has(stored.status));
});
