import './isolated-environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AgentRouter} from '../src/router.js';
import {JobManager} from '../src/jobs.js';
import {CatalogCache,codexCatalog,catalog,unavailableCatalog} from '../src/model-catalog.js';
import type {ProviderAdapter,ProviderName,RunInput} from '../src/types.js';
const host={host:'codex' as const,clientName:'codex'};
const input:RunInput={task:'fixture',cwd:process.cwd(),provider:'auto',provider_options:{grok:{model:'known',effort:'high',selection_reason:'fit'},claude:{model:'known',effort:'high',selection_reason:'fit'}}};
async function automatic(run:()=>Promise<void>){const keys=['GROK_MODEL','GROK_EFFORT','CLAUDE_MODEL','CLAUDE_EFFORT','CODEX_MODEL','CODEX_EFFORT'];const old=keys.map(k=>process.env[k]);try{keys.forEach(k=>process.env[k]='auto');await run();}finally{keys.forEach((k,i)=>{if(old[i]===undefined)delete process.env[k];else process.env[k]=old[i];});}}
function adapter(name:ProviderName,calls:string[],models:ProviderAdapter['models']=async()=>catalog(name,'fixture','1',[{id:'known',efforts:['high'],effortsAuthoritative:true}],true)):ProviderAdapter{
 const status={provider:name,enabled:true,available:true,authenticated:true as const,subscriptionAuth:true as const,version:'1',modelPolicy:'auto',effortPolicy:'auto',quota:{state:'available' as const,source:'fixture'}};
 return {name,status:async()=>status,cliStatus:async()=>status,update:async()=>{},models,run:async()=>{calls.push(name);return {provider:name,text:'ok',model:'runtime-model',modelSource:'cli_json',usage:{totalTokens:3}};}};
}
test('all explicit providers and auto retry candidates validate before any provider writes',()=>automatic(async()=>{
 for(const provider of ['auto','grok,claude']){
  const calls:string[]=[];const router=new AgentRouter([adapter('grok',calls),adapter('claude',calls),adapter('codex',calls)],{rng:()=>0});
  await assert.rejects(router.run('agent_implement',{...input,provider,provider_options:{grok:input.provider_options!.grok}},host),/MODEL_SELECTION_REQUIRED/);assert.deepEqual(calls,[]);
  await assert.rejects(router.run('agent_ask',{...input,provider,provider_options:{...input.provider_options,claude:{model:'missing',effort:'high',selection_reason:'fit'}}},host),/UNSUPPORTED_MODEL_OR_EFFORT/);assert.deepEqual(calls,[]);
 }
}));
test('catalog failure stays unverified; selection and runtime observation survive partial result and cancellation',()=>automatic(async()=>{
 const calls:string[]=[];const grok=adapter('grok',calls,async()=>{throw Error('offline');});
 grok.run=async()=>({provider:'grok',text:'partial',error:'cancelled',errorKind:'cancelled',sessionId:'session',usage:{totalTokens:4}});
 const router=new AgentRouter([grok,adapter('claude',calls),adapter('codex',calls)],{rng:()=>0});
 const result=await router.run('agent_implement',input,host);assert.equal(result.errorKind,'cancelled');
 assert.equal(result.results[0].selection?.model.value,'known');assert.equal(result.results[0].observation?.model.verified,false);assert.deepEqual(result.results[0].usage,{totalTokens:4});assert.equal(result.results[0].handoff?.sessionId,'session');
 const status=await router.status(host);assert.equal(status.providers.grok.modelCatalog.status,'unavailable');assert.match(status.providers.grok.modelCatalog.note,/offline/);
 const models=await router.models('grok,claude');assert.equal(models.providers.grok.modelPolicy,'auto');assert.equal(models.providers.grok.catalog.modelsAuthoritative,false);
 await assert.rejects(router.models('auto'),/explicit provider/);
}));
test('model errors never trigger automatic provider fallback',()=>automatic(async()=>{
 const calls:string[]=[];const grok=adapter('grok',calls);grok.run=async()=>{calls.push('grok');return {provider:'grok',text:'',error:'bad model',errorKind:'UNSUPPORTED_MODEL_OR_EFFORT'};};
 const router=new AgentRouter([grok,adapter('claude',calls),adapter('codex',calls)],{rng:()=>0});
 const result=await router.run('agent_ask',input,host);assert.deepEqual(calls,['grok']);assert.equal(result.retryCount,0);assert.equal(result.results[0].selection?.effort.reason,'fit');
}));
test('catalog caches successes and explicit unavailable results; force refresh replaces version',async()=>{
 const cache=new CatalogCache();let calls=0;
 const load=async()=>{calls++;return calls===1?unavailableCatalog('codex','offline','v1'):codexCatalog([{model:'known',supportedReasoningEfforts:[{reasoningEffort:'high'}]}],'v2');};
 assert.equal((await cache.get('launcher',load)).status,'unavailable');await cache.get('launcher',load);assert.equal(calls,1);
 assert.equal((await cache.get('launcher',load,true)).version,'v2');assert.equal(calls,2);
});
test('job preflight rejects before worktree/job writes and shutdown is rechecked after awaited preflight',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'model-preflight-'));const storage=path.join(root,'jobs');const manager=new JobManager(storage,async()=>({}));
 try{
  manager.setPreflight(async()=>{throw Error('MODEL_SELECTION_REQUIRED');});
  await assert.rejects(manager.start('agent_implement',{task:'fixture',cwd:root,workspace_mode:'isolated'}),/MODEL_SELECTION_REQUIRED/);assert.deepEqual(await fs.readdir(root),[]);
  let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r);
  manager.setPreflight(async()=>{entered();await wait;});const starting=manager.start('agent_ask',{task:'fixture',cwd:root});await ready;const closing=manager.close();release();await assert.rejects(starting,/shutting down/);await closing;assert.deepEqual(await fs.readdir(root),[]);
 }finally{await manager.close();await fs.rm(root,{recursive:true,force:true});}
});
