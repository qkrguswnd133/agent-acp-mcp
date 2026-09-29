import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createUpdateFlow}=require('../ui/update-flow.js');
const verified={phase:'downloaded',downloaded:true,blocked:null,error:null};

test('one update action downloads, rechecks, then installs exactly once',async()=>{
  const calls=[],busy=[];const api={updateDownload:async()=>{calls.push('download');return verified;},updateState:async()=>{calls.push('state');return verified;},updateInstall:async()=>{calls.push('install');return {started:true};},updateCancel:()=>calls.push('cancel')};
  const flow=createUpdateFlow(api,{onBusy:value=>busy.push(value)});
  assert.deepEqual(await flow.run(),{started:true});assert.deepEqual(calls,['download','state','install']);assert.deepEqual(busy,[true,false]);assert.equal(flow.isBusy(),false);
});
test('duplicate click and cancellation before install never launch a second helper',async()=>{
  let releaseState;const calls=[];const api={updateDownload:async()=>{calls.push('download');return verified;},updateState:()=>new Promise(resolve=>{releaseState=resolve;}),updateInstall:async()=>{calls.push('install');return {started:true};},updateCancel:()=>calls.push('cancel')};
  const flow=createUpdateFlow(api),first=flow.run();await Promise.resolve();assert.equal((await flow.run()).reason,'busy');flow.cancel();releaseState(verified);
  assert.equal((await first).reason,'cancelled');assert.deepEqual(calls,['download','cancel']);
});
test('failed verification and IPC errors leave install untouched',async()=>{
  let installs=0;const errors=[];const failed={phase:'idle',downloaded:false,error:'hash mismatch'};
  const api={updateDownload:async()=>failed,updateState:async()=>failed,updateInstall:async()=>{installs++;return {started:true};},updateCancel:()=>{}};
  const flow=createUpdateFlow(api,{onError:error=>errors.push(error.message)});assert.equal((await flow.run()).reason,'download_not_verified');assert.equal(installs,0);
  api.updateDownload=async()=>{throw Error('IPC disconnected');};assert.equal((await flow.run()).reason,'request_failed');assert.deepEqual(errors,['IPC disconnected']);assert.equal(installs,0);
});
