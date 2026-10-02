import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {CLIENT_INFO_META_KEY,PROTOCOL_VERSION_META_KEY,CLIENT_CAPABILITIES_META_KEY,LOG_LEVEL_META_KEY} from '@modelcontextprotocol/server';

async function bridge(t:any){
  const child=spawn(process.execPath,[fileURLToPath(new URL('../src/index.js',import.meta.url))],{windowsHide:true,env:{...process.env,GROK_ENABLED:'false',CLAUDE_ENABLED:'false',CODEX_ENABLED:'false',ALLOW_SELF_PROVIDER:'false'},stdio:['pipe','pipe','pipe']});
  child.stderr.resume();
  const lines=createInterface({input:child.stdout}),pending=new Map<number,(value:any)=>void>();let id=0;
  lines.on('line',line=>{try{const result=JSON.parse(line);pending.get(result.id)?.(result);}catch{}});
  t.after(async()=>{lines.close();if(child.exitCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;}});
  const send=(method:string,params:any)=>new Promise<any>((resolve,reject)=>{
    const requestId=++id,timer=setTimeout(()=>{pending.delete(requestId);reject(Error(`Timed out: ${method}`));},10000);
    pending.set(requestId,result=>{clearTimeout(timer);pending.delete(requestId);resolve(result);});
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:requestId,method,params})+'\n');
  });
  return {send,notify:(method:string)=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',method})+'\n')};
}
const meta=(name?:string)=>({[PROTOCOL_VERSION_META_KEY]:'2026-07-28',[CLIENT_CAPABILITIES_META_KEY]:{},...(name?{[CLIENT_INFO_META_KEY]:{name,version:'fixture'}}:{})});
function result(reply:any){assert.equal(reply.error,undefined,JSON.stringify(reply.error));return JSON.parse(reply.result.content[0].text);}

for(const modern of [false,true])test(`${modern?'request envelope':'initialize'} detects Claude and blocks its own provider without any provider call`,async t=>{
  const b=await bridge(t);
  if(!modern){const init=await b.send('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'Claude Desktop',version:'fixture'}});assert.equal(init.error,undefined);b.notify('notifications/initialized');}
  const call=async(name:string,args:any={})=>result(await b.send('tools/call',{name,arguments:args,_meta:modern?meta('Claude Desktop'):{[LOG_LEVEL_META_KEY]:'info'}}));
  for(const tool of ['agent_status','agent_cli_status']){
    const status=await call(tool);assert.equal(status.host.host,'claude');assert.equal(status.providers.claude.callable,false);assert.equal(status.providers.claude.blocked_reason,'self_provider');
  }
  const maintenance=await call('agent_cli_update',{provider:'claude'});
  assert.equal(maintenance.host,'claude');assert.deepEqual(maintenance.updated,[]);assert.equal(maintenance.skipped[0].reason,'self_provider_update_blocked');
});
test('modern requests can change identity without initialize and missing identity fails closed',async t=>{
  const b=await bridge(t);
  for(const [name,expected] of [['Claude Desktop','claude'],['codex-mcp-client','codex'],['grok','grok'],[undefined,'unknown'],['local-agent-mode-agent','claude']] as const){
    const status=result(await b.send('tools/call',{name:'agent_status',arguments:{},_meta:meta(name)}));
    assert.equal(status.host.host,expected);
    if(expected==='unknown')for(const provider of Object.values(status.providers) as any[]){assert.equal(provider.callable,false);assert.equal(provider.blocked_reason,'host_unknown');}
    else assert.equal(status.providers[expected].blocked_reason,'self_provider');
  }
});
test('modern task preflight retains request identity and rejects blocked providers before job writes',async t=>{
  const b=await bridge(t),cwd=await fs.mkdtemp(path.join(os.tmpdir(),'host-routing-'));
  t.after(()=>fs.rm(cwd,{recursive:true,force:true}));
  const call=async(name:string,args:any)=>result(await b.send('tools/call',{name,arguments:args,_meta:meta('Claude Desktop')}));
  for(const tool of ['agent_ask','agent_review','agent_investigate','agent_implement']){
    const work=path.join(cwd,tool);await fs.mkdir(work);
    const started=await call(tool,{cwd:work,task:'No files may be changed. Verify self-provider is blocked.',provider:'claude',...(tool==='agent_implement'?{completion_criteria:'self provider blocked',workspace_mode:'current'}:{})});
    assert.equal(started.job_id,undefined);assert.match(started.error,/NO_CALLABLE_PROVIDER/);assert.match(started.error,/"host":"claude"/);assert.match(started.error,/self_provider/);
    assert.deepEqual(await fs.readdir(work),[]);
  }
});
