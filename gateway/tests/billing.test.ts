import test from 'node:test';
import assert from 'node:assert/strict';
import {BillingReader,normalizeBilling,forDelta} from '../src/billing.js';
const time=Date.parse('2026-09-18T00:00:00Z');
const payload=(percent:any=33)=>({subscriptionTier:'SuperGrok Plus',config:{creditUsagePercent:percent,currentPeriod:{type:'USAGE_PERIOD_TYPE_WEEKLY',start:'2026-09-15T00:00:00Z',end:'2026-09-22T00:00:00Z'}}});
test('live billing validates numbers, preserves zero and missing fields without guessing',()=>{
 assert.equal(normalizeBilling(payload(0),time).remainingPercent,100);
 for(const v of [undefined,null,'26',101,-1])assert.equal(normalizeBilling(payload(v===undefined?null:v),time).creditUsagePercent,'unavailable');
 assert.throws(()=>normalizeBilling({},time));
 const snake={...payload(),subscriptionTier:undefined,subscription_tier:'SuperGrok Plus'};assert.equal(normalizeBilling(snake,time).subscriptionTier,'SuperGrok Plus');
});
test('cache expires, explicit refresh bypasses cache, concurrent requests share one fetch',async()=>{
 let now=time,calls=0;const r=new BillingReader(async()=>{calls++;return payload();},async()=> 'unavailable',()=>now);
 const values=await Promise.all([r.read(),r.read(true),r.read()]);assert.equal(calls,1);assert.ok(values.every(v=>v.source==='acp_billing'));
 assert.equal((await r.read()).source,'acp_cache');assert.equal(calls,1);
 await r.read(true);assert.equal(calls,2);now+=60001;await r.read();assert.equal(calls,3);
});
test('refresh failure returns stale log, throttles retries, never leaks raw error or yields delta',async()=>{
 let now=time,calls=0;const log=normalizeBilling(payload(26),time-1000);
 const r=new BillingReader(async()=>{calls++;throw Error('SECRET');},async()=>log,()=>now);
 const value=await r.read();assert.equal(value.source,'log_fallback');assert.equal(value.fresh,false);assert.equal(value.stale,true);assert.ok(!JSON.stringify(value).includes('SECRET'));
 await r.read(true);assert.equal(calls,1);now+=30001;await r.read();assert.equal(calls,2);
 const deltaValue=forDelta(value);assert.equal(deltaValue==='unavailable'?false:deltaValue.fresh,false);
});
test('billing and log failures are unavailable instead of task exceptions',async()=>{
 const r=new BillingReader(async()=>{throw Error('offline');},async()=>{throw Error('file missing');});
 const result=await r.read();assert.equal(result.status,'unavailable');assert.equal(forDelta(result),'unavailable');
});
test('expired period is never served as fresh cached billing',async()=>{
 let now=Date.parse('2026-09-21T23:59:59Z'),calls=0;
 const r=new BillingReader(async()=>{calls++;return payload();},async()=> 'unavailable',()=>now);
 await r.read();now+=2000;const result=await r.read();assert.equal(calls,2);assert.equal(result.fresh,false);
});


