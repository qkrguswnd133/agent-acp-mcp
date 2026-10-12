import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runCodexCommand} from '../src/codex-execution.js';
import {runCommand,safeChildEnv} from '../src/process.js';
import {ownedDescendants} from '../src/process-tree.js';
import {readCodexSessionTelemetry} from '../src/codex-session.js';

const event=(value:unknown)=>`console.log(${JSON.stringify(JSON.stringify(value))});`;
const hang='setInterval(()=>{},1000);';
test('Codex turn.completed settles a CLI that keeps running and preserves output and usage',async()=>{
 const started=Date.now();const activity:Record<string,unknown>[]=[];
 const result=await runCodexCommand(process.execPath,['-e',event({type:'item.completed',item:{type:'agent_message',text:'검증 완료'}})+event({type:'turn.completed',usage:{input_tokens:19},model:'gpt-6-astra',reasoning_effort:'high'})+hang],{cwd:process.cwd(),env:safeChildEnv(),timeoutMs:20_000,completionGraceMs:100,onActivity:value=>activity.push(value)});
 assert.equal(result.stopReason,'completed');assert.equal(result.completion.confirmed,true);assert.equal(result.timedOut,false);
 assert.match(result.stdout,/검증 완료/);assert.match(result.stdout,/input_tokens/);assert.match(result.stdout,/gpt-6-astra/);
 assert.ok(activity.some(item=>item.type==='codex_turn_completed'));assert.ok(Date.now()-started<18000);
});
test('Final agent message alone never counts as successful completion; deadline retains partial output',async()=>{
 const result=await runCodexCommand(process.execPath,['-e',event({type:'item.completed',item:{type:'agent_message',text:'partial report'}})+hang],{cwd:process.cwd(),env:safeChildEnv(),timeoutMs:400});
 assert.equal(result.stopReason,'deadline_exceeded');assert.equal(result.timedOut,true);assert.equal(result.completion.confirmed,false);assert.match(result.stdout,/partial report/);
});
test('Abort settles a running child, preserving output without requiring clean exit',async()=>{
 const controller=new AbortController();let sent=false;const started=Date.now();
 const result=await runCommand(process.execPath,['-e','console.log("partial");'+hang],{env:safeChildEnv(),signal:controller.signal,onActivity:activity=>{if(activity.type==='stdout'&&!sent){sent=true;controller.abort();}}});
 assert.equal(result.stopReason,'cancelled');assert.equal(result.timedOut,false);assert.match(result.stdout,/partial/);assert.ok(Date.now()-started<10000);
});
test('Already aborted command does not spawn',async()=>{
 let spawned=false;const result=await runCommand(process.execPath,['-e',hang],{signal:AbortSignal.abort(),onSpawn:()=>{spawned=true;}});assert.equal(spawned,false);assert.equal(result.stopReason,'cancelled');
});
test('Deadline settles even when ChildProcess close and exit events never arrive',async()=>{
 const started=Date.now();
 const result=await runCommand(process.execPath,['-e','console.log("preserved");'+hang],{timeoutMs:300,onSpawn:child=>{
  const emit=child.emit.bind(child);child.emit=((name:string,...args:any[])=>name==='close'||name==='exit'?false:emit(name,...args)) as typeof child.emit;
 }});
 assert.equal(result.timedOut,true);assert.equal(result.stopReason,'deadline_exceeded');assert.match(result.stdout,/preserved/);assert.ok(Date.now()-started<10000);
});
test('Owned descendant discovery rejects reused owner PIDs and unrelated processes',()=>{
 const root={pid:100,parentPid:1,created:'root-start'},child={pid:101,parentPid:100,created:'child-start'},grandchild={pid:102,parentPid:101,created:'grandchild-start'};
 assert.deepEqual(ownedDescendants([root,child,grandchild,{pid:200,parentPid:1,created:'other'}],new Map([[100,root]])).map(x=>x.pid),[100,101,102]);
 assert.deepEqual(ownedDescendants([{...root,created:'reused'},child],new Map([[100,root]])),[]);
});
test('Session task_complete recovery is scoped to matching session, cwd and execution time',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'codex-completion-'));const started=Date.now(),id='00000000-0000-7000-8000-000000000055',cwd=path.join(root,'workspace');
 const folder=path.join(root,...new Date(started).toISOString().slice(0,10).split('-'));await fs.mkdir(folder,{recursive:true});
 const row=(type:string,payload:unknown,time=started)=>JSON.stringify({type,payload,timestamp:new Date(time).toISOString()});
 try{
  const rows=[row('session_meta',{id,cwd}),row('turn_context',{cwd,model:'gpt-6-astra',effort:'high'}),row('event_msg',{type:'token_count',info:{total_token_usage:{input_tokens:71,output_tokens:8}}}),row('event_msg',{type:'task_complete',last_agent_message:'Recovered final'})];
  const file=path.join(folder,`rollout-check-${id}.jsonl`);await fs.writeFile(file,rows.join('\n'));
  const evidence=await readCodexSessionTelemetry(cwd,id,started,started+1000,root);assert.equal(evidence.completed,true);assert.equal(evidence.text,'Recovered final');assert.deepEqual(evidence.usage,{input_tokens:71,output_tokens:8});assert.equal(evidence.effort,'high');
  assert.equal((await readCodexSessionTelemetry(root,id,started,started+1000,root)).completed,undefined);
  await fs.writeFile(file,rows.slice(0,-1).concat(row('event_msg',{type:'task_complete',last_agent_message:'stale'},started-6000)).join('\n'));
  assert.equal((await readCodexSessionTelemetry(cwd,id,started,started+1000,root)).completed,undefined);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('Missing terminal stream is recovered from session task_complete while the CLI is still alive',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'codex-recovery-')),previous=process.env.CODEX_HOME;
 const id='00000000-0000-7000-8000-000000000056',cwd=process.cwd(),now=new Date().toISOString();
 try{
  process.env.CODEX_HOME=root;const folder=path.join(root,'sessions',...now.slice(0,10).split('-'));await fs.mkdir(folder,{recursive:true});
  await fs.writeFile(path.join(folder,`rollout-check-${id}.jsonl`),[
   {type:'session_meta',payload:{id,cwd}},
   {type:'turn_context',payload:{cwd,model:'gpt-6-astra',effort:'high'}},
   {type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:51}}}},
   {type:'event_msg',payload:{type:'task_complete',last_agent_message:'Recovered without stream final'}}
  ].map(row=>JSON.stringify({...row,timestamp:now})).join('\n'));
  const result=await runCodexCommand(process.execPath,['-e',event({type:'thread.started',thread_id:id})+hang],{cwd,env:safeChildEnv(),timeoutMs:20_000,completionGraceMs:10});
  assert.equal(result.stopReason,'completed');assert.equal(result.completion.source,'session_jsonl');assert.equal(result.recovered?.text,'Recovered without stream final');assert.equal(result.recovered?.model,'gpt-6-astra');assert.deepEqual(result.recovered?.usage,{input_tokens:51});
 }finally{if(previous===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previous;await fs.rm(root,{recursive:true,force:true});}
});
test('Observed background descendants are stopped after normal Codex completion',async()=>{
 const script=`const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(hang)}],{detached:true,stdio:'ignore'});child.unref();console.log(JSON.stringify({daemonPid:child.pid}));setTimeout(()=>{${event({type:'turn.completed',usage:{input_tokens:1}})}},3500);`;
 const result=await runCodexCommand(process.execPath,['-e',script],{cwd:process.cwd(),env:safeChildEnv(),timeoutMs:20_000});
 const pid=JSON.parse(result.stdout.split('\n')[0]!).daemonPid;
 try{assert.ok(result.processCleanup?.trackedPids.includes(pid));assert.deepEqual(result.processCleanup?.remainingPids,[]);assert.throws(()=>process.kill(pid,0));}
 finally{try{process.kill(pid,'SIGKILL');}catch{}}
});
