import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url),{createWslUpdates,decode,distroNames,parseOutput}=require('../update/wsl.cjs');
const encoded=s=>Buffer.from(s,'utf16le'),json=value=>({stdout:Buffer.from(JSON.stringify(value)+'\n')});
function fixture({names=['Ubuntu','Stopped'],running=['Ubuntu'],installed=true,legacy=false}={}){
 const calls=[],id='11111111-1111-4111-8111-111111111111';let final={status:'success',version:'2.6.0',phase:'completed'};
 const exec=async(file,args,options)=>{
  calls.push({file,args,options});assert.equal(file,'wsl.exe');assert.equal(options.shell,false);assert.equal(options.windowsHide,true);
  if(args[0]==='--list')return {stdout:encoded((args.includes('--running')?running:names).join('\r\n'))};
  assert.equal(args[0],'--distribution');assert.ok(names.includes(args[1]));assert.deepEqual(args.slice(2,5),['--exec','sh','-c']);const script=args[5];
  if(script.includes("'--background'"))return json({status:'started',operationId:id});
  if(script.includes("'operation'"))return json(final);
  if(script.includes("'--check'"))return json({installed:true,currentVersion:'2.5.3',latestVersion:'2.6.0',canUpdate:true,phase:'checked',progress:100});
  return json({installed,legacy,version:installed?'2.5.3':null,canUpdate:false});
 };
 const timers={setTimeout:()=>({unref(){}}),clearTimeout(){}};
 return {calls,exec,timers,setFinal:value=>final=value,id};
}
test('WSL output supports UTF16LE, UTF8 and safe exact distro names',()=>{
 assert.equal(decode(encoded('Ubuntu\r\n')),'Ubuntu\r\n');assert.deepEqual(distroNames(encoded('Ubuntu\r\nTest Distro\r\nUbuntu\r\n--bad')),["Ubuntu","Test Distro"]);
 assert.equal(parseOutput('not JSON\n{"installed":true}\n').installed,true);
});
test('WSL absent, disabled, no distributions and native Linux never launch a distro',async()=>{
 for(const code of ['ENOENT',1]){const service=createWslUpdates({platform:'win32',exec:async()=>{throw Object.assign(Error('private failure'),{code});}});const value=await service.refresh();assert.equal(value.status,code==='ENOENT'?'unavailable':'disabled');assert.equal(value.busy,false);assert.deepEqual(value.targets,[]);service.close();}
 const empty=fixture({names:[],running:[]}),service=createWslUpdates({platform:'win32',...empty});assert.equal((await service.refresh()).status,'empty');assert.ok(empty.calls.every(c=>c.args[0]==='--list'));service.close();
 const native=createWslUpdates({platform:'linux',exec:async()=>{throw Error('must not call Windows');}});assert.equal((await native.refresh()).status,'unavailable');native.close();
});
test('passive refresh probes only running distributions; explicit probe may start stopped target',async()=>{
 const f=fixture(),service=createWslUpdates({platform:'win32',...f});const state=await service.refresh();assert.equal(state.busy,false);assert.equal(state.targets[0].installed,true);assert.equal(state.targets[1].running,false);
 assert.ok(f.calls.filter(c=>c.args[0]==='--distribution').every(c=>c.args[1]==='Ubuntu'));
 const checked=await service.probe('Stopped');assert.ok(f.calls.some(c=>c.args[1]==='Stopped'));assert.equal(checked.targets[1].latestVersion,'2.6.0');assert.equal(checked.targets[1].canUpdate,true);
 assert.equal(checked.targets[1].progress,null,'A completed version check must not leave a 100% gauge');
 const before=f.calls.length;await assert.rejects(service.probe('not-installed; touch /tmp/injected'),/선택/);assert.equal(f.calls.length,before);service.close();
});
test('missing Gateway or old registration is never silently installed',async()=>{
 for(const options of [{installed:false},{legacy:true}]){const f=fixture(options),service=createWslUpdates({platform:'win32',...f});await service.refresh();await service.update('Ubuntu');assert.ok(!f.calls.some(c=>c.args[5]?.includes("'--background'")));assert.match(service.getState().targets[0].error,/설치 프로그램/);service.close();}
});
test('background updates are single dispatch, persist operation, and resume observation after Monitor restart',async()=>{
 const stateDir=await fs.mkdtemp(path.join(os.tmpdir(),'wsl-update-test-'));const f=fixture();let service=createWslUpdates({platform:'win32',stateDir,...f});
 try{await service.refresh();await service.probe('Ubuntu');await service.update('Ubuntu');await service.update('Ubuntu');assert.equal(f.calls.filter(c=>c.args[5]?.includes("'--background'")).length,1);assert.equal(service.isBusy(),true);service.close();
  service=createWslUpdates({platform:'win32',stateDir,...f});await service.refresh();await service.poll();assert.equal(service.getState().targets[0].version,'2.6.0');assert.equal(service.isBusy(),false);assert.match(service.getState().targets[0].message,/재연결/);assert.deepEqual(JSON.parse(await fs.readFile(path.join(stateDir,'wsl-operations.json'),'utf8')),{});
 }finally{service.close();await fs.rm(stateDir,{recursive:true,force:true});}
});
test('busy Windows installer and active Linux jobs block new target work',async()=>{
 const f=fixture(),service=createWslUpdates({platform:'win32',...f,blocked:()=>true});await service.refresh();await service.update('Ubuntu');assert.ok(!f.calls.some(c=>c.args[5]?.includes("'--background'")));service.close();
 const g=fixture();g.setFinal({status:'blocked',message:'Active Gateway job'});const blocked=createWslUpdates({platform:'win32',...g});await blocked.refresh();await blocked.update('Ubuntu');await blocked.poll();assert.equal(blocked.isBusy(),false);assert.equal(blocked.getState().targets[0].canUpdate,false);assert.match(blocked.getState().targets[0].error,/Active Gateway job/);blocked.close();
});

test('Linux updater result protocol settles installed, up_to_date and error operations',async()=>{
 for(const status of ['installed','up_to_date','error','blocked','cancelled']){
  const f=fixture(),service=createWslUpdates({platform:'win32',...f});await service.refresh();await service.probe('Ubuntu');await service.update('Ubuntu');
  f.setFinal({status:'running',phase:'verifying',progress:50});await service.poll();assert.deepEqual(service.getState().targets[0].progress,{received:50,total:100,unit:'percent'});assert.equal(service.isBusy(),true);
  f.setFinal({type:'result',status,phase:status==='error'?'failed':'complete',version:'2.6.0',progress:100,error:status==='error'?'Signature verification failed':undefined});await service.poll();assert.equal(service.isBusy(),false);assert.equal(service.getState().targets[0].progress,null);if(status==='error')assert.match(service.getState().targets[0].error,/Signature/);else if(status!=='cancelled')assert.equal(service.getState().targets[0].canUpdate,false);service.close();
 }
});
