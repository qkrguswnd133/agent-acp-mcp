import test from 'node:test';
import assert from 'node:assert/strict';
import {selectModel} from '../src/health.js';
const model=(modelId:string,levels=['xhigh','high','low'])=>({modelId,_meta:{agentType:'grok-build-plan',supportsReasoningEffort:true,reasoningEfforts:levels.map(id=>({id}))}});
test('explicit per-call Grok selections never silently fall back',()=>{
 assert.throws(()=>selectModel([model('grok-5')],undefined,'grok-missing','high',{model:true}),/refusing fallback/);
 assert.throws(()=>selectModel([model('grok-5',['high'])],undefined,'grok-5','xhigh',{effort:true}),/refusing fallback/);
 assert.equal(selectModel([model('grok-5',['high'])],undefined,'auto','auto',{model:true,effort:true}).effort,'high');
});
test('prefer configured grok-4.6 and xhigh even with newer model',()=>{
 assert.deepEqual(selectModel([model('grok-4.6'),model('grok-5')],undefined,'grok-4.6'),{model:'grok-4.6',effort:'xhigh',notices:[]});
});
test('fallback selects newest advertised coding version and reports highest available effort',()=>{
 const result=selectModel([model('grok-4.5'),model('grok-5.2',['high','medium']),model('grok-5.10',['max','high'])],undefined,'grok-4.6');
 assert.equal(result.model,'grok-5.10');assert.equal(result.effort,'max');assert.equal(result.notices.length,2);
});
test('auto selects newest coding model and prefers ordinary model over same-version variants',()=>{
 const result=selectModel([model('grok-4.6'),model('grok-4.7-build-fast'),model('grok-4.7')],'grok-4.6','auto');
 assert.deepEqual(result,{model:'grok-4.7',effort:'xhigh',notices:[]});
});
test('do not pick models lacking coding or reasoning evidence or requiring API key',()=>{
 assert.throws(()=>selectModel([{modelId:'grok-6'}]));
 assert.throws(()=>selectModel([{...model('grok-5'),_meta:{...model('grok-5')._meta,apiKeyRequired:true}}]));
 assert.throws(()=>selectModel([model('grok-4.6',[])]));
});
