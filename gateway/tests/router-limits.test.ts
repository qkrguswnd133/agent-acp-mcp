import {selectedInput} from './selection-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AgentRouter} from '../src/router.js';
import type {ProviderAdapter,ProviderName,ProviderStatus,ProviderRunResult,RunInput} from '../src/types.js';
const host={host:'codex' as const,clientName:'codex-mcp-client'};
const input={cwd:process.cwd(),task:'fixture',provider:'auto',max_runtime_minutes:1};
test('successful unknown cleanup is a warning for every provider and requests parent review without failing the turn',async()=>{
 for(const provider of ['grok','claude','codex'] as const){
  const first=adapter(provider,async()=>({provider,text:'complete',error:null,usage:{totalTokens:7},childCleanedUp:false,processCleanup:{verified:false,trackedPids:[1234],remainingPids:[]}}));
  const r=await new AgentRouter([first]).run('agent_implement',selectedInput({...input,provider,allow_self_provider:true}),host);
  assert.equal(r.error,null);assert.equal(r.outcome,'success');assert.equal(r.successCount,1);assert.equal(r.failureCount,0);assert.equal(r.results[0].processCleanupState,'unverified');assert.match(r.results[0].processCleanupWarning!,/no remaining process/);assert.equal(r.handoff?.requiresWorkspaceReview,true);
 }
});
test('unknown cleanup stops later implementation with an explicit review skip, preserving the successful provider result',async()=>{
 let calls=0;const grok=adapter('grok',async()=>({provider:'grok',text:'complete',error:null,childCleanedUp:false,processCleanup:{verified:false,remainingPids:[]}}));
 const claude=adapter('claude',async()=>{calls++;return {provider:'claude',text:'must not run'};});
 const r=await new AgentRouter([grok,claude]).run('agent_implement',selectedInput({...input,provider:'grok,claude'}),host);
 assert.equal(calls,0);assert.equal(r.results[0].error,null);assert.equal(r.successCount,1);assert.equal(r.failureCount,0);assert.equal(r.outcome,'partial_success');assert.equal(r.errorKind,'process_cleanup_review_required');assert.match(r.error!,/providers were skipped/);assert.doesNotMatch(r.error!,/NO_PROVIDER_RESULT/);assert.equal(r.skipped[0].reason,'process_cleanup_review_required');
});

test('completed turn with unconfirmed children stops later implementation and preserves evidence',async()=>{
 let second=0;
 const first=adapter('grok',async()=>({provider:'grok',text:'finished code',error:null,childCleanedUp:false,processCleanup:{verified:false,remainingPids:[1234]},usage:{totalTokens:7}}));
 const next=adapter('claude',async()=>{second++;return {provider:'claude',text:'must not run'};});
 const r=await new AgentRouter([first,next]).run('agent_implement',selectedInput({...input,provider:'grok,claude'}),host);
 assert.equal(second,0);assert.equal(r.errorKind,'process_cleanup_review_required');assert.equal(r.handoff?.requiresWorkspaceReview,true);assert.equal(r.results[0].error,null);assert.equal(r.successCount,1);
 assert.equal(r.results[0].text,'finished code');assert.deepEqual(r.results[0].usage,{totalTokens:7});assert.deepEqual(r.results[0].processCleanup,{verified:false,remainingPids:[1234]});
});
test('a successful single provider with unknown remaining workspace use stays successful and requests review',async()=>{
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'gateway-remaining-result-'));
 try{
  const provider=adapter('grok',async()=>({provider:'grok',text:'committed and tested',error:null,processCleanup:{verified:false,remainingPids:[1900000000]}}));
  const result=await new AgentRouter([provider]).run('agent_implement',selectedInput({...input,cwd,provider:'grok'}),host);
  assert.equal(result.outcome,'success');assert.equal(result.error,null);assert.equal(result.failureCount,0);assert.equal(result.handoff?.requiresWorkspaceReview,true);assert.match(result.results[0].processCleanupWarning!,/unknown/);
 }finally{await fs.rm(cwd,{recursive:true,force:true});}
});
const limit=(provider:ProviderName,kind='quota_exhausted'):ProviderRunResult=>({provider,text:'partial',error:'limited',errorKind:kind,sessionId:'fixture-session',usage:{totalTokens:10}});
function adapter(name:ProviderName,run:ProviderAdapter['run'],status?:(force?:boolean)=>Partial<ProviderStatus>):ProviderAdapter{
 const value:ProviderStatus={provider:name,enabled:true,available:true,authenticated:true,subscriptionAuth:true,version:'fixture',modelPolicy:'auto',effortPolicy:'auto',quota:{state:'available',source:'fixture'}};
 return {name,run,async status(force){return {...value,...status?.(force)};},async cliStatus(){return value;},async update(){throw Error('No update');}};
}
test('implementation keeps partial edit and never launches the next provider or auto retry',async()=>{
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'gateway-partial-'));const file=path.join(cwd,'changed.txt');let second=0;
 try{
  const grok=adapter('grok',async()=>{await fs.writeFile(file,'partial edit');return limit('grok');});
  const claude=adapter('claude',async()=>{second++;return {provider:'claude',text:'unexpected'};});
  for(const provider of ['grok,claude','auto']){
   const r=await new AgentRouter([grok,claude],{rng:()=>0.99}).run('agent_implement',selectedInput({...input,cwd,provider,allowed_paths:[file]}),host);
   assert.equal(second,0);assert.equal(r.retryCount,0);assert.deepEqual(r.executed,['grok']);
   assert.equal(r.handoff?.requiresWorkspaceReview,true);assert.deepEqual(r.handoff?.allowedPaths,[file]);
   assert.equal(r.results[0].text,'partial');assert.deepEqual(r.results[0].usage,{totalTokens:10});
   assert.ok(r.skipped.some(s=>s.provider==='claude'&&s.reason==='partial_work_review_required'));
   assert.equal(await fs.readFile(file,'utf8'),'partial edit');
  }
 }finally{await fs.unlink(file);await fs.rmdir(cwd);}
});
test('read-only auto rechecks candidate and retries once with shared remaining time',async()=>{
 let clock=10000,refreshes=0;const budgets:number[]=[],deadlines:number[]=[];
 const grok=adapter('grok',async(_k,i)=>{budgets.push(i.max_runtime_minutes!);deadlines.push(i.deadlineAt!);clock+=20000;return limit('grok','rate_limited');});
 const claude=adapter('claude',async(_k,i)=>{budgets.push(i.max_runtime_minutes!);deadlines.push(i.deadlineAt!);return limit('claude');},force=>{if(force){refreshes++;clock+=5000;}return {};});
 const r=await new AgentRouter([grok,claude],{rng:()=>0,now:()=>clock}).run('agent_ask',selectedInput(input),host);
 assert.equal(refreshes,1);assert.equal(r.retryCount,1);assert.deepEqual(r.executed,['grok','claude']);
 assert.deepEqual(deadlines,[70000,70000]);assert.equal(budgets[1],35000/60000);assert.equal(r.failureCount,2);
});
test('newly exhausted retry candidate is skipped after fresh status',async()=>{
 let called=0;const grok=adapter('grok',async()=>limit('grok'));
 const claude=adapter('claude',async()=>{called++;return limit('claude');},force=>force?{quota:{state:'exhausted',source:'fixture'}}:{});
 const r=await new AgentRouter([grok,claude],{rng:()=>0}).run('agent_review',selectedInput(input),host);
 assert.equal(called,0);assert.equal(r.retryCount,0);assert.ok(r.skipped.some(s=>s.provider==='claude'&&s.reason==='quota_exhausted'));
});
test('explicit provider never gains a replacement; context errors do not trigger fallback',async()=>{
 let calls=0;const claude=adapter('claude',async()=>{calls++;return limit('claude');});
 const r=new AgentRouter([adapter('grok',async()=>limit('grok')),claude],{rng:()=>0});
 assert.equal((await r.run('agent_ask',selectedInput({...input,provider:'grok'}),host)).retryCount,0);
 const q=new AgentRouter([adapter('grok',async()=>limit('grok','context_limit')),claude],{rng:()=>0});
 assert.equal((await q.run('agent_ask',selectedInput(input),host)).retryCount,0);assert.equal(calls,0);
});
test('cancellation and deadline exhaustion prevent fallback and preserve original partial data',async()=>{
 for(const mode of ['cancel','deadline']){
  const c=new AbortController();let clock=10000,calls=0;
  const grok=adapter('grok',async()=>{if(mode==='cancel')c.abort();else clock+=61000;return limit('grok');});
  const claude=adapter('claude',async()=>{calls++;return limit('claude');});
  const r=await new AgentRouter([grok,claude],{rng:()=>0,now:()=>clock}).run('agent_ask',selectedInput(input),host,c.signal);
  assert.equal(calls,0);assert.equal(r.errorKind,mode==='cancel'?'cancelled':'deadline_exceeded');assert.equal(r.results[0].text,'partial');
  assert.equal(r.results[0].providerError,'limited');assert.equal(r.results[0].providerErrorKind,'quota_exhausted');
 }
});
test('deadline expiring during refreshed candidate status prevents its launch',async()=>{
 let clock=10000,calls=0;
 const r=await new AgentRouter([
  adapter('grok',async()=>limit('grok')),
  adapter('claude',async()=>{calls++;return limit('claude');},force=>{if(force)clock+=61000;return {};})
 ],{rng:()=>0,now:()=>clock}).run('agent_ask',selectedInput(input),host);
 assert.equal(calls,0);assert.equal(r.errorKind,'deadline_exceeded');assert.equal(r.retryCount,0);
});
test('partial success retains failure and blocks self provider in explicit routing',async()=>{
 let selfCalls=0;
 const r=await new AgentRouter([
  adapter('grok',async()=>limit('grok')),
  adapter('claude',async()=>({provider:'claude',text:'success',error:null})),
  adapter('codex',async()=>{selfCalls++;return limit('codex');})
 ]).run('agent_ask',selectedInput({...input,provider:'grok,claude,codex'}),host);
 assert.equal(selfCalls,0);assert.equal(r.outcome,'partial_success');assert.equal(r.successCount,1);assert.equal(r.failureCount,1);assert.ok(r.error);
 assert.ok(r.skipped.some(s=>s.provider==='codex'&&s.reason==='self_provider'));
});
test('actual shared deadline aborts an active provider without granting extra retry time',async()=>{
 let second=0,aborted=false;
 const grok=adapter('grok',async(_k,_i,signal)=>new Promise(resolve=>{
  signal!.addEventListener('abort',()=>{aborted=true;resolve({...limit('grok'),errorKind:'cancelled'});},{once:true});
 }));
 const claude=adapter('claude',async()=>{second++;return limit('claude');});
 const r=await new AgentRouter([grok,claude],{rng:()=>0}).run('agent_ask',selectedInput({...input,max_runtime_minutes:0.001}),host);
 assert.equal(aborted,true);assert.equal(second,0);assert.equal(r.errorKind,'deadline_exceeded');assert.equal(r.results[0].sessionId,'fixture-session');
});
