import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {executeCli,parseCliArgs} from '../src/cli-update-command.js';
import type {CliInspection} from '../src/cli-update-providers.js';
import type {ProviderName} from '../src/types.js';
import {cliHostPaths,loadCliEnvironment,savedCliConfiguration} from '../src/cli-update-environment.js';
import {processIdentityAsync} from '../src/process-identity.js';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const row=(p:ProviderName):CliInspection=>({provider:p,status:'available',currentVersion:'1.2.3',latestVersion:'1.2.4',path:'/bin/'+p,method:'native'});
const updateLock=async<T>(_p:ProviderName,action:()=>Promise<T>)=>action();
function fixture(directory:string){
 return {journal:directory,inspect:async(p:ProviderName)=>row(p),lock:updateLock,apply:async(_p:ProviderName,item:CliInspection,verify:()=>Promise<void>)=>{
   await verify();return {...item,status:'current' as const,currentVersion:item.latestVersion};
 }};
}
test('CLI inventory action cannot mutate or create journals; rejects unsupported arguments',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agent-acp-cli-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const never=async()=>{throw Error('unexpected update');};
 const state=await executeCli(parseCliArgs(['list','--json']),{...fixture(dir),lock:never,apply:never});
 assert.equal(state.rows.length,3);assert.deepEqual(await fs.readdir(dir),[]);
 for(const args of [['update','../codex'],['status','--operation-id','../../a'],['list','--all'],['update','--all','--expected-version','1.0.0']])assert.throws(()=>parseCliArgs(args));
});
test('same operation ID is never replayed, and offline polling observes the verify phase after monitor restart',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agent-acp-cli-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const id=randomUUID(),opts=parseCliArgs(['update','codex','--operation-id',id]), deps=fixture(dir);
 const read=()=>executeCli(parseCliArgs(['status','--operation-id',id]),deps);
 assert.equal((await read()).operationId,null);
 let applies=0;
 deps.apply=async(p,item,verify)=>{
   applies++;assert.equal((await read()).rows[0].status,'updating');await verify();
   assert.equal((await read()).rows[0].status,'verifying');assert.equal((await executeCli(opts,deps)).busy,true);
   return {...item,status:'current',currentVersion:'1.2.4'};
 };
 const result=await executeCli(opts,deps);
 assert.equal(result.rows[0].status,'updated');assert.equal(result.rows[0].previousVersion,'1.2.3');assert.equal(result.rows[0].verifiedVersion,'1.2.4');
 assert.equal((await read()).busy,false);assert.deepEqual(await executeCli(opts,deps),result);assert.equal(applies,1);
});
test('batch skips busy and unavailable targets, and continues to verify eligible upgrades',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agent-acp-cli-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const deps=fixture(dir),mutations:ProviderName[]=[];
 const res=await executeCli(parseCliArgs(['update','--all']),{...deps,inspect:async p=>p==='codex'?{...row(p),status:'error',message:'offline'}:row(p),lock:async (p,fn)=>{
   if(p==='grok')throw Object.assign(Error('active session'),{code:'CLI_UPDATE_BUSY'});mutations.push(p);return fn();
 }});
 assert.deepEqual(res.rows.map(r=>r.status),['blocked','updated','error']);assert.deepEqual(mutations,['claude']);assert.equal(res.rows[0].retryable,true);
});
test('displayed target or version drift and fresh locked inspection prevent updating the wrong copy',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agent-acp-cli-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const deps=fixture(dir);let applies=0,inspections=0;
 const apply=async(p:ProviderName)=>{applies++;return row(p);};
 const inspect=async(p:ProviderName)=>({...row(p),path:++inspections===1?'/bin/grok':'/other/grok'});
 for(const args of [['--expected-path','/different/grok'],['--expected-version','0.0.0'],['--expected-latest','1.2.5'],[]]){
   inspections=0;const s=await executeCli(parseCliArgs(['update','grok',...args]),{...deps,apply,inspect});
   assert.equal(s.rows[0].status,'blocked');
 }
 assert.equal(applies,0);
});
test('offline Gateway path discovery reads registered CLI overrides exclusively',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agent-acp-config-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const conf=path.join(dir,'.codex');await fs.mkdir(conf);
 const codexConfig=path.join(conf,'config.toml');const sample={HOME:dir,CODEX_HOME:conf,APPDATA:path.join(dir,'roaming'),LOCALAPPDATA:path.join(dir,'local'),USERPROFILE:dir};
 await fs.writeFile(codexConfig,'model="other"\n');assert.deepEqual(await savedCliConfiguration(sample,'linux'),[]);
 await fs.writeFile(codexConfig,'[mcp_servers.agent.env]\nCLAUDE_CLI="/home/fixture/claude"\nOPENAI_API_KEY="never"\n');
 await fs.writeFile(path.join(dir,'.claude.json'),JSON.stringify({projects:{'/project':{mcpServers:{agent:{env:{CODEX_CLI:'/opt/codex',SECRET:'x'}}}}}}));
 assert.deepEqual(await savedCliConfiguration(sample,'linux'),[{CLAUDE_CLI:'/home/fixture/claude'},{CODEX_CLI:'/opt/codex'}]);
 const msix=path.join(sample.LOCALAPPDATA,'Packages','Claude_example','LocalCache','Roaming','Claude');await fs.mkdir(msix,{recursive:true});
 await fs.writeFile(path.join(msix,'claude_desktop_config.json'),JSON.stringify({mcpServers:{agent:{env:{GROK_CLI:'/opt/grok',TOKEN:'secret'}}}}));
 assert.deepEqual((await savedCliConfiguration(sample,'win32')).at(-1),{GROK_CLI:'/opt/grok'});
 assert.deepEqual(cliHostPaths({PATH:'C:/cli',TOKEN:'secret'}),{PATH:'C:/cli'});
});
test('verified live hosts override the caller and ambiguous contexts cannot select a different executable',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agent-acp-cli-hosts-'));
 const state=path.join(dir,'state'),folder=path.join(state,'gateways');
 await fs.mkdir(folder,{recursive:true});
 const child=spawn(process.execPath,['-e','setInterval(()=>{},60000)'],{stdio:'ignore',windowsHide:true});
 const stopped=once(child,'close');await once(child,'spawn');
 const keys=['PATH','CLAUDE_CLI','CODEX_CLI','CODEX_CLI_PATH','GROK_CLI'];
 const old=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 t.after(async()=>{child.kill();await stopped;for(const key of keys){if(old[key]===undefined)delete process.env[key];else process.env[key]=old[key];}await fs.rm(dir,{recursive:true,force:true});});
 const host=async(pid:number,paths:Record<string,string>,start=processIdentityAsync(pid))=>{
   const startIdentity=await start;assert.ok(startIdentity);
   await fs.writeFile(path.join(folder,pid+'.json'),JSON.stringify({pid,startIdentity,installRoot:dir,cliPaths:paths}));
 };
 const basePath=process.env.PATH!;
 const binary=path.join(dir,'codex');
 process.env.CODEX_CLI=path.join(dir,'other');
 await host(process.pid,{PATH:basePath,CODEX_CLI:binary});
 assert.equal((await loadCliEnvironment(dir,state)).size,0);assert.equal(process.env.CODEX_CLI,binary);
 await host(child.pid!,{PATH:basePath+path.delimiter+dir,CODEX_CLI:binary});
 assert.deepEqual(await loadCliEnvironment(dir,state),new Set(['grok','claude']));
 await host(child.pid!,{PATH:basePath,CODEX_CLI:path.join(dir,'other')});
 assert.deepEqual(await loadCliEnvironment(dir,state),new Set(['codex']));
 await host(child.pid!,{PATH:basePath,CODEX_CLI:path.join(dir,'other')},Promise.resolve('stale-generation'));
 assert.equal((await loadCliEnvironment(dir,state)).size,0);
});
