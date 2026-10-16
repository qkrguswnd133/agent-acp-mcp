// Explicit optional WSL integration, using only a newly-created Linux fixture.
import fs from 'node:fs/promises';import path from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {createRequire} from 'node:module';import assert from 'node:assert/strict';
const [distro,node]=process.argv.slice(2);if(!distro||!node?.startsWith('/'))throw Error('Usage: node tests/Smoke-Wsl-Readiness.mjs DISTRO ABSOLUTE_LINUX_NODE');
const execute=promisify(execFile),{createWslUpdates}=createRequire(import.meta.url)('../monitor/update/wsl.cjs');
const command=async script=>JSON.parse((await execute('wsl.exe',['-d',distro,'--exec',node,'-e',script],{windowsHide:true,timeout:30000})).stdout.trim());
const root=await command("const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const root=fs.mkdtempSync(path.join(os.tmpdir(),'agent-readiness-wsl-'));for(const p of ['gateway','state'])fs.mkdirSync(path.join(root,p));console.log(JSON.stringify(root));");
let service,readinessCalls=0;
try{
 const reply=value=>({stdout:Buffer.from(JSON.stringify(value))});
 service=createWslUpdates({platform:'win32',exec:async(file,args,options)=>{
  if(args[0]==='--list')return {stdout:Buffer.from(distro+'\n')};
  assert.equal(args[1],distro);
  if(args[5].includes('checkReadiness')){readinessCalls++;return execute(file,args,options);}
  if(args[5].includes("'--check'"))return reply({status:'available',currentVersion:'0.0.0',latestVersion:'2.7.1'});
  if(args[5].includes("'--background'"))throw Error('A readiness smoke must never dispatch an updater');
  return reply({installed:true,legacy:false,version:'0.0.0',installRoot:root+'/gateway',stateRoot:root+'/state',nodeExecutable:node});
 }});
 await service.discoverForUpdate();const result=await service.preflight(distro);assert.equal(result.ready,true,JSON.stringify(result));assert.equal(readinessCalls,1);console.log(JSON.stringify({passed:true,readOnly:true,realWslTransport:true,ready:result.ready}));
}finally{
 service?.close();
 const cleanup="const fs=require('node:fs'),path=require('node:path'),root="+JSON.stringify(root)+";if(path.dirname(root)!=='/tmp'||!/^agent-readiness-wsl-[A-Za-z0-9]+$/.test(path.basename(root))||fs.lstatSync(root).isSymbolicLink())throw Error('Unsafe fixture');fs.rmSync(root,{recursive:true});console.log('true');";
 await command(cleanup);
}
