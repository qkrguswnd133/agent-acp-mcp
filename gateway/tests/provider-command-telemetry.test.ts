import {selectedInput} from './selection-fixture.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {readClaudeSessionTelemetry} from '../src/claude-session.js';

async function fakeCli(source:string){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agent-acp-command-fixture-'));
 await fs.writeFile(path.join(dir,'cli.mjs'),source);
 const command=path.join(dir,process.platform==='win32'?'cli.cmd':'cli.sh');
 if(process.platform==='win32')await fs.writeFile(command,`@echo off\r\n"${process.execPath}" "%~dp0cli.mjs" %*\r\n`);
 else{await fs.writeFile(command,`#!/bin/sh\n"${process.execPath}" "$(dirname "$0")/cli.mjs" "$@"\n`);await fs.chmod(command,0o755);}
 return {dir,command};
}
async function envRun(values:Record<string,string>,run:()=>Promise<void>){
 const previous=new Map(Object.keys(values).map(key=>[key,process.env[key]]));
 for(const [key,value] of Object.entries(values))process.env[key]=value;
 try{await run();}finally{for(const [key,value] of previous){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
}

test('Claude transcript pairs only matching Bash uses and results from the selected session',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'agent-acp-claude-commands-'));
 const dir=path.join(root,'project');await fs.mkdir(dir);const cwd=process.cwd(),id='12345678-1234-1234-1234-123456789abc';
 const common={sessionId:id,cwd};
 const rows=[
  {type:'assistant',...common,effort:'high',message:{model:'claude-fixture',content:[{type:'tool_use',id:'bash-1',name:'Bash',input:{command:'npm test'}},{type:'tool_use',id:'read-1',name:'Read',input:{file_path:'file'}}]}},
  {type:'user',...common,toolUseResult:{stdout:'pass',stderr:'warning',exitCode:0},message:{content:[{type:'tool_result',tool_use_id:'bash-1',content:'tool output'}]}},
  {type:'assistant',...common,effort:'high',message:{model:'claude-fixture',content:[{type:'tool_use',id:'bash-2',name:'Bash',input:{command:'pytest'}}]}},
  {type:'user',...common,message:{content:[{type:'tool_result',tool_use_id:'bash-2',content:'failed'}]}},
  {type:'assistant',...common,sessionId:'other-session',effort:'high',message:{content:[{type:'tool_use',id:'other',name:'Bash',input:{command:'secret'}}]}},
 ];
 try{
  await fs.writeFile(path.join(dir,`${id}.jsonl`),rows.map(row=>JSON.stringify(row)).join('\n'));
  const telemetry=await readClaudeSessionTelemetry(cwd,id,[root]);
  assert.deepEqual(telemetry.commandExecutions,[
   {command:'npm test',cwd,exitCode:0,output:'pass\nwarning',source:'session_jsonl'},
   {command:'pytest',cwd,exitCode:null,output:'failed',source:'session_jsonl'},
  ]);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('Claude implementation grants Bash only for writable runs and returns transcript commands after failure',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'agent-acp-claude-run-'));
 const state=path.join(root,'state');await fs.mkdir(state);
 const cli=await fakeCli(`import fs from 'node:fs';import path from 'node:path';const args=process.argv.slice(2);if(process.env.AGENT_ACP_MCP_DELEGATED!=='1')throw Error('missing delegation marker');fs.writeFileSync(${JSON.stringify(path.join(root,'args.json'))},JSON.stringify(args));const id=args[args.indexOf('--session-id')+1];const file=path.join(process.env.CLAUDE_CONFIG_DIR,'projects','fixture',id+'.jsonl');fs.mkdirSync(path.dirname(file),{recursive:true});const cwd=process.cwd();const rows=[{type:'assistant',sessionId:id,cwd,effort:'high',message:{model:'claude-fixture',content:[{type:'tool_use',id:'bash-1',name:'Bash',input:{command:'npm test'}}]}},{type:'user',sessionId:id,cwd,toolUseResult:{stdout:'tests failed',exitCode:1},message:{content:[{type:'tool_result',tool_use_id:'bash-1',content:'tests failed'}]}}];fs.writeFileSync(file,rows.map(row=>JSON.stringify(row)).join('\\n'));process.stdout.write(JSON.stringify({type:'result',is_error:true,result:'task failed',usage:{input_tokens:2}}));`);
 try{await envRun({CLAUDE_CLI:cli.command,CLAUDE_CONFIG_DIR:root,AGENT_MCP_STATE_DIR:state,CLAUDE_MODEL:'auto',CLAUDE_EFFORT:'auto'},async()=>{
  const {ClaudeProvider}=await import(`../src/providers/claude.js?fixture=${Math.random()}`);
  const result=await new ClaudeProvider().run('agent_implement',selectedInput({task:'run tests',cwd:process.cwd()}, 'claude'));
  const args: string[]=JSON.parse(await fs.readFile(path.join(root,'args.json'),'utf8'));
  assert.equal(args[args.indexOf('--tools')+1],'Read,Glob,Grep,Edit,Write,Bash');
  assert.equal(args[args.indexOf('--allowedTools')+1],'Bash');
  assert.ok(args.includes('--strict-mcp-config'));assert.equal(args[args.indexOf('--mcp-config')+1],'{"mcpServers":{}}');
  assert.equal(result.error,'task failed');assert.deepEqual(result.usage,{input_tokens:2});assert.equal(result.model,'claude-fixture');
  assert.deepEqual(result.commandExecutions,[{command:'npm test',cwd:process.cwd(),exitCode:1,output:'tests failed',source:'session_jsonl'}]);
  await new ClaudeProvider().run('agent_ask',selectedInput({task:'inspect',cwd:process.cwd()}, 'claude'));
  const readArgs:string[]=JSON.parse(await fs.readFile(path.join(root,'args.json'),'utf8'));
  assert.equal(readArgs[readArgs.indexOf('--tools')+1],'Read,Glob,Grep');assert.equal(readArgs.includes('--allowedTools'),false);
 });}finally{await fs.rm(cli.dir,{recursive:true,force:true});await fs.rm(root,{recursive:true,force:true});}
});

test('Codex records command execution events on success and failure without reading assistant prose',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'agent-acp-codex-run-'));
 try{for(const fail of ['0','1']){
 const cli=await fakeCli(`if(process.env.AGENT_ACP_MCP_DELEGATED!=='1')throw Error('missing delegation marker');const argv=process.argv.slice(2);if(!argv.includes('--ignore-user-config')||!argv.includes('mcp_servers={}')||!argv.includes('features.plugins=false'))throw Error('nested MCP enabled');const events=[{type:'thread.started',thread_id:'thread-fixture'},{type:'item.started',item:{id:'command-1',type:'command_execution',command:'npm test',cwd:'C:/fixture'}},{type:'item.completed',item:{id:'command-1',type:'command_execution',command:'npm test',aggregated_output:'all passed',exit_code:0}},{type:'item.completed',item:{type:'agent_message',text:'I ran pytest and it passed'}},{type:${fail==='1'?'\'turn.failed\'':'\'turn.completed\''},error:${fail==='1'?"{message:'task failed'}":'undefined'},usage:{input_tokens:3}}];process.stdout.write(events.map(x=>JSON.stringify(x)).join('\\n'));`);
 try{await envRun({CODEX_CLI:cli.command,CODEX_MODEL:'auto',CODEX_EFFORT:'auto',AGENT_MCP_STATE_DIR:root},async()=>{
  const {CodexProvider}=await import(`../src/providers/codex.js?fixture=${Math.random()}`);
  const result=await new CodexProvider().run('agent_implement',selectedInput({task:'run tests',cwd:process.cwd()}, 'codex'));
  assert.equal(result.error,fail==='1'?'task failed':null);assert.deepEqual(result.usage,{input_tokens:3});
  assert.deepEqual(result.commandExecutions,[{command:'npm test',cwd:'C:/fixture',exitCode:0,output:'all passed',source:'codex_json'}]);
  assert.equal(result.text,'I ran pytest and it passed');
 });}finally{await fs.rm(cli.dir,{recursive:true,force:true});}
 }}finally{await fs.rm(root,{recursive:true,force:true});}
});
