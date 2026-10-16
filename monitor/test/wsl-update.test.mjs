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
  return json({installed,legacy,version:installed?'2.5.3':null,canUpdate:false,installationRoot:'/home/USERNAME/.local/share/agent-acp-mcp',stateDirectory:'/home/USERNAME/.agent-acp-mcp',nodeExecutable:'/home/USERNAME/node/bin/node'});
 };
 const timers={setTimeout:()=>({unref(){}}),clearTimeout(){}};
 return {calls,exec,timers,setFinal:value=>final=value,id};
}
test('WSL output supports UTF16LE, UTF8 and safe exact distro names',()=>{
 assert.equal(decode(encoded('Ubuntu\r\n')),'Ubuntu\r\n');assert.deepEqual(distroNames(encoded('Ubuntu\r\nTest Distro\r\nUbuntu\r\n--bad')),["Ubuntu","Test Distro"]);
 assert.equal(parseOutput('not JSON\n{"installed":true}\n').installed,true);
});
test('WSL absent, disabled, no distributions and native Linux never launch a distro',async()=>{
 for(const code of ['ENOENT',1]){const service=createWslUpdates({platform:'win32',exec:async()=>{throw Object.assign(Error('private failure'),{code});}});const value=await service.refresh();assert.equal(value.status,code==='ENOENT'?'unavailable':'error');assert.equal(value.safeToSkip,code==='ENOENT');assert.equal(value.busy,false);assert.deepEqual(value.targets,[]);service.close();}
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
 let windowsBusy=false;const f=fixture(),service=createWslUpdates({platform:'win32',...f,blocked:()=>windowsBusy});await service.refresh();windowsBusy=true;await service.update('Ubuntu');assert.ok(!f.calls.some(c=>c.args[5]?.includes("'--background'")));service.close();
 const g=fixture();g.setFinal({status:'blocked',message:'Active Gateway job'});const blocked=createWslUpdates({platform:'win32',...g});await blocked.refresh();await blocked.update('Ubuntu');await blocked.poll();assert.equal(blocked.isBusy(),false);assert.equal(blocked.getState().targets[0].canUpdate,false);assert.match(blocked.getState().targets[0].error,/Active Gateway job/);blocked.close();
});

test('explicit unified discovery starts stopped distros, checks all registered gateways and respects missing installations',async()=>{
 const f=fixture({names:['Stopped','Missing','Legacy','Failed'],running:[]});
 const exec=async(file,args,options)=>{if(args[1]==='Missing'&&args[0]==='--distribution'){f.calls.push({file,args,options});return json({installed:false,status:'not_installed'});}if(args[1]==='Legacy'&&args[0]==='--distribution'){f.calls.push({file,args,options});return json({installed:true,legacy:true,version:null});}if(args[1]==='Failed'&&args[0]==='--distribution'){f.calls.push({file,args,options});throw Error('unknown registration');}return f.exec(file,args,options);};
 const service=createWslUpdates({platform:'win32',...f,exec,blocked:()=>true});
 try{const passive=await service.refresh();assert.equal(passive.targets.length,0);assert.equal(f.calls.length,0);
  const value=await service.discoverForUpdate();assert.equal(value.busy,false);assert.deepEqual(value.targets.map(t=>t.id),['Stopped','Missing','Legacy','Failed']);
  assert.equal(value.targets[0].running,true);assert.equal(value.targets[0].latestVersion,'2.6.0');assert.equal(value.targets[0].installRoot,'/home/USERNAME/.local/share/agent-acp-mcp');assert.equal(value.targets[0].stateRoot,'/home/USERNAME/.agent-acp-mcp');
  assert.equal(value.targets[1].installed,false);assert.equal(value.targets[2].legacy,true);assert.equal(value.targets[3].phase,'error');assert.ok(value.targets[3].error);
  assert.deepEqual(f.calls.filter(c=>c.args[5]?.includes("'--check'")).map(c=>c.args[1]),['Stopped']);assert.ok(!f.calls.some(c=>c.args[5]?.includes("'--background'")));
 }finally{service.close();}
});

test('unified discovery supports absent WSL, no distros and explicit startup when running enumeration fails',async()=>{
 const absent=createWslUpdates({platform:'win32',exec:async()=>{throw Object.assign(Error('missing'),{code:'ENOENT'});}});assert.equal((await absent.discoverForUpdate()).status,'unavailable');absent.close();
 const empty=fixture({names:[],running:[]}),none=createWslUpdates({platform:'win32',...empty});assert.equal((await none.discoverForUpdate()).status,'empty');assert.equal(empty.calls.filter(c=>c.args[0]==='--distribution').length,0);none.close();
 const f=fixture({names:['Stopped'],running:[]}),service=createWslUpdates({platform:'win32',...f,exec:async(file,args,options)=>{if(args.includes('--running'))throw Error('unknown running state');return f.exec(file,args,options);}});
 try{const value=await service.discoverForUpdate();assert.equal(value.targets[0].running,true);assert.equal(value.targets[0].canUpdate,true);}finally{service.close();}
});

test('known disabled WSL can be skipped, unknown enumeration failure blocks the unified update',async()=>{
 for(const diagnostic of ['Wsl/WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED','Wsl/WSL_E_NOT_INSTALLED','Error: 0x8007019e']){const service=createWslUpdates({platform:'win32',exec:async()=>{throw Object.assign(Error('query failed'),{code:1,stderr:encoded(diagnostic)});}});try{const value=await service.discoverForUpdate();assert.equal(value.status,'disabled');assert.equal(value.safeToSkip,true);assert.equal(value.targets.length,0);}finally{service.close();}}
 for(const diagnostic of ['Access denied','HCS_E_SERVICE_NOT_AVAILABLE','WSL_E_DISTRO_NOT_FOUND']){const service=createWslUpdates({platform:'win32',exec:async()=>{throw Object.assign(Error('query failed'),{code:1,stderr:encoded(diagnostic)});}});try{const value=await service.discoverForUpdate();assert.equal(value.status,'error');assert.equal(value.safeToSkip,false);}finally{service.close();}}
});

test('preflight uses safely quoted registered POSIX paths and bundled read-only source',async()=>{
 const f=fixture({names:["Distro ' ; $(inject)"],running:[]}),paths={installationRoot:"/home/USERNAME/' ; $(inject) /gateway",stateDirectory:"/home/USERNAME/' ; $(inject) /state",nodeExecutable:"/home/USERNAME/' ; $(inject) /node"};
 let preflightCalls=0;const exec=async(file,args,options)=>{
  if(args[0]==='--distribution'&&args[5]?.startsWith('exec ')){preflightCalls++;const shellQuote=value=>"'"+value.replaceAll("'","'\\''")+"'";assert.ok(args[5].startsWith(`exec ${shellQuote(paths.nodeExecutable)} -e '`));assert.ok(args[5].endsWith(`${shellQuote(paths.installationRoot)} ${shellQuote(paths.stateDirectory)}`));assert.match(args[5],/module\.exports/);return json({ready:true,reason:null,checkedProcesses:3});}
  const value=await f.exec(file,args,options);if(args[0]==='--distribution'&&!args[5].includes("'--check'"))return json({...JSON.parse(value.stdout),...paths});return value;
 };
 const service=createWslUpdates({platform:'win32',...f,exec,blocked:()=>true});
 try{await service.discoverForUpdate();assert.deepEqual(await service.preflight(f.calls.find(c=>c.args[0]==='--distribution').args[1]),{ready:true,reason:null,checkedProcesses:3});assert.equal(preflightCalls,1);}finally{service.close();}
});

test('preflight rejects legacy, missing, malformed paths and unknown readiness without a launch',async()=>{
 for(const overrides of [{installed:false},{installed:true,legacy:true},{installed:true,installationRoot:'relative/path'},{installed:true,nodeExecutable:'/node\nunsafe'},{installed:true,stateDirectory:'/tmp/../wrong'}]){
  const f=fixture({names:['Ubuntu']}),service=createWslUpdates({platform:'win32',...f,exec:async(file,args,options)=>{const value=await f.exec(file,args,options);return args[0]==='--distribution'&&!args[5].includes("'--check'")?json({...JSON.parse(value.stdout),...overrides}):value;}});
  try{await service.discoverForUpdate();const result=await service.preflight('Ubuntu');assert.equal(result.ready,false);assert.ok(result.reason);assert.ok(!f.calls.some(c=>c.args[5]?.startsWith('exec ')));}finally{service.close();}
 }
 const f=fixture(),service=createWslUpdates({platform:'win32',...f,exec:async(file,args,options)=>args[5]?.startsWith('exec ')?json({status:'unknown'}):f.exec(file,args,options)});try{await service.discoverForUpdate();assert.equal((await service.preflight('Ubuntu')).ready,false);}finally{service.close();}
});

test('fresh discovery never reuses stale registration or treats failed version checks as up to date',async()=>{
 const f=fixture({names:['Ubuntu']});let broken=false;
 const service=createWslUpdates({platform:'win32',...f,exec:async(file,args,options)=>{if(broken&&args[0]==='--distribution')return json(args[5].includes("'--check'")?{status:'error',error:'GitHub offline'}:{installed:true,legacy:false,version:'2.5.3'});return f.exec(file,args,options);}});
 try{await service.discoverForUpdate();assert.ok(service.getState().targets[0].nodeExecutable);broken=true;await service.discoverForUpdate();const item=service.getState().targets[0];assert.equal(item.nodeExecutable,null);assert.equal(item.installRoot,null);assert.equal(item.latestVersion,null);assert.equal(item.canUpdate,false);assert.equal(item.error,'GitHub offline');assert.equal((await service.preflight('Ubuntu')).ready,false);}finally{service.close();}
});

test('coordinated update bypasses its external block, persists UUID before polling and returns exact terminal result',async()=>{
 const stateDir=await fs.mkdtemp(path.join(os.tmpdir(),'wsl-unified-test-')),f=fixture({names:['Ubuntu']});let polls=0;
 const terminal={status:'installed',operationId:f.id,version:'2.6.0',phase:'complete',reconnectRequired:true,backup:'/home/USERNAME/backup'};
 const exec=async(file,args,options)=>{if(args[5]?.includes("'operation'")){const journal=JSON.parse(await fs.readFile(path.join(stateDir,'wsl-operations.json'),'utf8'));assert.equal(journal.Ubuntu,f.id);polls++;f.setFinal(polls===1?{status:'running',phase:'verifying',progress:50}:terminal);}return f.exec(file,args,options);};
 const progress=[],service=createWslUpdates({platform:'win32',...f,exec,stateDir,blocked:()=>true,wait:async()=>{}});
 try{await service.discoverForUpdate();const result=await service.updateAndWait('Ubuntu',{onProgress:t=>progress.push(t.phase)});assert.equal(result.status,'installed');assert.equal(result.operationId,f.id);assert.equal(result.version,'2.6.0');assert.deepEqual(result.result,terminal);assert.equal(result.progress,null);assert.equal(service.isBusy(),false);assert.ok(progress.includes('verifying'));assert.equal(f.calls.filter(c=>c.args[5]?.includes("'--background'")).length,1);assert.deepEqual(JSON.parse(await fs.readFile(path.join(stateDir,'wsl-operations.json'),'utf8')),{});
 }finally{service.close();await fs.rm(stateDir,{recursive:true,force:true});}
});

test('coordinated terminal failure preserves exact result and does not relaunch',async()=>{
 for(const status of ['blocked','error','rollback_failed','cancelled']){const f=fixture({names:['Ubuntu']});f.setFinal({status,operationId:f.id,phase:'failed',error:'precise Linux reason',version:'2.5.3'});const service=createWslUpdates({platform:'win32',...f});try{await service.discoverForUpdate();const result=await service.updateAndWait('Ubuntu');assert.equal(result.result.status,status);assert.equal(result.result.error,'precise Linux reason');assert.equal(result.operationId,f.id);assert.equal(f.calls.filter(c=>c.args[5]?.includes("'--background'")).length,1);assert.equal(service.isBusy(),false);}finally{service.close();}}
});

test('uncertain dispatch survives restart and blocks automatic retries',async()=>{
 const stateDir=await fs.mkdtemp(path.join(os.tmpdir(),'wsl-uncertain-test-')),f=fixture({names:['Ubuntu']});
 const exec=async(file,args,options)=>{if(args[5]?.includes("'--background'")){f.calls.push({file,args,options});throw Error('lost detached start acknowledgement');}return f.exec(file,args,options);};let service=createWslUpdates({platform:'win32',...f,exec,stateDir});
 try{await service.discoverForUpdate();assert.equal((await service.updateAndWait('Ubuntu')).status,'unresolved');assert.equal(service.isBusy(),true);service.close();
  service=createWslUpdates({platform:'win32',...f,exec,stateDir});await service.refresh();assert.equal(service.getState().targets[0].status,'unresolved');await assert.rejects(service.updateAndWait('Ubuntu'),/이미 진행/);await assert.rejects(service.discoverForUpdate(),/이미 진행/);await service.update('Ubuntu');assert.equal(f.calls.filter(c=>c.args[5]?.includes("'--background'")).length,1);
 }finally{service.close();await fs.rm(stateDir,{recursive:true,force:true});}
});

test('bounded coordinated wait retains journal and resumed service observes completion without relaunch',async()=>{
 const stateDir=await fs.mkdtemp(path.join(os.tmpdir(),'wsl-wait-test-')),f=fixture({names:['Ubuntu']});f.setFinal({status:'running',phase:'installing'});let now=0,service=createWslUpdates({platform:'win32',...f,stateDir,clock:()=>now,waitTimeoutMs:3,wait:async()=>{now+=2;}});
 try{await service.discoverForUpdate();const result=await service.updateAndWait('Ubuntu');assert.equal(result.status,'unresolved');assert.equal(result.operationId,f.id);assert.equal(service.isBusy(),true);assert.equal(JSON.parse(await fs.readFile(path.join(stateDir,'wsl-operations.json'),'utf8')).Ubuntu,f.id);service.close();
  f.setFinal({status:'installed',version:'2.6.0'});service=createWslUpdates({platform:'win32',...f,stateDir});await service.refresh();await service.poll();assert.equal(service.getState().targets[0].result.operationId,f.id);assert.equal(service.isBusy(),false);assert.equal(f.calls.filter(c=>c.args[5]?.includes("'--background'")).length,1);
 }finally{service.close();await fs.rm(stateDir,{recursive:true,force:true});}
});

test('concurrent discovery, individual actions and poll calls cannot duplicate a coordinated dispatch',async()=>{
 const f=fixture({names:['Ubuntu']});let resolvePoll,entered;const enteredPoll=new Promise(resolve=>entered=resolve),pendingPoll=new Promise(resolve=>resolvePoll=resolve);let operationReads=0;
 const service=createWslUpdates({platform:'win32',...f,exec:async(file,args,options)=>{if(args[5]?.includes("'operation'")){operationReads++;entered();await pendingPoll;}return f.exec(file,args,options);}});
 try{await service.discoverForUpdate();const run=service.updateAndWait('Ubuntu');await enteredPoll;const before=f.calls.length;await service.update('Ubuntu');await service.probe('Ubuntu');await service.refresh();await assert.rejects(service.discoverForUpdate(),/이미 진행/);await assert.rejects(service.updateAndWait('Ubuntu'),/이미 진행/);assert.equal(f.calls.length,before);const poll=service.poll();resolvePoll();await Promise.all([run,poll]);assert.equal(operationReads,1);assert.equal(f.calls.filter(c=>c.args[5]?.includes("'--background'")).length,1);}finally{resolvePoll?.();service.close();}
});

test('Linux updater result protocol settles installed, up_to_date and error operations',async()=>{
 for(const status of ['installed','up_to_date','error','blocked','cancelled']){
  const f=fixture(),service=createWslUpdates({platform:'win32',...f});await service.refresh();await service.probe('Ubuntu');await service.update('Ubuntu');
  f.setFinal({status:'running',phase:'verifying',progress:50});await service.poll();assert.deepEqual(service.getState().targets[0].progress,{received:50,total:100,unit:'percent'});assert.equal(service.isBusy(),true);
  f.setFinal({type:'result',status,phase:status==='error'?'failed':'complete',version:'2.6.0',progress:100,error:status==='error'?'Signature verification failed':undefined});await service.poll();assert.equal(service.isBusy(),false);assert.equal(service.getState().targets[0].progress,null);if(status==='error')assert.match(service.getState().targets[0].error,/Signature/);else if(status!=='cancelled')assert.equal(service.getState().targets[0].canUpdate,false);service.close();
 }
});
