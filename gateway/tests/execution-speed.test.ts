import test from 'node:test';import assert from 'node:assert/strict';
import {speedPolicy,validateExecutionSpeed,codexSpeedArgs,claudeSpeedSettings,withExecutionSpeed,type CliAppliedSettings} from '../src/execution-speed.js';
import {codexCatalog,claudeCatalog,unavailableCatalog} from '../src/model-catalog.js';
import {validateCatalog,resolveProviderSettings} from '../src/model-settings.js';
import type {ProviderName} from '../src/types.js';
function env(provider:ProviderName,value:string|undefined,run:()=>void){const key=provider.toUpperCase()+'_SPEED',old=process.env[key];try{if(value===undefined)delete process.env[key];else process.env[key]=value;run();}finally{if(old===undefined)delete process.env[key];else process.env[key]=old;}}
test('all providers default to Standard independent of model/effort policy',()=>{
 for(const provider of ['codex','claude','grok'] as const)for(const value of [undefined,'','  '])env(provider,value,()=>{assert.equal(speedPolicy(provider).value,'standard');assert.equal(validateExecutionSpeed(provider,'any'), 'standard');});
 env('codex','Standard',()=>assert.equal(validateExecutionSpeed('codex','any'),'standard'));
 env('codex','auto',()=>assert.throws(()=>validateExecutionSpeed('codex','any'),/SPEED/));
});
test('Codex Standard explicitly clears inherited tier; Fast and Ultrafast remain separate from effort',()=>{
 assert.deepEqual(codexSpeedArgs('standard'),['-c','service_tier="standard"','-c','features.fast_mode=false']);
 assert.deepEqual(codexSpeedArgs('fast'),['-c','service_tier="fast"','-c','features.fast_mode=true']);
 assert.ok(codexSpeedArgs('ultrafast').includes('service_tier="ultrafast"'));
 const catalog=codexCatalog([{model:'m',serviceTiers:[{id:'priority'},{id:'ultrafast'}],supportedReasoningEfforts:[]}],'fixture');assert.deepEqual(catalog.models[0]!.speeds,['standard','fast','ultrafast']);
 env('codex','fast',()=>{assert.equal(validateExecutionSpeed('codex','m',catalog),'fast');assert.throws(()=>validateExecutionSpeed('codex','other',catalog),/does not advertise/);assert.throws(()=>validateExecutionSpeed('codex','m',unavailableCatalog('codex')),/does not advertise/);});
 env('codex','ultrafast',()=>assert.throws(()=>validateExecutionSpeed('codex','m',codexCatalog([{model:'m',serviceTiers:[{id:'priority'}]}],'fixture')),/ultrafast/));
});
test('Claude Standard defeats inherited fast settings; Fast requires positive model capability',()=>{
 const standard=claudeSpeedSettings('standard');assert.equal(standard.env.CLAUDE_CODE_DISABLE_FAST_MODE,'1');assert.deepEqual(JSON.parse(standard.args[1]!),{fastMode:false,env:{CLAUDE_CODE_DISABLE_FAST_MODE:'1'}});
 assert.equal(JSON.parse(claudeSpeedSettings('fast').args[1]!).fastMode,true);
 assert.throws(()=>claudeSpeedSettings('ultrafast'),/does not advertise/);
 const catalog=claudeCatalog({models:[{value:'opus',supportsFastMode:true},{value:'sonnet'},{value:'old',supportsFastMode:false}]},'fixture');
 env('claude','fast',()=>{assert.equal(validateExecutionSpeed('claude','opus',catalog),'fast');for(const model of ['sonnet','old','unknown'])assert.throws(()=>validateExecutionSpeed('claude',model,catalog),/does not advertise/);});
});
test('Grok unsupported speed is rejected and native default is not invented as observed speed',()=>{
 env('grok','fast',()=>assert.throws(()=>validateExecutionSpeed('grok','m'),/only GROK_SPEED=standard/));
 env('grok',undefined,()=>{const result=withExecutionSpeed({provider:'grok',text:'ok'}) as any;assert.equal(result.executionSpeed.requested,'standard');assert.equal(result.executionSpeed.observed,'unavailable');assert.equal(result.executionSpeed.verified,false);});
});
test('requested versus observed speed and cooldown are preserved without retry or task failure',()=>{
 env('claude','fast',()=>{
  const result=withExecutionSpeed({provider:'claude',text:'finished',speed:'standard',speedSource:'cli_result.usage.speed',error:null}) as any;
  assert.equal(result.text,'finished');assert.equal(result.error,null);assert.equal(result.executionSpeed.requested,'fast');assert.equal(result.executionSpeed.observed,'standard');assert.match(result.executionSpeed.warning,/not retried/);
  const unknown=withExecutionSpeed({provider:'claude',text:'finished',fastModeState:'cooldown'}) as any;assert.equal(unknown.executionSpeed.observed,'unavailable');assert.match(unknown.executionSpeed.warning,/cooldown/);
 });
});
test('catalog preflight rejects unsupported speed before provider execution',()=>{
 env('grok','fast',()=>assert.throws(()=>validateCatalog('grok',{model:'m',effort:'high'} as ReturnType<typeof resolveProviderSettings>,unavailableCatalog('grok')),/GROK_SPEED/));
});
const cliApplied:CliAppliedSettings={threadId:'task-thread',turnId:'task-turn',source:'app_server.thread/start',model:'fixture-model',effort:'high',serviceTierPresent:true,serviceTier:'priority',speed:'fast'};
test('Codex same-task CLI applied Fast is distinct from requested and backend-observed speed',()=>{
 env('codex','fast',()=>{
  const result=withExecutionSpeed({provider:'codex',sessionId:'task-thread',turnId:'task-turn',text:'finished',cliAppliedSettings:cliApplied}) as any;
  assert.equal(result.executionSpeed.requested,'fast');
  assert.equal(result.executionSpeed.effective,'fast');assert.equal(result.executionSpeed.effectiveSource,'app_server.thread/start');assert.equal(result.executionSpeed.effectiveVerified,true);
  assert.equal(result.executionSpeed.threadId,'task-thread');assert.equal(result.executionSpeed.turnId,'task-turn');assert.equal(result.executionSpeed.serviceTier,'priority');
  assert.equal(result.executionSpeed.observed,'unavailable');assert.equal(result.executionSpeed.verified,false);assert.equal(result.executionSpeed.observationSource,'unavailable');
  assert.match(result.executionSpeed.note,/does not confirm the backend service tier/);assert.equal(result.executionSpeed.warning,undefined);
 });
});
test('explicit Standard normalization requires a present null tier and normalized runner evidence',()=>{
 env('codex','standard',()=>{
  const result=withExecutionSpeed({provider:'codex',sessionId:'task-thread',turnId:'task-turn',text:'ok',cliAppliedSettings:{...cliApplied,serviceTier:null,speed:'standard'}}) as any;
  assert.equal(result.executionSpeed.effective,'standard');assert.equal(result.executionSpeed.effectiveVerified,true);assert.equal(result.executionSpeed.serviceTier,null);
  assert.equal(result.executionSpeed.observed,'unavailable');assert.equal(result.executionSpeed.verified,false);
  for(const applied of [{...cliApplied,serviceTier:null,speed:undefined},{...cliApplied,serviceTierPresent:false,serviceTier:null,speed:'standard'},{...cliApplied,serviceTier:undefined,speed:'standard'}]){
   const unknown=withExecutionSpeed({provider:'codex',sessionId:'task-thread',turnId:'task-turn',text:'ok',cliAppliedSettings:applied}) as any;
   assert.equal(unknown.executionSpeed.effective,'unavailable');assert.equal(unknown.executionSpeed.effectiveVerified,false);
  }
 });
});
test('missing or unrelated configuration cannot certify the current task speed',()=>{
 const {serviceTier:_tier,...missingTier}=cliApplied;
 const invalid=[undefined,{},missingTier,{...cliApplied,threadId:'status-query-thread'},{...cliApplied,turnId:'another-turn'},{...cliApplied,source:'app_server.config/read'},{...cliApplied,serviceTier:'new-tier'},{...cliApplied,serviceTier:null},{...cliApplied,speed:'standard'}];
 for(const applied of invalid){
  const result=withExecutionSpeed({provider:'codex',sessionId:'task-thread',turnId:'task-turn',text:'finished',cliAppliedSettings:applied}) as any;
  assert.equal(result.executionSpeed.effective,'unavailable');assert.equal(result.executionSpeed.effectiveSource,'unavailable');assert.equal(result.executionSpeed.effectiveVerified,false);assert.equal(result.executionSpeed.threadId,undefined);
 }
 const noSession=withExecutionSpeed({provider:'codex',text:'finished',cliAppliedSettings:cliApplied}) as any;assert.equal(noSession.executionSpeed.effective,'unavailable');
 const noTurn=withExecutionSpeed({provider:'codex',sessionId:'task-thread',text:'not started',cliAppliedSettings:cliApplied}) as any;assert.equal(noTurn.executionSpeed.effective,'unavailable');
});
test('CLI applied mismatch is reported without hiding partial results or retrying the task',()=>{
 env('codex','fast',()=>{
  const result=withExecutionSpeed({provider:'codex',sessionId:'task-thread',turnId:'task-turn',text:'partial work',error:'interrupted',usage:{total:123},cliAppliedSettings:{...cliApplied,serviceTier:null,speed:'standard'}}) as any;
  assert.equal(result.text,'partial work');assert.equal(result.error,'interrupted');assert.deepEqual(result.usage,{total:123});
  assert.equal(result.executionSpeed.effective,'standard');assert.match(result.executionSpeed.warning,/CLI thread applied standard/);assert.match(result.executionSpeed.warning,/not retried/);
 });
});
test('backend observations remain independent of CLI applied settings and their sources',()=>{
 env('codex','fast',()=>{
  const result=withExecutionSpeed({provider:'codex',sessionId:'task-thread',turnId:'task-turn',text:'finished',speed:'standard',speedSource:'fixture.backend',cliAppliedSettings:cliApplied}) as any;
  assert.equal(result.executionSpeed.effective,'fast');assert.equal(result.executionSpeed.effectiveVerified,true);
  assert.equal(result.executionSpeed.observed,'standard');assert.equal(result.executionSpeed.observationSource,'fixture.backend');assert.equal(result.executionSpeed.verified,true);assert.match(result.executionSpeed.warning,/provider reported standard/);
 });
 for(const source of ['app_server.thread/resume','app_server.thread/settings/updated'] as const){
  const result=withExecutionSpeed({provider:'codex',sessionId:'task-thread',turnId:'task-turn',text:'finished',cliAppliedSettings:{...cliApplied,source}}) as any;
  assert.equal(result.executionSpeed.effective,'fast');assert.equal(result.executionSpeed.effectiveSource,source);
 }
});
test('Claude and Grok retain observed semantics without accepting Codex CLI applied evidence',()=>{
 for(const provider of ['claude','grok'] as const){
  const result=withExecutionSpeed({provider,sessionId:'task-thread',turnId:'task-turn',text:'finished',speed:'fast',speedSource:'fixture.result',cliAppliedSettings:cliApplied}) as any;
  assert.equal(result.executionSpeed.observed,'fast');assert.equal(result.executionSpeed.verified,true);assert.equal(result.executionSpeed.observationSource,'fixture.result');
  assert.equal(result.executionSpeed.effective,'unavailable');assert.equal(result.executionSpeed.effectiveVerified,false);
 }
});
