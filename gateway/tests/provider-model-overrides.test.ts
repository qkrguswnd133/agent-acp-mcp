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

for(const name of ['claude','codex'] as const){
 test(`${name} direct adapter enforces parent selection and retains observed telemetry`,async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),`agent-${name}-selection-`));
  const output=name==='claude'?JSON.stringify({type:'result',result:'done',modelUsage:{'observed-snapshot':{inputTokens:1}},effort:'low'}):JSON.stringify({type:'turn.completed',model:'observed-snapshot',reasoning_effort:'low'});
  const cli=await fakeCli(root,name,output);
  const prefix=name.toUpperCase();
  try{await withEnv({[`${prefix}_CLI`]:cli.command,[`${prefix}_MODEL`]:'auto',[`${prefix}_EFFORT`]:'auto',AGENT_MCP_STATE_DIR:root,CLAUDE_CONFIG_DIR:root,CODEX_HOME:root},async()=>{
   const module=await import(`../src/providers/${name}.js?fixture=${Math.random()}`);const provider=name==='claude'?new module.ClaudeProvider():new module.CodexProvider();
   const missing=await provider.run('agent_ask',input(name));assert.equal(missing.errorKind,'MODEL_SELECTION_REQUIRED');
   await assert.rejects(fs.stat(cli.argsFile));
   const noReason=await provider.run('agent_ask',input(name,{model:'chosen',effort:'low'}));assert.equal(noReason.errorKind,'SELECTION_REASON_REQUIRED');
   const result=await provider.run('agent_ask',input(name,{model:'chosen',effort:'low',selection_reason:'bounded task'}));
   const args=await argsAt(cli.argsFile);assert.equal(flag(args,'--model'),'chosen');
   assert.equal(name==='claude'?flag(args,'--effort'):args.find(v=>v.startsWith('model_reasoning_effort=')),name==='claude'?'low':'model_reasoning_effort="low"');
   assert.equal(result.error,null);assert.equal(result.model,'observed-snapshot');assert.equal(result.effort,'low');
   assert.deepEqual(result.selection,{model:{value:'chosen',source:'parent',reason:'bounded task'},effort:{value:'low',source:'parent',reason:'bounded task'}});
   assert.equal(result.observation.model.verified,true);assert.equal(result.observation.model.value,'observed-snapshot');
   process.env[`${prefix}_MODEL`]='fixed';process.env[`${prefix}_EFFORT`]='high';
   const fixed=await provider.run('agent_ask',input(name));assert.equal(fixed.selection.model.source,'configured');assert.equal(flag(await argsAt(cli.argsFile),'--model'),'fixed');
   const conflict=await provider.run('agent_ask',input(name,{model:'other'}));assert.equal(conflict.errorKind,'FIXED_SETTING_CONFLICT');assert.equal(conflict.model,'unavailable');
   const automatic=await provider.run('agent_ask',input(name,{model:'auto',effort:'auto'}));assert.equal(automatic.errorKind,'FIXED_SETTING_CONFLICT');
  });}finally{await fs.rm(root,{recursive:true,force:true});}
 });
 test(`${name} CLI model rejection retains selection, partial results and unknown observation`,async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),`agent-${name}-reject-`));
  const output=name==='claude'?JSON.stringify({type:'result',is_error:true,result:'unknown model identifier',usage:{input_tokens:3}}):[{type:'item.completed',item:{type:'agent_message',text:'Partial work'}},{type:'turn.failed',error:{message:'unknown model identifier'},usage:{input_tokens:3}}].map(v=>JSON.stringify(v)).join('\n');
  const cli=await fakeCli(root,name,output,1),prefix=name.toUpperCase();
  try{await withEnv({[`${prefix}_CLI`]:cli.command,[`${prefix}_MODEL`]:'auto',[`${prefix}_EFFORT`]:'auto',AGENT_MCP_STATE_DIR:root,CLAUDE_CONFIG_DIR:root,CODEX_HOME:root},async()=>{
   const module=await import(`../src/providers/${name}.js?fixture=${Math.random()}`);const provider=name==='claude'?new module.ClaudeProvider():new module.CodexProvider();
   const result=await provider.run('agent_ask',input(name,{model:'unsupported-model',effort:'low',selection_reason:'explicit test'}));
   assert.equal(result.error,'unknown model identifier');assert.equal(result.errorKind,'UNSUPPORTED_MODEL_OR_EFFORT');assert.equal(result.selection.model.value,'unsupported-model');
   assert.equal(result.observation.model.verified,false);assert.equal(result.model,'unavailable');assert.equal(result.effort,'unavailable');assert.deepEqual(result.usage,{input_tokens:3});
   if(name==='codex')assert.equal(result.text,'Partial work');
  });}finally{await fs.rm(root,{recursive:true,force:true});}
 });
}
