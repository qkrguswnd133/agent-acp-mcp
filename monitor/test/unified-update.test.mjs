import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';
const {createUnifiedUpdates}=createRequire(import.meta.url)('../update/unified.cjs');
function fixture(t,{targets=[{id:'Ubuntu',name:'Ubuntu',installed:true,version:'2.7.0',latestVersion:'2.7.1',canUpdate:true}],winVersion='2.7.0',distroStatus='available',winReady=true,wslReady=true,wslResult={status:'installed',version:'2.7.1'},winResult={started:true,operationId:'windows-op'}}={}){
 const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'unified-update-'));t.after(()=>fs.rmSync(stateDir,{recursive:true,force:true}));const calls=[],events=[];
 let win={phase:'idle',installed:{version:winVersion},selected:{version:'2.7.1'},result:null},busy=false;
 const windows={getState:()=>win,check:async()=>{calls.push('check-windows');return win;},download:async()=>{calls.push('download-windows');win={...win,phase:'downloaded',downloaded:true};return win;},cancel:()=>calls.push('cancel-windows')};
 const wsl={isBusy:()=>busy,discoverForUpdate:async()=>{calls.push('discover');return {status:distroStatus,targets};},preflight:async id=>{calls.push('preflight-'+id);return {ready:wslReady,reason:wslReady?null:'active Linux job'};},updateAndWait:async id=>{calls.push('install-'+id);return {result:wslResult,version:wslResult.version,error:wslResult.error};}};
 const options={stateDir,windows,wsl,checkWindows:async()=>{calls.push('preflight-windows');return {ready:winReady,reason:winReady?null:'active Windows job'};},installWindows:async()=>{calls.push('install-windows');return winResult;},onChange:s=>events.push(s)};
 const controller=createUnifiedUpdates(options);return {controller,calls,events,windows,wsl,stateDir,options,setWin:value=>{win=value;},setBusy:value=>{busy=value;}};
}
test('all targets pass preflight before any install; WSL precedes Windows; restart reconciles exact result',async t=>{
 const f=fixture(t);assert.equal((await f.controller.run()).started,true);
 assert.deepEqual(f.calls,['check-windows','discover','preflight-windows','preflight-Ubuntu','preflight-Ubuntu','install-Ubuntu','preflight-windows','download-windows','install-windows']);
 assert.equal(f.controller.getState().status,'awaiting_windows');
 const existing=f.windows.getState();f.setWin({...existing,result:{operationId:'unrelated',status:'success'}});f.controller.observeWindows(f.windows.getState());assert.equal(f.controller.getState().active,true);
 f.setWin({...existing,result:{operationId:'windows-op',status:'success',message:'installed'}});const loaded=createUnifiedUpdates(f.options);loaded.load();assert.equal(loaded.getState().status,'completed');assert.ok(loaded.getState().targets.every(x=>x.status==='completed'));
});
test('busy Windows or Linux, legacy and unknown distro block every installation',async t=>{
 for(const options of [{winReady:false},{wslReady:false},{targets:[{id:'Old',installed:true,legacy:true}]},{targets:[{id:'Bad',error:'probe failed'}]},{distroStatus:'error'}]){
  const f=fixture(t,options);assert.equal((await f.controller.run()).status,'blocked');assert.ok(!f.calls.some(c=>c.startsWith('install-')||c.startsWith('download-')));
 }
});
test('no WSL and missing Gateway are skipped; current Windows permits WSL-only update',async t=>{
 const noWsl=fixture(t,{targets:[],distroStatus:'unavailable'});assert.equal((await noWsl.controller.run()).started,true);assert.ok(noWsl.calls.includes('install-windows'));
 const missing=fixture(t,{targets:[{id:'Empty',installed:false}],winVersion:'2.7.1'});assert.equal((await missing.controller.run()).status,'completed');assert.equal(missing.controller.getState().targets[1].status,'skipped');assert.ok(!missing.calls.includes('preflight-Empty'));
 const wslOnly=fixture(t,{winVersion:'2.7.1'});assert.equal((await wslOnly.controller.run()).status,'completed');assert.ok(wslOnly.calls.includes('install-Ubuntu'));assert.ok(!wslOnly.calls.includes('install-windows'));
});
test('failure preserves completed target and later retry does not reexecute it',async t=>{
 const f=fixture(t,{targets:[{id:'A',installed:true,canUpdate:true},{id:'B',installed:true,canUpdate:true}]});
 f.wsl.updateAndWait=async id=>{f.calls.push('install-'+id);return {result:{status:id==='A'?'installed':'blocked'},error:'busy now'};};
 assert.equal((await f.controller.run()).status,'partial');assert.equal(f.controller.getState().targets.find(t=>t.id==='A').status,'completed');assert.ok(!f.calls.includes('install-windows'));
 f.wsl.discoverForUpdate=async()=>({status:'available',targets:[{id:'A',installed:true,canUpdate:false},{id:'B',installed:true,canUpdate:true}]});f.wsl.updateAndWait=async id=>{f.calls.push('install-'+id);return {result:{status:'installed'}};};await f.controller.run();assert.equal(f.calls.filter(c=>c==='install-A').length,1);
});
test('duplicate calls share run; cancellation before install and between targets never kills current installer',async t=>{
 const f=fixture(t);let done;f.wsl.discoverForUpdate=()=>new Promise(resolve=>done=resolve);const a=f.controller.run(),b=f.controller.run();assert.equal(a,b);await Promise.resolve();f.controller.cancel();done({status:'available',targets:[]});assert.equal((await a).status,'cancelled');assert.ok(!f.calls.includes('install-windows'));
 const second=fixture(t);second.wsl.updateAndWait=async()=>{second.controller.cancel();return {result:{status:'installed'}};};assert.equal((await second.controller.run()).status,'partial');assert.ok(!second.calls.includes('install-windows'));assert.equal(second.controller.getState().targets[1].status,'completed');
});
test('Monitor restart never automatically dispatches queued targets',async t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.stateDir,'unified-update.json'),JSON.stringify({schemaVersion:1,active:true,status:'running',phase:'installing',targets:[{id:'Ubuntu',kind:'wsl',status:'running'}]}));f.controller.load();assert.equal(f.controller.getState().status,'interrupted');assert.deepEqual(f.calls,[]);
});
test('close during active WSL prevents any later Windows dispatch',async t=>{
 const f=fixture(t);f.wsl.updateAndWait=async()=>{f.controller.close();return {result:{status:'installed'}};};await f.controller.run();assert.ok(!f.calls.includes('install-windows'));
});
test('Windows dispatch failure after WSL success is partial; download hash failure never installs',async t=>{
 const f=fixture(t,{winResult:{started:false,reason:'busy Windows'}});assert.equal((await f.controller.run()).status,'partial');
 const g=fixture(t,{targets:[]});g.windows.download=async()=>({phase:'idle',error:'hash mismatch'});assert.equal((await g.controller.run()).status,'blocked');assert.ok(!g.calls.includes('install-windows'));
});
