import test from 'node:test';import assert from 'node:assert/strict';
import {speedPolicy,validateExecutionSpeed,codexSpeedArgs,claudeSpeedSettings,withExecutionSpeed} from '../src/execution-speed.js';
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
