import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {readCodexSessionTelemetry,codexRuntimeMetadata} from '../src/codex-session.js';
const id='00000000-0000-7000-8000-000000000001';
const started=Date.parse('2026-01-02T03:00:00Z'),ended=started+3000;
const row=(type:string,payload:unknown,at=started+1000)=>({type,payload,timestamp:new Date(at).toISOString()});
async function fixture(run:(root:string,file:string,cwd:string)=>Promise<void>){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'codex-model-')),cwd=path.join(root,'workspace');
 const folder=path.join(root,'2026','01','02');await fs.mkdir(folder,{recursive:true});
 try{await run(root,path.join(folder,`rollout-time-${id}.jsonl`),cwd);}finally{await fs.rm(root,{recursive:true,force:true});}
}
const write=(file:string,rows:unknown[])=>fs.writeFile(file,rows.map(r=>typeof r==='string'?r:JSON.stringify(r)).join('\n'));
test('Codex metadata uses matching session identity, cwd and turn time',()=>fixture(async(root,file,cwd)=>{
 await write(file,[row('session_meta',{id,cwd}),'{bad',row('turn_context',{cwd,model:'gpt-observed',effort:'high'}),row('response_item',{model:'untrusted-tool-output'})]);
 const result=await readCodexSessionTelemetry(cwd,id,started,ended,root);
 assert.equal(result.model,'gpt-observed');assert.equal(result.effort,'high');assert.equal(result.source,'session_jsonl');
 assert.equal(codexRuntimeMetadata(undefined,undefined,result).modelSource,'session_jsonl');
}));
test('Wrong IDs, paths, stale sessions and absent metadata are never attributed',()=>fixture(async(root,file,cwd)=>{
 for(const meta of [row('session_meta',{id:'other',cwd}),row('session_meta',{id,cwd:root}),row('session_meta',{id,cwd},started-6000)]){
  await write(file,[meta,row('turn_context',{cwd,model:'wrong',effort:'low'})]);
  assert.equal((await readCodexSessionTelemetry(cwd,id,started,ended,root)).model,undefined);
 }
 await write(file,[row('session_meta',{id,cwd}),row('turn_context',{cwd,model:'stale'},started-6000),row('turn_context',{cwd:root,model:'other'})]);
 assert.equal((await readCodexSessionTelemetry(cwd,id,started,ended,root)).model,undefined);
 assert.equal((await readCodexSessionTelemetry(cwd,'../bad',started,ended,root)).source,'unavailable');
}));
test('Model changes stay ambiguous, CLI evidence takes precedence and no requested model is invented',()=>fixture(async(root,file,cwd)=>{
 await write(file,[row('session_meta',{id,cwd}),row('turn_context',{cwd,model:'a',effort:'low'}),row('turn_context',{cwd,model:'b',effort:'high'})]);
 const result=await readCodexSessionTelemetry(cwd,id,started,ended,root);
 assert.deepEqual(result.observedModels,['a','b']);assert.equal(result.model,undefined);
 assert.equal(codexRuntimeMetadata('auto',null,result).model,'unavailable');
 assert.equal(codexRuntimeMetadata('runtime-c','xhigh',result).model,'runtime-c');
 assert.equal(codexRuntimeMetadata('runtime-c','xhigh',result).modelSource,'cli_json');
}));
test('Missing and oversized transcripts are best-effort unavailable',()=>fixture(async(root,file,cwd)=>{
 assert.equal((await readCodexSessionTelemetry(cwd,id,started,ended,root)).source,'unavailable');
 const handle=await fs.open(file,'w');await handle.truncate(65*1024*1024);await handle.close();
 assert.equal((await readCodexSessionTelemetry(cwd,id,started,ended,root)).source,'unavailable');
}));
