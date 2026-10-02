import test from 'node:test';
import assert from 'node:assert/strict';
import {grokCatalog,claudeCatalog,codexCatalog} from '../src/model-catalog.js';
import {resolveProviderSettings,validateCatalog} from '../src/model-settings.js';
const model=(modelId:string,levels=['xhigh','high','low'])=>({modelId,_meta:{supportsReasoningEffort:true,reasoningEfforts:levels.map(id=>({id}))}});
test('Grok model state preserves advertised choices without selecting newest or falling back',()=>{
 const value=grokCatalog({availableModels:[model('grok-4.6'),model('grok-5',['high'])]},'fixture');
 assert.deepEqual(value.models.map(m=>m.id),['grok-4.6','grok-5']);assert.equal(value.modelsAuthoritative,true);
 const settings={model:'grok-missing',effort:'high',modelSource:'parent' as const,effortSource:'parent' as const,selection:{model:{value:'grok-missing',source:'parent' as const},effort:{value:'high',source:'parent' as const}}};
 assert.throws(()=>validateCatalog('grok',settings,value),/UNSUPPORTED_MODEL_OR_EFFORT/);
 assert.throws(()=>validateCatalog('grok',{...settings,model:'grok-5',effort:'xhigh'},value),/UNSUPPORTED_MODEL_OR_EFFORT/);
});
test('Grok filters models requiring API keys and associates config effort options only with current model',()=>{
 const value=grokCatalog({availableModels:[{modelId:'coding'},{modelId:'other'},{modelId:'paid',_meta:{apiKeyRequired:true}}],currentModelId:'coding'},'fixture',[{id:'reasoning_effort',type:'select',options:[{value:'high'}]}]);
 assert.deepEqual(value.models.map(m=>m.id),['coding','other']);assert.equal(value.models[0].effortsAuthoritative,true);assert.equal(value.models[1].effortsAuthoritative,false);
});
test('unavailable catalogs and partial effort lists never invent support',()=>{
 assert.equal(grokCatalog(undefined,'fixture').modelsAuthoritative,false);
 assert.equal(codexCatalog([],'fixture').status,'unavailable');
 const c=claudeCatalog({models:[{value:'default'},{value:'opus',supportedEffortLevels:['high']}]},'fixture');
 assert.equal(c.modelsAuthoritative,false);assert.equal(c.status,'partial');assert.deepEqual(c.models.map(m=>m.id),['opus']);assert.deepEqual(c.models[0].efforts,['high']);
});
