import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {parseClaudeTerminalResult,runClaudeCommand} from '../src/claude-execution.js';
import {safeChildEnv} from '../src/process.js';
import {selectedInput} from './selection-fixture.js';

const hanging='setInterval(()=>{},1000);';
test('Claude terminal recognition requires a complete official top-level result',()=>{
 for(const value of ['Done',JSON.stringify('Done'),'{"type":"result","result":',JSON.stringify({type:'assistant',message:'Done'}),JSON.stringify({message:{type:'result',result:'nested'}})])assert.equal(parseClaudeTerminalResult(value),undefined);
 assert.equal(parseClaudeTerminalResult(JSON.stringify({type:'result',is_error:false,result:'Done'}))?.result,'Done');
 assert.equal(parseClaudeTerminalResult(JSON.stringify({type:'result',is_error:true,errors:['limit']}))?.is_error,true);
});
test('Claude JSON result without a trailing newline terminates a hanging CLI',async()=>{
 const envelope=JSON.stringify({type:'result',is_error:false,result:'한글 result',usage:{input_tokens:9}}),middle=Math.floor(envelope.length/2);
 const result=await runClaudeCommand(process.execPath,['-e',`process.stdout.write(${JSON.stringify(envelope.slice(0,middle))});setTimeout(()=>process.stdout.write(${JSON.stringify(envelope.slice(middle))}),200);${hanging}`],{cwd:process.cwd(),env:safeChildEnv(),timeoutMs:20_000,completionGraceMs:50});
 assert.equal(result.stopReason,'completed');assert.equal(result.completion.confirmed,true);assert.equal(result.terminalResult?.result,'한글 result');assert.deepEqual(result.terminalResult?.usage,{input_tokens:9});assert.ok(result.processCleanup);
});
test('Final-looking Claude prose is not a completion signal and deadline remains effective',async()=>{
 const result=await runClaudeCommand(process.execPath,['-e',`process.stdout.write('Everything is finished.');${hanging}`],{cwd:process.cwd(),env:safeChildEnv(),timeoutMs:350});
 assert.equal(result.stopReason,'deadline_exceeded');assert.equal(result.completion.confirmed,false);assert.equal(result.stdout,'Everything is finished.');
});

async function fixture(source:string,run:(provider:any,root:string)=>Promise<void>){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'claude-completion-')),command=path.join(root,process.platform==='win32'?'cli.cmd':'cli.sh');
 const env={CLAUDE_CLI:command,CLAUDE_CONFIG_DIR:root,AGENT_MCP_STATE_DIR:path.join(root,'state'),CLAUDE_MODEL:'auto',CLAUDE_EFFORT:'auto'};
 const previous=new Map(Object.keys(env).map(key=>[key,process.env[key]]));
 try{
  await fs.writeFile(path.join(root,'cli.mjs'),`import fs from 'node:fs';import path from 'node:path';const args=process.argv.slice(2);const id=args[args.indexOf('--session-id')+1];const transcript=path.join(process.env.CLAUDE_CONFIG_DIR,'projects','fixture',id+'.jsonl');fs.mkdirSync(path.dirname(transcript),{recursive:true});${source}`);
  if(process.platform==='win32')await fs.writeFile(command,`@echo off\r\n"${process.execPath}" "%~dp0cli.mjs" %*\r\n`);
  else{await fs.writeFile(command,`#!/bin/sh\n"${process.execPath}" "$(dirname "$0")/cli.mjs" "$@"\n`);await fs.chmod(command,0o755);}
  Object.assign(process.env,env);const {ClaudeProvider}=await import(`../src/providers/claude.js?completion=${Math.random()}`);await run(new ClaudeProvider(),root);
 }finally{for(const [key,value] of previous){if(value===undefined)delete process.env[key];else process.env[key]=value;}await fs.rm(root,{recursive:true,force:true});}
}
const transcriptSource=`fs.writeFileSync(transcript,JSON.stringify({type:'assistant',sessionId:id,cwd:process.cwd(),effort:'high',message:{model:'claude-observed',content:[{type:'text',text:'Partial transcript answer'}],usage:{input_tokens:17,output_tokens:2}}}));`;
test('Hanging Claude successful result preserves model, effort, usage, session and JSONL attribution',()=>fixture(
 `fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR,'env.json'),JSON.stringify({gradle:process.env.GRADLE_USER_HOME,args,cwd:process.cwd()}));${transcriptSource}process.stdout.write(JSON.stringify({type:'result',is_error:false,session_id:id,result:'Complete answer',effort:'high',modelUsage:{'claude-observed':{inputTokens:31}},usage:{input_tokens:31,output_tokens:4}}));${hanging}`,
 async(provider,root)=>{
  const result=await provider.execute('agent_implement',selectedInput({cwd:root,task:'fixture',max_runtime_minutes:1},'claude'));
  assert.equal(result.error,null);assert.equal(result.text,'Complete answer');assert.equal(result.model,'claude-observed');assert.equal(result.effort,'high');assert.deepEqual(result.usage,{input_tokens:31,output_tokens:4});assert.equal(result.completion.confirmed,true);assert.equal(result.processExit.stopReason,'completed');assert.ok(result.processCleanup);assert.equal(typeof result.childCleanedUp,'boolean');
  const invocation=JSON.parse(await fs.readFile(path.join(root,'env.json'),'utf8'));assert.equal(invocation.cwd,root);assert.equal(invocation.args[invocation.args.indexOf('--output-format')+1],'json');assert.equal(invocation.args.includes('--no-session-persistence'),false);assert.equal(invocation.gradle,path.join(root,'state','gradle',result.sessionId));assert.equal(await fs.readFile(path.join(root,'projects','fixture',result.sessionId+'.jsonl'),'utf8').then(text=>JSON.parse(text).cwd),root);
 }
));
test('Hanging Claude error result stays a quota failure and retains transcript partial output',()=>fixture(
 `${transcriptSource}process.stdout.write(JSON.stringify({type:'result',is_error:true,session_id:id,result:'usage quota exhausted',usage:{input_tokens:25}}));${hanging}`,
 async(provider,root)=>{const result=await provider.execute('agent_ask',selectedInput({cwd:root,task:'fixture',max_runtime_minutes:1},'claude'));assert.equal(result.errorKind,'quota_exhausted');assert.equal(result.text,'Partial transcript answer');assert.deepEqual(result.usage,{input_tokens:25});assert.equal(result.completion.isError,true);assert.equal(result.gradleUserHome,undefined);}
));
test('Claude cancellation retains attributable partial transcript metadata after malformed JSON',()=>fixture(
 `${transcriptSource}process.stdout.write('{"type":"result"');${hanging}`,
 async(provider,root)=>{const controller=new AbortController();const result=await provider.execute('agent_implement',selectedInput({cwd:root,task:'fixture',max_runtime_minutes:1},'claude'),controller.signal,{onActivity:(event:any)=>{if(event.type==='stdout')controller.abort();}});assert.equal(result.errorKind,'cancelled');assert.equal(result.text,'Partial transcript answer');assert.equal(result.model,'claude-observed');assert.equal(result.effort,'high');assert.deepEqual(result.usage,{input_tokens:17,output_tokens:2});assert.equal(result.completion.confirmed,false);assert.ok(result.processCleanup);}
));
test('Claude cancellation after direct result preserves direct response instead of discarding it',()=>fixture(
 `process.stdout.write(JSON.stringify({type:'result',is_error:false,session_id:id,result:'Direct answer before cancel',effort:'low',usage:{input_tokens:11}}));${hanging}`,
 async(provider,root)=>{const controller=new AbortController();const result=await provider.execute('agent_ask',selectedInput({cwd:root,task:'fixture',max_runtime_minutes:1},'claude'),controller.signal,{onActivity:(event:any)=>{if(event.type==='stdout')controller.abort();}});assert.equal(result.errorKind,'cancelled');assert.equal(result.text,'Direct answer before cancel');assert.deepEqual(result.usage,{input_tokens:11});assert.equal(result.effort,'low');}
));
test('Claude deadline preserves partial transcript result, telemetry and malformed raw stdout',()=>fixture(
 `${transcriptSource}process.stdout.write('{"type":"result"');${hanging}`,
 async(provider,root)=>{const result=await provider.execute('agent_implement',selectedInput({cwd:root,task:'fixture',max_runtime_minutes:0.01},'claude'));assert.equal(result.errorKind,'deadline_exceeded');assert.equal(result.text,'Partial transcript answer');assert.equal(result.model,'claude-observed');assert.deepEqual(result.usage,{input_tokens:17,output_tokens:2});assert.equal(result.rawEvents,'{"type":"result"');assert.equal(result.processExit.timedOut,true);}
));
