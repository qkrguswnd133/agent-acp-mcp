import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {readCodexModels} from '../src/codex-app-server.js';
import {readClaudeModels} from '../src/claude-model-catalog.js';
async function fixture(source:string,run:(command:{command:string;argsPrefix:string[]},log:string)=>Promise<void>){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'model-rpc-')),script=path.join(dir,'server.mjs'),log=path.join(dir,'requests.jsonl');
 try{await fs.writeFile(script,`import fs from 'node:fs';import readline from 'node:readline';const log=${JSON.stringify(log)};for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);fs.appendFileSync(log,line+'\\n');${source}}`);await run({command:process.execPath,argsPrefix:[script]},log);}finally{await fs.rm(dir,{recursive:true,force:true});}
}
test('Codex model/list paginates all advertised models without starting a thread or turn',async()=>{
 await fixture(`if(!m.id)continue;const result=m.method==='model/list'?(m.params.cursor?{data:[{model:'second'}],nextCursor:null}:{data:[{model:'first'}],nextCursor:'page-2'}):{};process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');`,async(command,log)=>{
  assert.deepEqual((await readCodexModels(command)).map((m:any)=>m.model),['first','second']);
  const requests=(await fs.readFile(log,'utf8')).trim().split('\n').map(l=>JSON.parse(l));assert.deepEqual(requests.map(m=>m.method),['initialize','initialized','model/list','model/list']);assert.equal(requests[2].params.includeHidden,true);
 });
});
test('Codex malformed model list is an explicit discovery failure, never an empty authoritative list',async()=>{
 await fixture(`if(m.id)process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');`,async command=>{await assert.rejects(readCodexModels(command),/omitted data/);});
});
test('Claude official initialize advertises models without any user/model prompt',async()=>{
 await fixture(`process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{models:[{value:'opus',supportedEffortLevels:['high']}]}}})+'\\n');`,async(command,log)=>{
  const result=await readClaudeModels(command);assert.equal(result.models[0].value,'opus');
  const requests=(await fs.readFile(log,'utf8')).trim().split('\n').map(l=>JSON.parse(l));assert.equal(requests.length,1);assert.equal(requests[0].type,'control_request');assert.equal(requests[0].request.subtype,'initialize');
 });
});
test('Claude control rejection surfaces explicitly without a prompt fallback',async()=>{
 await fixture(`process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'error',request_id:m.request_id,error:'initialize unsupported'}})+'\\n');`,async command=>{await assert.rejects(readClaudeModels(command),/initialize unsupported/);});
});
