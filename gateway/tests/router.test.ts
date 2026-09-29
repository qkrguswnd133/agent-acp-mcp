import test from 'node:test';
import assert from 'node:assert/strict';
import {AgentRouter,parseProviderSpec,randomNonEmptySubset} from '../src/router.js';
import {normalizeHost} from '../src/host.js';
import type {AgentKind,ProviderAdapter,ProviderName,ProviderStatus,RunInput} from '../src/types.js';

function adapter(name:ProviderName,overrides:Partial<ProviderStatus>={},calls?:Record<string,number>):ProviderAdapter{
 const base:ProviderStatus={provider:name,enabled:true,available:true,authenticated:true,subscriptionAuth:true,version:'1',modelPolicy:'auto',effortPolicy:'auto',quota:{state:'available',source:'test'}};
 return {name,
  async status(){if(calls)calls[name]=(calls[name]??0)+1;return {...base,...overrides,quota:overrides.quota??base.quota};},
  async run(_kind:AgentKind,_input:RunInput){return {provider:name,text:`${name}-ok`,error:null,errorKind:null};},
  async cliStatus(){return {...base,...overrides,quota:overrides.quota??base.quota};},async update(){return {provider:name,updated:true};}
 };
}
const host=(value:'codex'|'claude'|'grok'|'unknown')=>({host:value,clientName:value==='unknown'?'mystery':`${value}_desktop`});
test('auto provider options do not force routing or leak another provider model',async()=>{
 const observed:any[]=[];const grok=adapter('grok'),claude=adapter('claude');
 grok.run=async(_kind,input)=>{observed.push(input);return {provider:'grok',text:'ok'};};
 claude.run=async()=>{throw Error('Claude was not selected');};
 const r=new AgentRouter([grok,claude,adapter('codex')],{rng:()=>0});
 const result=await r.run('agent_ask',{cwd:process.cwd(),task:'fixture',provider:'auto',provider_options:{claude:{model:'opus',effort:'high'}}},host('codex'));
 assert.deepEqual(result.executed,['grok']);assert.equal(observed[0].model,undefined);
 await assert.rejects(()=>r.run('agent_ask',{cwd:process.cwd(),task:'fixture',provider:'auto',model:'opus'},host('codex')),/one explicit/);
});
test('persistent self-provider default applies when omitted and explicit false takes precedence',async()=>{
 const previous=process.env.ALLOW_SELF_PROVIDER;
 const router=new AgentRouter([adapter('grok'),adapter('claude'),adapter('codex')]);
 try{
  process.env.ALLOW_SELF_PROVIDER='true';
  const result=await router.run('agent_ask',{cwd:process.cwd(),task:'fixture',provider:'codex'},host('codex'));
  assert.deepEqual(result.executed,['codex']);assert.equal(result.self_provider_policy_source,'environment_default');
  assert.equal((await router.status(host('codex'))).providers.codex.callable,true);
  assert.equal((await router.status(host('codex'),false,false)).providers.codex.callable,false);
  await assert.rejects(()=>router.plan('codex',host('codex'),false,false),/self_provider/);
  const auto=await router.plan('auto',host('codex'));assert.ok(auto.eligible.includes('codex'));assert.equal(auto.allowSelf,true);
  assert.ok(!(await router.plan('auto',host('codex'),false,false)).eligible.includes('codex'));
  for(const value of ['false','invalid','']){process.env.ALLOW_SELF_PROVIDER=value;await assert.rejects(()=>router.plan('codex',host('codex')),/self_provider/);assert.deepEqual((await router.plan('codex',host('codex'),false,true)).selected,['codex']);}
  delete process.env.ALLOW_SELF_PROVIDER;await assert.rejects(()=>router.plan('codex',host('codex')),/self_provider/);
 }finally{if(previous===undefined)delete process.env.ALLOW_SELF_PROVIDER;else process.env.ALLOW_SELF_PROVIDER=previous;}
});
test('self-provider opt-in applies to auto and explicit selection for each host',async()=>{
 for(const name of ['grok','claude','codex'] as const){
  const router=new AgentRouter([adapter('grok'),adapter('claude'),adapter('codex')]);
  await assert.rejects(()=>router.plan(name,host(name)),/self_provider/);
  assert.deepEqual((await router.plan(name,host(name),false,true)).selected,[name]);
  const result=await router.run('agent_ask',{task:'fixture',cwd:process.cwd(),provider:name,allow_self_provider:true},host(name));
  assert.deepEqual(result.executed,[name]);assert.equal(result.selfProviderExecuted,true);
  assert.equal((await router.status(host(name))).providers[name].callable,false);
  assert.equal((await router.status(host(name),false,true)).providers[name].callable,true);
  assert.ok(!(await router.plan('auto',host(name))).selected.includes(name));
  assert.ok((await router.plan('auto',host(name),false,true)).eligible.includes(name));
  await assert.rejects(()=>router.plan(name,host('unknown'),false,true),/HOST_UNKNOWN/);
  assert.equal((await router.cliUpdate(name,host(name))).skipped[0].reason,'self_provider_update_blocked');
 }
});
test('self-provider opt-in never bypasses eligibility or explicit provider scope',async()=>{
 for(const overrides of [{enabled:false},{available:false},{authenticated:false},{subscriptionAuth:false},{quota:{state:'exhausted' as const,source:'fixture'}}]){
  const router=new AgentRouter([adapter('grok'),adapter('claude'),adapter('codex',overrides)]);
  await assert.rejects(()=>router.plan('codex',host('codex'),false,true),/NO_CALLABLE_PROVIDER/);
 }
 const router=new AgentRouter([adapter('grok'),adapter('claude'),adapter('codex')]);
 assert.deepEqual((await router.plan('claude',host('codex'),false,true)).selected,['claude']);
});
test('auto can execute an eligible self-provider but cannot bypass auth and quota',async()=>{
 const r=new AgentRouter([adapter('grok',{enabled:false}),adapter('claude',{enabled:false}),adapter('codex')],{rng:()=>0});
 const result=await r.run('agent_ask',{cwd:process.cwd(),task:'fixture',provider:'auto',allow_self_provider:true},host('codex'));
 assert.deepEqual(result.executed,['codex']);assert.equal(result.selfProviderExecuted,true);
 await assert.rejects(()=>r.plan('auto',host('codex'),false,false),/NO_CALLABLE_PROVIDER/);
 for(const overrides of [{authenticated:false},{quota:{state:'exhausted' as const,source:'fixture'}}]){
  const blocked=new AgentRouter([adapter('grok',{enabled:false}),adapter('claude',{enabled:false}),adapter('codex',overrides)]);
  await assert.rejects(()=>blocked.plan('auto',host('codex'),false,true),/NO_CALLABLE_PROVIDER/);
 }
});
test('auto read-only retry preserves opt-in when rechecking an unexecuted self-provider',async()=>{
 const grok=adapter('grok');grok.run=async()=>({provider:'grok',text:'',error:'usage limit',errorKind:'quota_exhausted'});
 const calls:Record<string,number>={};const r=new AgentRouter([grok,adapter('claude',{enabled:false}),adapter('codex',{},calls)],{rng:()=>0});
 const result=await r.run('agent_ask',{cwd:process.cwd(),task:'fixture',provider:'auto',allow_self_provider:true},host('codex'));
 assert.deepEqual(result.executed,['grok','codex']);assert.equal(result.retryCount,1);assert.equal(calls.codex,2);
});
test('router separates provider turn success from acceptance and command evidence',async()=>{
 const grok=adapter('grok');grok.run=async()=>({provider:'grok',text:'done',error:null,exitCode:1,commandExecutions:[{exitCode:1},{exitCode:0}]});
 const router=new AgentRouter([grok,adapter('claude'),adapter('codex')]);
 const result=await router.run('agent_implement',{cwd:process.cwd(),task:'fixture',provider:'grok'},host('codex'));
 assert.equal(result.outcome,'success');assert.equal(result.outcomeMeaning,'provider_turn_execution_only');assert.equal(result.completionCriteria.status,'unverified');
 const execution=result.results[0].execution as any;assert.equal(execution.turnStatus,'completed');assert.equal(execution.commands.status,'mixed');assert.equal(result.results[0].exitCode,1);
});

test('host normalization handles desktop/CLI style client names',()=>{
 assert.equal(normalizeHost('codex_vscode'),'codex');assert.equal(normalizeHost('Claude Desktop'),'claude');assert.equal(normalizeHost('grok-acp-client'),'grok');assert.equal(normalizeHost('other'),'unknown');
});

test('verified tokenless client names resolve, unverified ones still fail closed',()=>{
 // Observed identities: Claude Code local agent mode carries no provider token,
 // Codex CLI carries one in both name and title.
 assert.equal(normalizeHost('local-agent-mode-agent'),'claude');
 assert.equal(normalizeHost('Local-Agent-Mode-Agent'),'claude');
 assert.equal(normalizeHost('codex-mcp-client','Codex'),'codex');
 // Anything generic that has not been verified must stay unknown so the router
 // refuses to route rather than guessing which provider is self.
 assert.equal(normalizeHost('agent-mode'),'unknown');
 assert.equal(normalizeHost('local-agent'),'unknown');
 assert.equal(normalizeHost('some-other-agent','Agent'),'unknown');
});

test('provider syntax is auto or explicit comma-separated providers only',()=>{
 assert.deepEqual(parseProviderSpec('auto'),{mode:'auto',requested:[]});
 assert.deepEqual(parseProviderSpec(' grok, claude,grok '),{mode:'explicit',requested:['grok','claude']});
 assert.throws(()=>parseProviderSpec('auto,grok'),/cannot be combined/);assert.throws(()=>parseProviderSpec('gemini'),/Unknown provider/);
});

test('auto random subset is always non-empty and may contain multiple providers',()=>{
 assert.deepEqual(randomNonEmptySubset(['grok','claude'],()=>0.99),['grok','claude']);
 assert.equal(randomNonEmptySubset(['grok','claude','codex'],()=>0).length,1);
});

test('auto excludes current host and exhausted providers before random selection',async()=>{
 const r=new AgentRouter([adapter('grok'),adapter('claude',{quota:{state:'exhausted',source:'test'}}),adapter('codex')]);
 const plan=await r.plan('auto',host('codex'));
 assert.deepEqual(plan.eligible,['grok']);assert.deepEqual(plan.selected,['grok']);
 assert.ok(plan.skipped.some(x=>x.provider==='codex'&&x.reason==='self_provider'));
 assert.ok(plan.skipped.some(x=>x.provider==='claude'&&x.reason==='quota_exhausted'));
});

test('explicit routing only probes requested non-self providers and never substitutes another provider',async()=>{
 const calls:Record<string,number>={};const r=new AgentRouter([adapter('grok',{},calls),adapter('claude',{},calls),adapter('codex',{},calls)]);
 const plan=await r.plan('grok,codex',host('codex'));
 assert.deepEqual(plan.selected,['grok']);assert.equal(calls.grok,1);assert.equal(calls.claude??0,0);assert.equal(calls.codex??0,0);
 assert.ok(plan.skipped.some(x=>x.provider==='codex'&&x.reason==='self_provider'));
});

test('unknown host blocks routed work because self exclusion cannot be guaranteed',async()=>{
 const r=new AgentRouter([adapter('grok'),adapter('claude'),adapter('codex')]);
 await assert.rejects(()=>r.plan('auto',host('unknown')),/HOST_UNKNOWN/);
});

test('explicit multi-provider run executes requested callable providers',async()=>{
 const r=new AgentRouter([adapter('grok'),adapter('claude'),adapter('codex')]);
 const result=await r.run('agent_ask',{task:'x',cwd:process.cwd(),provider:'grok,claude'},host('codex'));
 assert.deepEqual(result.selected,['grok','claude']);assert.equal(result.successCount,2);assert.equal(result.error,null);
});
test('one provider exception preserves the other provider result',async()=>{
 const broken=adapter('grok');broken.run=async()=>{throw Error('connection closed');};
 const r=new AgentRouter([broken,adapter('claude'),adapter('codex')]);
 const result=await r.run('agent_ask',{task:'x',cwd:process.cwd(),provider:'grok,claude'},host('codex'));
 assert.equal(result.successCount,1);assert.equal(result.failureCount,1);
 assert.equal(result.results[0].error,'connection closed');assert.equal(result.results[1].text,'claude-ok');
});
test('unknown authentication is blocked while unknown quota alone remains eligible',async()=>{
 const r=new AgentRouter([adapter('grok',{authenticated:'unknown'}),adapter('claude',{quota:{state:'unknown',source:'test'}}),adapter('codex')]);
 const plan=await r.plan('grok,claude',host('codex'));
 assert.deepEqual(plan.selected,['claude']);assert.deepEqual(plan.skipped,[{provider:'grok',reason:'auth_unknown'}]);
 const s=new AgentRouter([adapter('grok',{subscriptionAuth:'unknown'}),adapter('claude'),adapter('codex')]);
 assert.deepEqual((await s.plan('grok,claude',host('codex'))).skipped,[{provider:'grok',reason:'subscription_auth_unknown'}]);
});
