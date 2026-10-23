import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {CodexProgress} from '../src/codex-progress.js';
import {CodexSessionProgressReader,readCodexSessionTelemetry} from '../src/codex-session.js';
import {runCodexAppCommand} from '../src/codex-app-execution.js';
import {codexAppServerFixtureScript} from './fixtures/codex-app-server-fixture.js';
import {implementationProgress} from '../src/execution-evidence.js';
import {safeChildEnv} from '../src/process.js';

const id='00000000-0000-7000-8000-000000000078';
const started=Date.parse('2026-10-23T00:00:00Z');
const row=(type:string,payload:any,at=started)=>({type,payload,timestamp:new Date(at).toISOString()});
async function fixture(run:(root:string,file:string,cwd:string)=>Promise<void>){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'codex-progress-')),folder=path.join(root,'2026','10','23'),cwd=path.join(root,'workspace');
 await fs.mkdir(folder,{recursive:true});await fs.mkdir(cwd);
 try{await run(root,path.join(folder,`rollout-progress-${id}.jsonl`),cwd);}
 finally{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('codex-progress-'));await fs.rm(root,{recursive:true,force:true});}
}
const lines=(rows:any[])=>rows.map(item=>JSON.stringify(item)).join('\n')+'\n';

test('Codex CLI progress reports observed commands, testing, writes and pending cleanup without claiming test totals',()=>{
 const p=new CodexProgress(started);
 p.observeCli({type:'item.started',item:{type:'command_execution',id:'read',command:'rg -n "fixture" src'}},started+1);
 assert.equal(p.snapshot().phase,'reading');
 p.observeCli({type:'item.completed',item:{type:'command_execution',id:'read',exit_code:0}},started+2);
 p.observeCli({type:'item.started',item:{type:'command_execution',id:'test',command:'./gradlew test --no-daemon'}},started+3);
 assert.equal(p.snapshot().phase,'testing');assert.equal(p.snapshot().lastCommand.command,'./gradlew test --no-daemon');
 p.observeCli({type:'item.completed',item:{type:'command_execution',id:'test',exit_code:1}},started+4);
 p.observeCli({type:'item.completed',item:{type:'file_change',id:'patch',status:'completed',changes:[{path:'src/a.ts',kind:'update'}]}},started+5);
 p.observeCli({type:'item.completed',item:{type:'file_change',id:'patch',status:'completed'}},started+6);
 p.observeCli({type:'item.completed',item:{type:'agent_message',text:'All 100 tests passed'}},started+7);
 assert.equal(p.snapshot().completionObserved,false);assert.equal(p.snapshot().phase,'awaiting_terminal_event');
 const counts:any=p.snapshot();assert.equal(counts.commandsStarted,2);assert.equal(counts.commandsCompleted,2);assert.equal(counts.successfulReads,1);assert.equal(counts.successfulWrites,1);assert.equal(counts.testCommandsStarted,1);assert.equal(counts.failedCommands,1);assert.equal(counts.testsPassed,undefined);
 p.observeCli({type:'turn.completed'},started+8);
 assert.equal(implementationProgress('agent_implement',{implementationProgress:p.snapshot()},started+10).status,'completion_pending_cleanup');
 assert.match(implementationProgress('agent_implement',{implementationProgress:p.snapshot()},started+10).coverage,/Codex CLI/);
});

test('Matching session tool events provide progress, deduplicate call IDs and do not double count the CLI stream',()=>{
 const p=new CodexProgress(started);
 p.observeSession(row('response_item',{type:'function_call',name:'exec_command',call_id:'c1',arguments:JSON.stringify({cmd:'node --test test.js',workdir:'/work'})},started+1));
 p.observeSession(row('event_msg',{type:'exec_command_begin',call_id:'c1',command:['node','--test','test.js'],cwd:'/work'},started+2));
 p.observeSession(row('event_msg',{type:'exec_command_end',call_id:'c1',exit_code:0},started+3));
 p.observeCli({type:'item.completed',item:{type:'command_execution',id:'different-stream-id',command:'node --test test.js',exit_code:0}},started+4);
 assert.equal((p.snapshot() as any).commandsStarted,1);assert.equal((p.snapshot() as any).successfulCommands,1);
 p.observeSession(row('event_msg',{type:'patch_apply_end',call_id:'patch',success:false},started+5));
 assert.equal((p.snapshot() as any).successfulWrites,0);
 p.observeSession(row('event_msg',{type:'patch_apply_end',call_id:'patch',success:true},started+6));
 assert.equal((p.snapshot() as any).successfulWrites,1);
 p.observeSession(row('event_msg',{type:'exec_command_begin',call_id:'older',command:'cat old.txt'},started+1));
 assert.equal(p.snapshot().lastCommand.command,'node --test test.js','Older transcript rows must not replace the latest live command');
 assert.equal(p.observeSession(row('response_item',{type:'message',content:[{text:'run pytest'}]})),false);
 p.observeSession(row('event_msg',{type:'task_complete'},started+5));assert.equal(p.snapshot().phase,'completion_pending_cleanup','Terminal evidence must remain visible even when the CLI observation arrived slightly later');
});

test('Live session reader accepts only matching session, cwd and launch time, with no event replay',()=>fixture(async(root,file,cwd)=>{
 for(const meta of [row('session_meta',{id:'wrong',cwd}),row('session_meta',{id,cwd:root}),row('session_meta',{id,cwd},started-6000)]){
  await fs.writeFile(file,lines([meta,row('event_msg',{type:'exec_command_begin',call_id:'c1',command:'pytest'})]));
  assert.deepEqual((await new CodexSessionProgressReader(cwd,id,started,root).read(started+1000)).events,[]);
 }
 await fs.writeFile(file,lines([row('session_meta',{id,cwd,instructions:'fixture '.repeat(10_000)}),row('event_msg',{type:'exec_command_begin',call_id:'c1',command:'pytest'})]));
 const reader=new CodexSessionProgressReader(cwd,id,started,root),first=await reader.read(started+1000);
 assert.equal(first.events.length,2);assert.equal((await reader.read(started+1000)).events.length,0);
 await fs.appendFile(file,lines([row('event_msg',{type:'exec_command_end',call_id:'c1',exit_code:0},started+2000),row('event_msg',{type:'exec_command_begin',call_id:'stale',command:'other'},started-6000)]));
 const next=await reader.read(started+3000);assert.equal(next.events.length,1);assert.equal(next.events[0].payload.exit_code,0);
}));

test('Live session reader preserves split Korean UTF-8, bounds large gaps and exposes truncation',()=>fixture(async(root,file,cwd)=>{
 await fs.writeFile(file,lines([row('session_meta',{id,cwd})]));const reader=new CodexSessionProgressReader(cwd,id,started,root);await reader.read(started+1000);
 const command=Buffer.from(lines([row('event_msg',{type:'exec_command_begin',call_id:'c1',command:'Get-Content 한글.txt'},started+2000)]));
 const split=command.indexOf(Buffer.from('한'))+1;
 await fs.appendFile(file,command.subarray(0,split));assert.equal((await reader.read(started+3000)).events.length,0);
 await fs.appendFile(file,command.subarray(split));assert.equal((await reader.read(started+3000)).events[0].payload.command,'Get-Content 한글.txt');
 await fs.appendFile(file,'x'.repeat(800000)+'\n'+lines([row('event_msg',{type:'exec_command_begin',call_id:'last',command:'pytest latest.py'},started+4000)]));
 const tail=await reader.read(started+5000);assert.equal(tail.truncated,true);assert.equal(tail.events.length,1);assert.equal(tail.events[0].payload.call_id,'last');
}));

test('An explicitly returned resumed thread accepts older metadata but never previous-turn progress or completion',()=>fixture(async(root,_file,cwd)=>{
 const created=Date.parse('2026-09-15T01:00:00Z'),hex=created.toString(16).padStart(12,'0'),resumedId=`${hex.slice(0,8)}-${hex.slice(8)}-7000-8000-000000000078`;
 const folder=path.join(root,'2026','09','15');await fs.mkdir(folder,{recursive:true});const file=path.join(folder,`rollout-progress-${resumedId}.jsonl`);
 await fs.writeFile(file,lines([row('session_meta',{id:resumedId,cwd},created),row('turn_context',{cwd,model:'old-model',effort:'low'},started-1000),row('event_msg',{type:'task_complete',last_agent_message:'previous turn'},started-500),row('event_msg',{type:'exec_command_begin',call_id:'current',command:'pytest resumed.py'},started+1)]));
 assert.equal((await new CodexSessionProgressReader(cwd,resumedId,started,root).read(started+1000)).events.length,0);
 const scope={returnedThreadId:resumedId},reader=new CodexSessionProgressReader(cwd,resumedId,started,root,scope),progress=await reader.read(started+1000);
 assert.equal(progress.events.length,1);assert.equal(progress.events[0].payload.call_id,'current');assert.equal(progress.completed,false);
 const old=await readCodexSessionTelemetry(cwd,resumedId,started,started+1000,root,scope);assert.equal(old.completed,undefined);assert.equal(old.model,undefined);
 await fs.appendFile(file,lines([row('turn_context',{cwd,model:'new-model',effort:'high'},started+2000),row('event_msg',{type:'task_complete',last_agent_message:'current turn'},started+3000)]));
 const current=await readCodexSessionTelemetry(cwd,resumedId,started,started+4000,root,scope);assert.equal(current.completed,true);assert.equal(current.text,'current turn');assert.equal(current.model,'new-model');
 assert.equal((await reader.read(started+4000)).completed,true);
}));

test('runCodexAppCommand retains progress across raw stdout and cleanup events and distinguishes terminal finalization',async()=>{
 const activity:any[]=[];const events=[{type:'thread.started',thread_id:id},{type:'item.started',item:{type:'command_execution',id:'c',command:'npm test'}},{type:'item.completed',item:{type:'command_execution',id:'c',exit_code:0}},{type:'turn.completed'}];
 const result=await runCodexAppCommand(process.execPath,['--input-type=module','-e',codexAppServerFixtureScript(events)],{cwd:process.cwd(),prompt:'Read-only fixture',speed:'standard',sandbox:'read-only',env:safeChildEnv(),timeoutMs:20000,completionGraceMs:10,onActivity:event=>activity.push(event)});
 assert.ok(activity.some(event=>event.type==='stdout'));
 assert.ok(activity.some(event=>event.type==='codex_progress'&&event.implementationProgress.commandsStarted===1));
 assert.ok(activity.some(event=>event.type==='codex_progress'&&event.phase==='testing'));
 assert.ok(activity.some(event=>event.type==='codex_turn_completed'&&event.phase==='completion_pending_cleanup'));
 assert.equal(activity.at(-1).phase,'finalized');assert.equal(result.implementationProgress.phase,'finalized');assert.equal(result.completion.confirmed,true);
 assert.equal((result.implementationProgress as any).testCommandsStarted,1);assert.equal((result.implementationProgress as any).cpuIdle,undefined);
});

test('A running Codex with only session tool events publishes attributable live progress before its final reply',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'codex-progress-')),previous=process.env.CODEX_HOME,at=Date.now(),cwd=process.cwd();
 const folder=path.join(root,'sessions',...new Date(at).toISOString().slice(0,10).split('-'));await fs.mkdir(folder,{recursive:true});
 const file=path.join(folder,`rollout-progress-${id}.jsonl`),activity:any[]=[];
 try{
  process.env.CODEX_HOME=root;await fs.writeFile(file,lines([row('session_meta',{id,cwd},at)]));
  const script=codexAppServerFixtureScript([],{threadId:id,beforeTurn:`setTimeout(()=>fs.appendFileSync(${JSON.stringify(file)},JSON.stringify({timestamp:new Date().toISOString(),type:'event_msg',payload:{type:'exec_command_begin',call_id:'live',command:'pytest suite.py',cwd:${JSON.stringify(cwd)}}})+'\\n'),100);setTimeout(()=>note('turn/completed',{turn:{id:turnId,status:'completed',items:[],error:null}}),6500);`});
  const result=await runCodexAppCommand(process.execPath,['--input-type=module','-e',script],{cwd,prompt:'Read-only fixture',speed:'standard',sandbox:'read-only',env:safeChildEnv(),timeoutMs:20000,completionGraceMs:10,onActivity:event=>activity.push(event)},at);
  const observed=activity.find(event=>event.type==='codex_session_progress');
  assert.equal(observed?.phase,'testing');assert.equal(observed?.implementationProgress.lastCommand.command,'pytest suite.py');
  assert.equal(observed?.implementationProgress.source,'session_jsonl');assert.equal((result.implementationProgress as any).commandsStarted,1);
 }finally{if(previous===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previous;assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('codex-progress-'));await fs.rm(root,{recursive:true,force:true});}
});
