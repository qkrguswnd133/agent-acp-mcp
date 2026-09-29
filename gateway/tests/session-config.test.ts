import test from 'node:test';
import assert from 'node:assert/strict';
import {confirmSessionConfig} from '../src/session-config.js';
import {quotaFromWeekly} from '../src/providers/grok.js';
const config=(model:string,effort:string)=>[
 {id:'model',type:'select',currentValue:model},
 {id:'reasoning_effort',type:'select',currentValue:effort},
];
test('server defaults are reconciled and effort is rechecked after model update',async()=>{
 const calls:string[]=[];
 await confirmSessionConfig(config('grok-4.7','xhigh'),'grok-4.6','xhigh',async(id,value)=>{
   calls.push(`${id}:${value}`);
   return {configOptions:config('grok-4.6',id==='model'?'high':value)};
 });
 assert.deepEqual(calls,['model:grok-4.6','reasoning_effort:xhigh']);
});
test('already confirmed config does not need a setter',async()=>{
 await confirmSessionConfig(config('grok-4.7','xhigh'),'grok-4.7','xhigh',async()=>{throw Error('unexpected setter');});
});
test('unconfirmed config fails before a prompt can be sent',async()=>{
 await assert.rejects(confirmSessionConfig(config('grok-4.7','high'),'grok-4.6','xhigh',async()=>({configOptions:config('grok-4.7','high')})),/refusing prompt/);
});
test('stale quota is unknown even when last-known usage was exhausted',()=>{
 assert.equal(quotaFromWeekly({status:'available',creditUsagePercent:100,remainingPercent:0,stale:true}).state,'unknown');
 assert.equal(quotaFromWeekly({status:'available',creditUsagePercent:'unavailable'}).state,'unknown');
 assert.equal(quotaFromWeekly({status:'available',creditUsagePercent:100,remainingPercent:0,fresh:true,stale:false}).state,'exhausted');
 assert.equal(quotaFromWeekly({status:'available',creditUsagePercent:10,remainingPercent:90,fresh:true,stale:false}).state,'available');
});
