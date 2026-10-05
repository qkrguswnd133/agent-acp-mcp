import {selectedInput} from './selection-fixture.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {QuotaCache} from '../src/quota-cache.js';

async function fakeCli(stdout:string,stderr='',code=0,prelude=''){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'agent-acp-provider-results-'));
 const script=path.join(directory,'cli.mjs');
 await fs.writeFile(script,`import fs from 'node:fs';import path from 'node:path';if(process.argv[2]==='app-server'){const counter=path.join(path.dirname(process.argv[1]),'app-server-count');let count=0;try{count=Number(fs.readFileSync(counter,'utf8'))||0}catch{}fs.writeFileSync(counter,String(count+1));let buffer='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{buffer+=chunk;let index;while((index=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);try{const request=JSON.parse(line);if(request.method==='initialize')process.stdout.write(JSON.stringify({id:request.id,result:{}})+'\\n');if(request.method==='model/list')process.stdout.write(JSON.stringify({id:request.id,result:{data:[],nextCursor:null}})+'\\n');if(request.method==='account/read')process.stdout.write(JSON.stringify({id:request.id,result:{account:null}})+'\\n');if(request.method==='account/rateLimits/read')process.stdout.write(JSON.stringify({id:request.id,result:{rateLimits:{primary:{usedPercent:10,resetsAt:1999999999}}}})+'\\n')}catch{}}});}else{${prelude}process.stdout.write(${JSON.stringify(stdout)});process.stderr.write(${JSON.stringify(stderr)});process.exit(${code});}`);
 if(process.platform==='win32'){
  const command=path.join(directory,'cli.cmd');
  await fs.writeFile(command,`@echo off\r\n"${process.execPath}" "%~dp0cli.mjs" %*\r\n`);
  return {command,directory};
 }
 const command=path.join(directory,'cli.sh');
 await fs.writeFile(command,`#!/bin/sh\n"${process.execPath}" "$(dirname "$0")/cli.mjs" "$@"\n`);
 await fs.chmod(command,0o755);
 return {command,directory};
}

async function withEnv(values:Record<string,string|undefined>,action:()=>Promise<void>){
 const previous=new Map(Object.keys(values).map(key=>[key,process.env[key]]));
 for(const [key,value] of Object.entries(values)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
 try{await action();}finally{for(const [key,value] of previous){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
}

async function loadProvider(name:'claude'|'codex'){
 const file=new URL(`../src/providers/${name}.js`,import.meta.url).href;
 return import(`${file}?fixture=${Date.now()}-${Math.random()}`);
}

test('Codex failure retains matching transcript model/effort, partial output and usage',async()=>{
 const state=await fs.mkdtemp(path.join(os.tmpdir(),'agent-codex-evidence-'));
 const id='00000000-0000-7000-8000-000000000002';
 const setup=`const now=new Date();const folder=path.join(${JSON.stringify(state)},'sessions',...now.toISOString().slice(0,10).split('-'));fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'rollout-test-${id}.jsonl'),[{type:'session_meta',timestamp:now.toISOString(),payload:{id:'${id}',cwd:process.cwd()}},{type:'turn_context',timestamp:now.toISOString(),payload:{cwd:process.cwd(),model:'observed-model',effort:'high'}}].map(v=>JSON.stringify(v)).join('\\n'));`;
 const events=[{type:'thread.started',thread_id:id},{type:'item.completed',item:{type:'agent_message',text:'partial'}},{type:'turn.failed',error:{message:'fixture failure'},usage:{input_tokens:10}}].map(e=>JSON.stringify(e)).join('\n');
 const cli=await fakeCli(events,'',1,setup);
 try{await withEnv({CODEX_CLI:cli.command,CODEX_HOME:state,AGENT_MCP_STATE_DIR:state},async()=>{
  const {CodexProvider}=await loadProvider('codex');
  const result=await new CodexProvider().run('agent_implement',selectedInput({cwd:process.cwd(),task:'fixture',model:'requested-model'}, 'codex'));
  assert.equal(result.error,'fixture failure');assert.equal(result.text,'partial');
  assert.equal(result.model,'observed-model');assert.equal(result.modelSource,'session_jsonl');
  assert.equal(result.effort,'high');assert.equal(result.requestedModel,'requested-model');
  assert.deepEqual(result.usage,{input_tokens:10});
 });}finally{await fs.rm(cli.directory,{recursive:true,force:true});await fs.rm(state,{recursive:true,force:true});}
});

test('Claude treats a JSON is_error result as a failure and reports the actual model used',async()=>{
 const cli=await fakeCli(JSON.stringify({type:'result',is_error:true,result:'rate_limit_exceeded',modelUsage:{'claude-sonnet-4-5-20250929':{inputTokens:1}}}));
 const state=await fs.mkdtemp(path.join(os.tmpdir(),'agent-acp-claude-state-'));
 try{await withEnv({CLAUDE_CLI:cli.command,CLAUDE_MODEL:'auto',AGENT_MCP_STATE_DIR:state},async()=>{
  const {ClaudeProvider}=await loadProvider('claude');
  const result=await new ClaudeProvider().run('agent_ask',selectedInput({task:'fixture',cwd:process.cwd()}, 'claude'));
  assert.equal(result.error,'rate_limit_exceeded');assert.equal(result.errorKind,'rate_limited');assert.equal(result.model,'claude-sonnet-4-5-20250929');assert.equal(result.effort,'unavailable');
 });}finally{await fs.rm(cli.directory,{recursive:true,force:true});await fs.rm(state,{recursive:true,force:true});}
});

test('Claude successful JSON reports a model from modelUsage and never reports auto as runtime metadata',async()=>{
 const cli=await fakeCli(JSON.stringify({type:'result',is_error:false,result:'done',modelUsage:{'claude-opus-4-6':{inputTokens:1}}}));
 const state=await fs.mkdtemp(path.join(os.tmpdir(),'agent-acp-claude-state-'));
 try{await withEnv({CLAUDE_CLI:cli.command,CLAUDE_MODEL:'auto',CLAUDE_EFFORT:'auto',AGENT_MCP_STATE_DIR:state},async()=>{
  const {ClaudeProvider}=await loadProvider('claude');
  const result=await new ClaudeProvider().run('agent_ask',selectedInput({task:'fixture',cwd:process.cwd()}, 'claude'));
  assert.equal(result.error,null);assert.equal(result.text,'done');assert.equal(result.model,'claude-opus-4-6');assert.equal(result.effort,'unavailable');
 });}finally{await fs.rm(cli.directory,{recursive:true,force:true});await fs.rm(state,{recursive:true,force:true});}
});

test('Claude keeps a configured model as request metadata until the CLI or official transcript observes it',async()=>{
 const cli=await fakeCli(JSON.stringify({type:'result',is_error:false,result:'done'}));
 const state=await fs.mkdtemp(path.join(os.tmpdir(),'agent-acp-claude-state-'));
 try{await withEnv({CLAUDE_CLI:cli.command,CLAUDE_MODEL:'claude-configured',CLAUDE_EFFORT:'high',AGENT_MCP_STATE_DIR:state},async()=>{
  const {ClaudeProvider}=await loadProvider('claude');const result=await new ClaudeProvider().run('agent_ask',selectedInput({task:'fixture',cwd:process.cwd()}, 'claude'));
  assert.equal(result.model,'unavailable');assert.equal(result.effort,'unavailable');assert.equal(result.requestedModel,'claude-configured');assert.equal(result.requestedEffort,'high');
 });}finally{await fs.rm(cli.directory,{recursive:true,force:true});await fs.rm(state,{recursive:true,force:true});}
});

test('Claude does not infer a quota failure from ordinary stdout when stderr is the actual error',async()=>{
 const cli=await fakeCli('The agent says: rate limit exceeded is documented here','request failed',1);
 const state=await fs.mkdtemp(path.join(os.tmpdir(),'agent-acp-claude-state-'));
 try{await withEnv({CLAUDE_CLI:cli.command,CLAUDE_MODEL:'auto',AGENT_MCP_STATE_DIR:state},async()=>{
  const {ClaudeProvider}=await loadProvider('claude');
  const result=await new ClaudeProvider().run('agent_ask',selectedInput({task:'fixture',cwd:process.cwd()}, 'claude'));
  assert.equal(result.error,'request failed');assert.equal(result.errorKind,'task_error');
 });}finally{await fs.rm(cli.directory,{recursive:true,force:true});await fs.rm(state,{recursive:true,force:true});}
});

test('Codex does not report successful exit-zero streams with turn.failed as success',async()=>{
  const events=[
  JSON.stringify({type:'thread.started',thread_id:'thread-fixture'}),
  JSON.stringify({type:'turn.failed',error:{message:'rate_limit_exceeded'},usage:{input_tokens:3}})
 ].join('\n');
 const cli=await fakeCli(events);
 const state=await fs.mkdtemp(path.join(os.tmpdir(),'agent-acp-codex-state-'));
 try{await withEnv({CODEX_CLI:cli.command,CODEX_MODEL:'auto',AGENT_MCP_STATE_DIR:state},async()=>{
 const {CodexProvider}=await loadProvider('codex');
  const result=await new CodexProvider().run('agent_ask',selectedInput({task:'fixture',cwd:process.cwd()}, 'codex'));
  assert.equal(result.error,'rate_limit_exceeded');assert.equal(result.errorKind,'rate_limited');assert.equal(result.sessionId,'thread-fixture');assert.deepEqual(result.usage,{input_tokens:3});
 });}finally{await fs.rm(cli.directory,{recursive:true,force:true});await fs.rm(state,{recursive:true,force:true});}
});

test('Codex structured quota and context failures remain distinct and raw JSONL never becomes text fallback',async()=>{
 const fixtures:[string,string][]=[['usage quota exhausted','quota_exhausted'],['context_length_exceeded','context_limit']];
 const state=await fs.mkdtemp(path.join(os.tmpdir(),'agent-acp-codex-state-'));
 try{for(const [message,expected] of fixtures){
  const cli=await fakeCli(JSON.stringify({type:'turn.failed',error:{message}}),'',1);
  try{await withEnv({CODEX_CLI:cli.command,CODEX_MODEL:'auto',AGENT_MCP_STATE_DIR:state},async()=>{
   const {CodexProvider}=await loadProvider('codex');const result=await new CodexProvider().run('agent_ask',selectedInput({task:'fixture',cwd:process.cwd()}, 'codex'));assert.equal(result.errorKind,expected);assert.equal(result.text,'');
  });}finally{await fs.rm(cli.directory,{recursive:true,force:true});}
 }}finally{await fs.rm(state,{recursive:true,force:true});}
});

test('Claude preserves the generated official session ID, partial assistant text, and known usage after a malformed failed result',async()=>{
 const prelude="const id=process.argv[process.argv.indexOf('--session-id')+1];const root=process.env.CLAUDE_CONFIG_DIR;const file=path.join(root,'projects','fixture',id+'.jsonl');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify({type:'assistant',sessionId:id,cwd:process.cwd(),effort:'high',message:{model:'claude-opus-transcript',content:[{type:'text',text:'partial answer'}],usage:{input_tokens:7}}})+'\\n');";
 const cli=await fakeCli('{malformed json','request failed',1,prelude);
 const state=await fs.mkdtemp(path.join(os.tmpdir(),'agent-acp-claude-state-'));
 const claudeRoot=await fs.mkdtemp(path.join(os.tmpdir(),'agent-acp-claude-transcript-'));
 try{await withEnv({CLAUDE_CLI:cli.command,CLAUDE_MODEL:'auto',CLAUDE_CONFIG_DIR:claudeRoot,AGENT_MCP_STATE_DIR:state},async()=>{
  const {ClaudeProvider}=await loadProvider('claude');
  const result=await new ClaudeProvider().run('agent_ask',selectedInput({task:'fixture',cwd:process.cwd()}, 'claude'));
  assert.equal(result.error,'request failed');assert.equal(result.errorKind,'task_error');assert.equal(result.text,'partial answer');assert.equal(result.model,'claude-opus-transcript');assert.equal(result.effort,'high');assert.deepEqual(result.usage,{input_tokens:7});assert.match(String(result.sessionId),/^[0-9a-f-]{36}$/i);
 });}finally{await fs.rm(cli.directory,{recursive:true,force:true});await fs.rm(state,{recursive:true,force:true});await fs.rm(claudeRoot,{recursive:true,force:true});}
});

test('Claude distinguishes subscription quota, rate, and context errors from actual structured failures',async()=>{
 const state=await fs.mkdtemp(path.join(os.tmpdir(),'agent-acp-claude-state-'));
 const fixtures:[string,string][]=[['usage quota exhausted','quota_exhausted'],['rate_limit_exceeded','rate_limited'],['context_length_exceeded','context_limit']];
 try{for(const [message,expected] of fixtures){
  const cli=await fakeCli(JSON.stringify({type:'result',is_error:true,result:message}));
  try{await withEnv({CLAUDE_CLI:cli.command,CLAUDE_MODEL:'auto',AGENT_MCP_STATE_DIR:state},async()=>{
   const {ClaudeProvider}=await loadProvider('claude');const result=await new ClaudeProvider().run('agent_ask',selectedInput({task:'fixture',cwd:process.cwd()}, 'claude'));assert.equal(result.errorKind,expected);
  });}finally{await fs.rm(cli.directory,{recursive:true,force:true});}
 }}finally{await fs.rm(state,{recursive:true,force:true});}
});

test('Claude carries top-level protocol reset and Retry-After fields into failure and runtime cache metadata',async()=>{
 const reset='2031-02-03T04:05:06.000Z';
 const cli=await fakeCli(JSON.stringify({type:'result',is_error:true,result:'rate_limit_exceeded',status:429,headers:{'Retry-After':'60','X-RateLimit-Reset':reset}}));
 const state=await fs.mkdtemp(path.join(os.tmpdir(),'agent-acp-claude-state-'));
 try{await withEnv({CLAUDE_CLI:cli.command,CLAUDE_MODEL:'auto',AGENT_MCP_STATE_DIR:state},async()=>{
  const {ClaudeProvider}=await loadProvider('claude');const provider=new ClaudeProvider();const result=await provider.run('agent_ask',selectedInput({task:'fixture',cwd:process.cwd()}));
  assert.equal(result.errorKind,'rate_limited');assert.equal(result.resetsAt,reset);assert.match(String(result.retryAfter),/T/);
  const status=await provider.status();assert.equal(status.quota.resetsAt,reset);assert.equal(status.quota.source,'runtime_limit_error');
 });}finally{await fs.rm(cli.directory,{recursive:true,force:true});await fs.rm(state,{recursive:true,force:true});}
});

test('Claude classifies structured error arrays without reading normal result output',async()=>{
 const cli=await fakeCli(JSON.stringify({type:'result',is_error:true,result:'failed',errors:[{code:'context_length_exceeded',message:'input is too large'}]}));
 const state=await fs.mkdtemp(path.join(os.tmpdir(),'agent-acp-claude-state-'));
 try{await withEnv({CLAUDE_CLI:cli.command,CLAUDE_MODEL:'auto',AGENT_MCP_STATE_DIR:state},async()=>{
  const {ClaudeProvider}=await loadProvider('claude');const result=await new ClaudeProvider().run('agent_ask',selectedInput({task:'fixture',cwd:process.cwd()}, 'claude'));assert.equal(result.errorKind,'context_limit');
 });}finally{await fs.rm(cli.directory,{recursive:true,force:true});await fs.rm(state,{recursive:true,force:true});}
});

test('Claude transcript read failures cannot replace the primary CLI error',async()=>{
 const cli=await fakeCli('not json','primary stderr failure',1);
 const state=await fs.mkdtemp(path.join(os.tmpdir(),'agent-acp-claude-state-'));
 const impossibleRoot=path.join(state,'not-a-directory');await fs.writeFile(impossibleRoot,'fixture');
 try{await withEnv({CLAUDE_CLI:cli.command,CLAUDE_MODEL:'auto',CLAUDE_CONFIG_DIR:impossibleRoot,AGENT_MCP_STATE_DIR:state},async()=>{
  const {ClaudeProvider}=await loadProvider('claude');const result=await new ClaudeProvider().run('agent_ask',selectedInput({task:'fixture',cwd:process.cwd()}, 'claude'));
  assert.equal(result.error,'primary stderr failure');assert.equal(result.errorKind,'task_error');assert.equal(result.text,'');
 });}finally{await fs.rm(cli.directory,{recursive:true,force:true});await fs.rm(state,{recursive:true,force:true});}
});

test('Codex does not report successful exit-zero streams with error events as success',async()=>{
 const cli=await fakeCli([
  JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'rate limit exceeded is documented here'}}),
  JSON.stringify({type:'error',message:'request failed'})
 ].join('\n'));
 const state=await fs.mkdtemp(path.join(os.tmpdir(),'agent-acp-codex-state-'));
 try{await withEnv({CODEX_CLI:cli.command,CODEX_MODEL:'auto',AGENT_MCP_STATE_DIR:state},async()=>{
  const {CodexProvider}=await loadProvider('codex');
  const result=await new CodexProvider().run('agent_ask',selectedInput({task:'fixture',cwd:process.cwd()}, 'codex'));
  assert.equal(result.error,'request failed');assert.equal(result.errorKind,'task_error');
 });}finally{await fs.rm(cli.directory,{recursive:true,force:true});await fs.rm(state,{recursive:true,force:true});}
});

test('Codex turn.completed is successful, and a preceding non-terminal error does not override it',async()=>{
 const events=[
  JSON.stringify({type:'thread.started',thread_id:'thread-fixture'}),
  JSON.stringify({type:'error',message:'transient transport notice'}),
  JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'quota limit is described here'}}),
  JSON.stringify({type:'turn.completed',usage:{input_tokens:1}})
 ].join('\n');
 const cli=await fakeCli(events);
 const state=await fs.mkdtemp(path.join(os.tmpdir(),'agent-acp-codex-state-'));
 try{await withEnv({CODEX_CLI:cli.command,CODEX_MODEL:'auto',CODEX_EFFORT:'auto',AGENT_MCP_STATE_DIR:state},async()=>{
  const {CodexProvider}=await loadProvider('codex');
  const result=await new CodexProvider().run('agent_ask',selectedInput({task:'fixture',cwd:process.cwd()}, 'codex'));
  assert.equal(result.error,null);assert.equal(result.text,'quota limit is described here');assert.equal(result.sessionId,'thread-fixture');assert.equal(result.model,'unavailable');assert.equal(result.effort,'unavailable');
 });}finally{await fs.rm(cli.directory,{recursive:true,force:true});await fs.rm(state,{recursive:true,force:true});}
});

test('Codex does not claim success after an unrecovered shell launch failure',async()=>{
 const events=[{type:'thread.started',thread_id:'shell-fixture'},{type:'item.completed',item:{type:'command_execution',id:'command-1',command:'git show HEAD',exit_code:-1,aggregated_output:'Failed to create unified exec process: CreateProcessAsUserW failed: 5 (Access denied)'}},{type:'item.completed',item:{type:'agent_message',text:'Unable to inspect the files.'}},{type:'turn.completed',usage:{input_tokens:7}}].map(e=>JSON.stringify(e)).join('\n');
 const cli=await fakeCli(events);const state=await fs.mkdtemp(path.join(os.tmpdir(),'codex-shell-result-'));
 try{await withEnv({CODEX_CLI:cli.command,CODEX_MODEL:'auto',CODEX_EFFORT:'auto',AGENT_MCP_STATE_DIR:state},async()=>{
  const {CodexProvider}=await loadProvider('codex');const result=await new CodexProvider().run('agent_review',selectedInput({task:'fixture',cwd:process.cwd()},'codex'));
  assert.equal(result.errorKind,'shell_launch_failed');assert.equal(result.text,'Unable to inspect the files.');assert.equal(result.sessionId,'shell-fixture');assert.deepEqual(result.usage,{input_tokens:7});assert.equal(result.commandExecutions?.length,1);assert.equal(result.selection?.effort.source,'parent');
 });}finally{await fs.rm(cli.directory,{recursive:true,force:true});await fs.rm(state,{recursive:true,force:true});}
});

test('Codex refreshes an old local status after another process wrote an already-expired runtime limit',async()=>{
 const cli=await fakeCli('{}');const state=await fs.mkdtemp(path.join(os.tmpdir(),'agent-acp-codex-state-'));
 try{await withEnv({CODEX_CLI:cli.command,CODEX_MODEL:'auto',AGENT_MCP_STATE_DIR:state},async()=>{
  const {CodexProvider}=await loadProvider('codex');const provider=new CodexProvider();const countFile=path.join(cli.directory,'app-server-count');
  const initial=await provider.status();assert.equal(await fs.readFile(countFile,'utf8'),'1');
  assert.equal(initial.quota.source,'codex_app_server');assert.equal(initial.quota.usedPercent,10);
  const externalCache=new QuotaCache(path.join(state,'codex-quota.json'));
  await externalCache.markLimited('codex',{errorKind:'rate_limited',limitKind:'rate_limited',retryAfter:new Date(Date.now()+5).toISOString()},'other process',Date.now());
  await new Promise(resolve=>setTimeout(resolve,25));
  const refreshed=await provider.status();assert.equal(await fs.readFile(countFile,'utf8'),'2');
  assert.equal(refreshed.quota.source,'codex_app_server');assert.equal(refreshed.quota.usedPercent,10);
 });}finally{await fs.rm(cli.directory,{recursive:true,force:true});await fs.rm(state,{recursive:true,force:true});}
});
