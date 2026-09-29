import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type {RunInput} from '../src/types.js';

async function fakeCli(root:string,name:string,output:string,code=0){
 const script=path.join(root,`${name}.mjs`),argsFile=path.join(root,`${name}-args.json`);
 await fs.writeFile(script,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(argsFile)},JSON.stringify(process.argv.slice(2)));process.stdout.write(${JSON.stringify(output)});process.exit(${code});`);
 const command=path.join(root,`${name}.${process.platform==='win32'?'cmd':'sh'}`);
 if(process.platform==='win32')await fs.writeFile(command,`@echo off\r\n"${process.execPath}" "%~dp0${name}.mjs" %*\r\n`);
 else{await fs.writeFile(command,`#!/bin/sh\n"${process.execPath}" "$(dirname "$0")/${name}.mjs" "$@"\n`);await fs.chmod(command,0o755);}
 return {command,argsFile};
}
async function withEnv(values:Record<string,string|undefined>,run:()=>Promise<void>){
 const old=new Map(Object.keys(values).map(key=>[key,process.env[key]]));
 for(const [key,value] of Object.entries(values)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
 try{await run();}finally{for(const [key,value] of old){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
}
async function argsAt(file:string):Promise<string[]>{return JSON.parse(await fs.readFile(file,'utf8'));}
function flag(args:string[],name:string){const at=args.indexOf(name);return at<0?undefined:args[at+1];}
const input=(provider:'claude'|'codex',settings:Partial<RunInput>={}):RunInput=>({task:'fixture',cwd:process.cwd(),provider,...settings});

test('Claude per-run model and effort override environment without changing observed model metadata',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'agent-acp-claude-overrides-'));
 const cli=await fakeCli(root,'claude',JSON.stringify({type:'result',result:'done',modelUsage:{'claude-snapshot-20260928':{inputTokens:1}}}));
 try{await withEnv({CLAUDE_CLI:cli.command,CLAUDE_MODEL:'env-model',CLAUDE_EFFORT:'high',AGENT_MCP_STATE_DIR:root,CLAUDE_CONFIG_DIR:root},async()=>{
  const {ClaudeProvider}=await import(`../src/providers/claude.js?fixture=${Math.random()}`);
  const provider=new ClaudeProvider();
  const overridden=await provider.run('agent_ask',input('claude',{model:'sonnet',effort:'low'}));
  let args=await argsAt(cli.argsFile);
  assert.equal(flag(args,'--model'),'sonnet');assert.equal(flag(args,'--effort'),'low');
  assert.equal(overridden.requestedModel,'sonnet');assert.equal(overridden.requestedEffort,'low');
  assert.equal(overridden.requestedModelSource,'call');assert.equal(overridden.requestedEffortSource,'call');
  assert.equal(overridden.model,'claude-snapshot-20260928');assert.equal(overridden.modelSource,'cli_result');
  assert.equal(overridden.error,null);

  const configured=await provider.run('agent_ask',input('claude'));
  args=await argsAt(cli.argsFile);
  assert.equal(flag(args,'--model'),'env-model');assert.equal(flag(args,'--effort'),'high');
  assert.equal(configured.requestedModelSource,'environment');assert.equal(configured.requestedEffortSource,'environment');

  const automatic=await provider.run('agent_ask',input('claude',{provider_options:{claude:{model:'auto',effort:'auto'}}}));
  args=await argsAt(cli.argsFile);
  assert.equal(flag(args,'--model'),undefined);assert.equal(flag(args,'--effort'),undefined);
  assert.equal(automatic.requestedModel,'auto');assert.equal(automatic.requestedEffort,'auto');
  assert.equal(automatic.requestedModelSource,'call');assert.equal(automatic.requestedEffortSource,'call');
 });}finally{await fs.rm(root,{recursive:true,force:true});}
});

test('Claude unsupported model failure retains requested selection and unavailable actual telemetry',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'agent-acp-claude-unsupported-'));
 const cli=await fakeCli(root,'claude',JSON.stringify({type:'result',is_error:true,result:'unknown model identifier'}),1);
 try{await withEnv({CLAUDE_CLI:cli.command,CLAUDE_MODEL:'env-model',CLAUDE_EFFORT:'high',AGENT_MCP_STATE_DIR:root,CLAUDE_CONFIG_DIR:root},async()=>{
  const {ClaudeProvider}=await import(`../src/providers/claude.js?fixture=${Math.random()}`);
  const result=await new ClaudeProvider().run('agent_ask',input('claude',{model:'unsupported-model',effort:'low'}));
  assert.equal(result.error,'unknown model identifier');assert.equal(result.requestedModel,'unsupported-model');assert.equal(result.requestedEffort,'low');
  assert.equal(result.requestedModelSource,'call');assert.equal(result.requestedEffortSource,'call');
  assert.equal(result.model,'unavailable');assert.equal(result.effort,'unavailable');
 });}finally{await fs.rm(root,{recursive:true,force:true});}
});

test('Codex per-run model and effort override environment, while auto omits CLI settings',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'agent-acp-codex-overrides-'));
 const cli=await fakeCli(root,'codex',JSON.stringify({type:'turn.completed',model:'codex-snapshot',reasoning_effort:'low'}));
 try{await withEnv({CODEX_CLI:cli.command,CODEX_MODEL:'env-model',CODEX_EFFORT:'high',AGENT_MCP_STATE_DIR:root},async()=>{
  const {CodexProvider}=await import(`../src/providers/codex.js?fixture=${Math.random()}`);
  const provider=new CodexProvider();
  const overridden=await provider.run('agent_ask',input('codex',{model:'o4',effort:'low'}));
  let args=await argsAt(cli.argsFile);
  assert.equal(flag(args,'--model'),'o4');assert.equal(args.find(value=>value.startsWith('model_reasoning_effort=')),'model_reasoning_effort="low"');
  assert.equal(overridden.requestedModel,'o4');assert.equal(overridden.requestedEffort,'low');
  assert.equal(overridden.requestedModelSource,'call');assert.equal(overridden.requestedEffortSource,'call');
  assert.equal(overridden.model,'codex-snapshot');assert.equal(overridden.effort,'low');

  const configured=await provider.run('agent_ask',input('codex'));
  args=await argsAt(cli.argsFile);
  assert.equal(flag(args,'--model'),'env-model');assert.equal(args.find(value=>value.startsWith('model_reasoning_effort=')),'model_reasoning_effort="high"');
  assert.equal(configured.requestedModelSource,'environment');assert.equal(configured.requestedEffortSource,'environment');

  const automatic=await provider.run('agent_ask',input('codex',{provider_options:{codex:{model:'auto',effort:'auto'}}}));
  args=await argsAt(cli.argsFile);
  assert.equal(flag(args,'--model'),undefined);assert.equal(args.some(value=>value.startsWith('model_reasoning_effort=')),false);
  assert.equal(automatic.requestedModel,'auto');assert.equal(automatic.requestedEffort,'auto');
  assert.equal(automatic.requestedModelSource,'call');assert.equal(automatic.requestedEffortSource,'call');
 });}finally{await fs.rm(root,{recursive:true,force:true});}
});

test('Codex unsupported model failure keeps partial work and does not claim an actual setting',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'agent-acp-codex-unsupported-'));
 const events=[{type:'item.completed',item:{type:'agent_message',text:'Partial work'}},{type:'turn.failed',error:{message:'unknown model identifier'}}].map(value=>JSON.stringify(value)).join('\n');
 const cli=await fakeCli(root,'codex',events,1);
 try{await withEnv({CODEX_CLI:cli.command,CODEX_MODEL:'env-model',CODEX_EFFORT:'high',AGENT_MCP_STATE_DIR:root},async()=>{
  const {CodexProvider}=await import(`../src/providers/codex.js?fixture=${Math.random()}`);
  const result=await new CodexProvider().run('agent_ask',input('codex',{model:'unsupported-model',effort:'low'}));
  assert.equal(result.error,'unknown model identifier');assert.equal(result.text,'Partial work');
  assert.equal(result.requestedModel,'unsupported-model');assert.equal(result.requestedEffort,'low');
  assert.equal(result.requestedModelSource,'call');assert.equal(result.requestedEffortSource,'call');
  assert.equal(result.model,'unavailable');assert.equal(result.effort,'unavailable');
 });}finally{await fs.rm(root,{recursive:true,force:true});}
});
