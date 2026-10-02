import {selectedInput} from './selection-fixture.js';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {officialNpmLaunch,resolveNpmLaunch,type NpmLaunchOptions,type OfficialNpmPackage} from '../src/npm-launch.js';
import {codexNpmPackage} from '../src/providers/codex.js';
import {executable,grokNpmPackage,resolveGrokLaunch,grokLaunchFingerprint} from '../src/runtime.js';
import {runGrok,type RunGrokDependencies} from '../src/acp.js';
import {readCodexStatus} from '../src/codex-app-server.js';
import {getSessionUsage} from '../src/usage.js';
import {home,runCommand,spawnPlan,type LaunchCommand} from '../src/process.js';

const windows={skip:process.platform!=='win32'};
const noNode:NpmLaunchOptions={currentRuntime:null,nodeCandidates:[],searchPath:false};
const withNode:NpmLaunchOptions={currentRuntime:{execPath:process.execPath,versions:process.versions},nodeCandidates:[],searchPath:false};
const uncCwd='\\\\wsl.localhost\\Ubuntu\\tmp\\fixture';
const metaArgs=['a b','quote"inside','amp&pipe|caret^','%PATH%','','trailing\\','{"mcpServers":{}}'];

/** npm-style global prefix: `<bin>.cmd` shim (which must never run) beside node_modules/<package>. */
async function npmPrefix(pkg:OfficialNpmPackage,manifest:Record<string,unknown>,files:Record<string,string>={},shimName=pkg.binNames[0]){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'agent npm launch '));
  const packageRoot=path.join(root,'node_modules',...pkg.name.split('/'));
  await fs.mkdir(path.join(packageRoot,'bin'),{recursive:true});
  await fs.writeFile(path.join(packageRoot,'package.json'),JSON.stringify(manifest));
  for(const [name,content] of Object.entries(files)){await fs.mkdir(path.dirname(path.join(packageRoot,name)),{recursive:true});await fs.writeFile(path.join(packageRoot,name),content);}
  const shim=path.join(root,shimName+'.cmd');
  await fs.writeFile(shim,'@echo off\r\necho SHIM_MUST_NOT_RUN\r\nexit /b 9\r\n');
  return {root,packageRoot,shim};
}
async function records(file:string):Promise<any[]>{try{return (await fs.readFile(file,'utf8')).split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));}catch{return [];}}
function alive(pid:number){try{process.kill(pid,0);return true;}catch{return false;}}
async function waitFor<T>(read:()=>Promise<T|undefined>,timeoutMs=15000):Promise<T>{
  const deadline=Date.now()+timeoutMs;
  for(;;){const value=await read();if(value!==undefined)return value;if(Date.now()>deadline)throw Error('fixture condition timed out');await new Promise(r=>setTimeout(r,50));}
}
const same=(a:string,b:string)=>assert.equal(path.resolve(a).toLowerCase(),path.resolve(b).toLowerCase());

// Mirrors @xai-official/grok: an extensionless node bin that execs the native
// CLI with inherited stdio. native.js is the fixture "native" Grok.
const grokBootstrap=`#!/usr/bin/env node
const {spawn}=require('child_process');const path=require('path');
const child=spawn(process.execPath,[path.join(__dirname,'native.js'),...process.argv.slice(2)],{stdio:'inherit',windowsHide:true});
child.on('exit',code=>process.exit(code??1));
`;
const grokNative=String.raw`const fs=require('fs'),path=require('path');const args=process.argv.slice(2);
fs.appendFileSync(path.join(__dirname,'records.jsonl'),JSON.stringify({pid:process.pid,args,cwd:process.cwd()})+'\n');
if(args[0]==='usage'){process.stdout.write(JSON.stringify({session:{inputTokens:5,outputTokens:2,reasoningTokens:1,totalTokens:8}}));process.exit(0);}
if(args[0]==='update'){process.stdout.write('UPDATE_RAN');process.exit(7);}
if(args[0]==='echo'){process.stdout.write(JSON.stringify({args:args.slice(1),cwd:process.cwd()}));process.exit(0);}
let buffer='',promptId;const config={};const send=v=>process.stdout.write(JSON.stringify(v)+'\n');const reply=(id,result)=>send({jsonrpc:'2.0',id,result});
function receive(m){
 if(m.method==='initialize')return reply(m.id,{protocolVersion:1,authMethods:[{id:'cached_token'}],_meta:{agentVersion:'fixture-agent'}});
 if(m.method==='authenticate')return reply(m.id,{_meta:{auth_mode:'Oidc',backend_billed:false}});
 if(m.method==='_x.ai/billing')return reply(m.id,{subscriptionTier:'fixture',config:{creditUsagePercent:25,currentPeriod:{type:'weekly',start:'2000-01-01T00:00:00Z',end:'2999-01-01T00:00:00Z'}}});
 if(m.method==='session/new')return reply(m.id,{sessionId:'launch-session',configOptions:[]});
 if(m.method==='session/set_config_option'){config[m.params.configId]=m.params.value;return reply(m.id,{configOptions:Object.entries(config).map(([id,currentValue])=>({id,type:'select',currentValue}))});}
 if(m.method==='session/prompt'){promptId=m.id;send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'launch-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'launch fixture answer'}}}});if(!JSON.stringify(m.params).includes('HANG_FIXTURE'))reply(m.id,{stopReason:'end_turn'});return;}
 if(m.method==='session/cancel'&&promptId!==undefined)return reply(promptId,{stopReason:'cancelled'});
}
process.stdin.setEncoding('utf8');process.stdin.on('end',()=>process.exit(0));
process.stdin.on('data',c=>{buffer+=c;for(;;){const e=buffer.indexOf('\n');if(e<0)return;const l=buffer.slice(0,e);buffer=buffer.slice(e+1);if(l)receive(JSON.parse(l));}});
`;
const grokManifest={name:grokNpmPackage.name,bin:{grok:'bin/grok'},engines:{node:'>=20'}};
const grokFiles={'bin/grok':grokBootstrap,'bin/native.js':grokNative};

test('Grok health fingerprint detects npm and native updates without a changed shim',windows,async()=>{
  const fixture=await npmPrefix(grokNpmPackage,grokManifest,grokFiles);
  const canonical=path.join(fixture.root,'grok.exe');
  try{
    await fs.writeFile(canonical,'native-v1');
    const before=await grokLaunchFingerprint(fixture.shim,canonical);
    await fs.writeFile(canonical,'native-version-two');
    const nativeChanged=await grokLaunchFingerprint(fixture.shim,canonical);
    assert.notEqual(nativeChanged,before);
    await fs.writeFile(path.join(fixture.packageRoot,'package.json'),JSON.stringify({...grokManifest,version:'2.0.0'}));
    const packageChanged=await grokLaunchFingerprint(fixture.shim,canonical);
    assert.notEqual(packageChanged,nativeChanged);
    await fs.writeFile(path.join(fixture.packageRoot,'bin','grok'),grokBootstrap+'\n// updated entry\n');
    assert.notEqual(await grokLaunchFingerprint(fixture.shim,canonical),packageChanged);
  }finally{await fs.rm(fixture.root,{recursive:true,force:true});}
});

const codexScript=String.raw`import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
const dir=path.dirname(fileURLToPath(import.meta.url));const args=process.argv.slice(2);
const record=v=>fs.appendFileSync(path.join(dir,'records.jsonl'),JSON.stringify(v)+'\n');record({pid:process.pid,args,cwd:process.cwd()});
if(args[0]==='--version'){process.stdout.write('codex-cli 9.9.9');process.exit(0);}
if(args[0]==='login'){process.stdout.write('Logged in using ChatGPT');process.exit(0);}
if(args[0]==='echo'){process.stdout.write(JSON.stringify({args:args.slice(1),cwd:process.cwd()}));process.exit(0);}
if(args[0]==='app-server'){let buffer='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);try{const m=JSON.parse(line);if(typeof m.id!=='number')continue;const result=m.method==='account/rateLimits/read'?{rateLimits:{primary:{usedPercent:10}}}:m.method==='account/read'?{account:{type:'chatgpt',email:'person@example.test'}}:{};process.stdout.write(JSON.stringify({id:m.id,result})+'\n');}catch{}}});}
if(args[0]==='exec'){let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
 if(input.includes('HANG_FIXTURE')){const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});record({grandchild:child.pid});return;}
 process.stdout.write([{type:'thread.started',thread_id:'codex-launch'},{type:'item.completed',item:{type:'agent_message',text:'codex launch answer'}},{type:'turn.completed',usage:{input_tokens:1}}].map(x=>JSON.stringify(x)).join('\n')+'\n');});}
`;
const codexManifest={name:codexNpmPackage.name,type:'module',bin:{codex:'bin/codex.js'},engines:{node:'>=16'}};

async function withEnv(values:Record<string,string|undefined>,action:()=>Promise<void>){
  const previous=new Map(Object.keys(values).map(key=>[key,process.env[key]]));
  for(const [key,value] of Object.entries(values)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  try{await action();}finally{for(const [key,value] of previous){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
}
async function loadCodex(){return import(`${new URL('../src/providers/codex.js',import.meta.url).href}?launch=${Date.now()}-${Math.random()}`);}

test('native explicit executables and the default Grok binary stay direct',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'agent-native-launch-'));
  try{
    for(const name of ['grok.exe','codex.exe','codex','grok']){
      const file=path.join(directory,name);await fs.writeFile(file,'');
      assert.equal(await resolveGrokLaunch(file,noNode),file);
      assert.equal(await resolveNpmLaunch(file,codexNpmPackage,noNode),file);
    }
    if(!process.env.GROK_CLI)assert.equal(executable,path.join(home,'.grok','bin',process.platform==='win32'?'grok.exe':'grok'));
    assert.equal(await resolveGrokLaunch(undefined,noNode),executable);
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});

test('official Codex and Grok npm shims resolve to their package bins, never the cmd shim',windows,async()=>{
  const codex=await npmPrefix(codexNpmPackage,codexManifest,{'bin/codex.js':codexScript});
  const codexExe=await npmPrefix(codexNpmPackage,{name:codexNpmPackage.name,bin:{codex:'bin/codex.exe'}},{'bin/codex.exe':''});
  const grok=await npmPrefix(grokNpmPackage,grokManifest,grokFiles);
  const grokString=await npmPrefix(grokNpmPackage,{name:grokNpmPackage.name,bin:'bin/grok'},grokFiles);
  try{
    assert.deepEqual(await resolveNpmLaunch(codex.shim,codexNpmPackage,withNode),{command:process.execPath,argsPrefix:[await fs.realpath(path.join(codex.packageRoot,'bin','codex.js'))],source:'official_npm_node'});
    assert.deepEqual(await resolveNpmLaunch(codexExe.shim,codexNpmPackage,noNode),{command:await fs.realpath(path.join(codexExe.packageRoot,'bin','codex.exe')),argsPrefix:[],source:'official_npm_native'});
    const grokBin=await fs.realpath(path.join(grok.packageRoot,'bin','grok'));
    assert.deepEqual(await resolveGrokLaunch(grok.shim,withNode),{command:process.execPath,argsPrefix:[grokBin],source:'official_npm_node'});
    // npm names a string bin after the unscoped package name.
    assert.equal((await resolveGrokLaunch(grokString.shim,withNode) as any).source,'official_npm_node');
    // Case-insensitive .CMD / .BAT shims resolve the same way.
    const upper=path.join(grok.root,'grok.BAT');await fs.writeFile(upper,'@echo off\r\nexit /b 9\r\n');
    assert.deepEqual(await resolveGrokLaunch(upper,withNode),{command:process.execPath,argsPrefix:[grokBin],source:'official_npm_node'});
  }finally{for(const fixture of [codex,codexExe,grok,grokString])await fs.rm(fixture.root,{recursive:true,force:true});}
});

test('official npm descriptors preserve exact argv and cwd with spaces and metacharacters, without a shell',windows,async()=>{
  const codex=await npmPrefix(codexNpmPackage,codexManifest,{'bin/codex.js':codexScript});
  const grok=await npmPrefix(grokNpmPackage,grokManifest,grokFiles);
  const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'agent launch cwd & ^ %x% '));
  try{
    for(const launch of [await resolveNpmLaunch(codex.shim,codexNpmPackage,withNode),await resolveGrokLaunch(grok.shim,withNode)]){
      assert.equal(typeof launch,'object');
      const plan=spawnPlan(launch,['echo',...metaArgs],cwd);
      assert.equal(plan.command,process.execPath);assert.equal(plan.windowsVerbatimArguments,false);
      const result=await runCommand(launch,['echo',...metaArgs],{cwd,timeoutMs:15000});
      assert.equal(result.code,0,result.stderr);assert.doesNotMatch(result.stdout,/SHIM_MUST_NOT_RUN/);
      const parsed=JSON.parse(result.stdout);assert.deepEqual(parsed.args,metaArgs);same(parsed.cwd,cwd);
    }
  }finally{for(const dir of [codex.root,grok.root,cwd])await fs.rm(dir,{recursive:true,force:true});}
});

test('custom Codex and Grok wrappers are preserved for local cwd and refused before spawn for UNC cwd',windows,async()=>{
  const codex=await npmPrefix(codexNpmPackage,codexManifest,{'bin/codex.js':codexScript});
  const grok=await npmPrefix(grokNpmPackage,grokManifest,grokFiles);
  const orphan=await fs.mkdtemp(path.join(os.tmpdir(),'agent npm orphan '));
  try{
    const marker=path.join(orphan,'ran.txt');
    const wrapper=`@echo off\r\necho ran>>"${marker}"\r\necho [%~1][%CD%]\r\n`;
    const customCodex=path.join(codex.root,'company codex.cmd'),customGrok=path.join(grok.root,'company-grok.cmd');
    // An npm-named shim without the official package beside it is also custom.
    const orphanCodex=path.join(orphan,'codex.cmd'),orphanGrok=path.join(orphan,'grok.cmd');
    for(const file of [customCodex,customGrok,orphanCodex,orphanGrok])await fs.writeFile(file,wrapper);
    const launches:LaunchCommand[]=[
      await resolveNpmLaunch(customCodex,codexNpmPackage,noNode),await resolveNpmLaunch(orphanCodex,codexNpmPackage,noNode),
      await resolveGrokLaunch(customGrok,noNode),await resolveGrokLaunch(orphanGrok,noNode)
    ];
    assert.deepEqual(launches,[customCodex,orphanCodex,customGrok,orphanGrok]);
    for(const launch of launches){
      const local=await runCommand(launch,['a b'],{cwd:orphan,timeoutMs:10000});
      assert.equal(local.code,0,local.stderr);assert.equal(local.stdout.trim().toLowerCase(),`[a b][${orphan}]`.toLowerCase());
    }
    await fs.rm(marker);
    for(const launch of launches){
      assert.throws(()=>spawnPlan(launch,['agent','stdio'],uncCwd),/UNC working directory/);
      let spawned=false;
      await assert.rejects(runCommand(launch,['--version'],{cwd:uncCwd,onSpawn:()=>{spawned=true;}}),/UNC working directory/);
      assert.equal(spawned,false);
    }
    await assert.rejects(fs.stat(marker),{code:'ENOENT'});
  }finally{for(const dir of [codex.root,grok.root,orphan])await fs.rm(dir,{recursive:true,force:true});}
});

test('malformed Codex and Grok package bins are refused instead of running the shim',windows,async()=>{
  const outside=await fs.mkdtemp(path.join(os.tmpdir(),'agent-npm-outside-'));
  await fs.writeFile(path.join(outside,'evil.exe'),'');
  try{
    for(const pkg of [codexNpmPackage,grokNpmPackage]){
      const bin=pkg.binNames[0];
      const cases:[unknown,RegExp][]=[
        [{[bin]:'../../../../evil.exe'},/escapes/],
        [{[bin]:path.join(outside,'evil.exe')},/absolute/],
        [{other:'bin/x.js'},new RegExp(`no "${bin}" bin`)],
        [{[bin]:'bin/missing.js'},/missing/],
        [{[bin]:'bin/tool.sh'},/unsupported bin type \.sh/],
        // Extensionless bins run through Node only with a node shebang.
        [{[bin]:'bin/shell'},/unsupported bin type \(none\)/],
        [{[bin]:'bin/plain'},/unsupported bin type \(none\)/],
        [{[bin]:'bin'},/not a file/],
        [42,new RegExp(`no "${bin}" bin`)]
      ];
      for(const [value,expected] of cases){
        const fixture=await npmPrefix(pkg,{name:pkg.name,bin:value},{'bin/tool.sh':'#!/bin/sh','bin/shell':'#!/bin/sh\nexit 0\n','bin/plain':'console.log(1)'});
        try{await assert.rejects(officialNpmLaunch(fixture.shim,pkg,withNode),expected);await assert.rejects(resolveNpmLaunch(fixture.shim,pkg,withNode),expected);}
        finally{await fs.rm(fixture.root,{recursive:true,force:true});}
      }
      // A different package name beside the shim is a custom launcher, preserved as-is.
      const other=await npmPrefix(pkg,{name:'not-'+bin,bin:{[bin]:'bin/x.exe'}},{'bin/x.exe':''});
      try{assert.equal(await resolveNpmLaunch(other.shim,pkg,noNode),other.shim);}finally{await fs.rm(other.root,{recursive:true,force:true});}
    }
  }finally{await fs.rm(outside,{recursive:true,force:true});}
});

test('Codex and Grok JS bins without a supported non-Electron Node fail clearly',windows,async()=>{
  for(const [pkg,manifest,files] of [[codexNpmPackage,codexManifest,{'bin/codex.js':codexScript}],[grokNpmPackage,grokManifest,grokFiles]] as const){
    const fixture=await npmPrefix(pkg,{...manifest,engines:{node:'>=99'}},files);
    try{
      await assert.rejects(resolveNpmLaunch(fixture.shim,pkg,noNode),new RegExp(`Official ${pkg.label} npm package bin .*requires Node\\.js >= 99\\.0\\.0.*no supported non-Electron Node\\.js runtime`));
      await assert.rejects(resolveNpmLaunch(fixture.shim,pkg,{currentRuntime:null,nodeCandidates:[process.execPath]}),/Node\.js >= 99/);
      await fs.writeFile(path.join(fixture.packageRoot,'package.json'),JSON.stringify(manifest));
      await assert.rejects(resolveNpmLaunch(fixture.shim,pkg,{currentRuntime:{execPath:process.execPath,versions:{node:'24.0.0',electron:'33.0.0'}},nodeCandidates:[],searchPath:false}),/non-Electron/);
    }finally{await fs.rm(fixture.root,{recursive:true,force:true});}
  }
});

test('Codex provider status, app-server and run use the official package bin with exact cwd and argv',windows,async()=>{
  const fixture=await npmPrefix(codexNpmPackage,codexManifest,{'bin/codex.js':codexScript});
  const state=await fs.mkdtemp(path.join(os.tmpdir(),'agent-codex-launch-state-'));
  const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'agent codex cwd & ^ '));
  const log=path.join(fixture.packageRoot,'bin','records.jsonl');
  try{await withEnv({CODEX_CLI:fixture.shim,CODEX_CLI_PATH:undefined,CODEX_ENABLED:'true',CODEX_MODEL:'auto',CODEX_EFFORT:'auto',AGENT_MCP_STATE_DIR:state},async()=>{
    const {CodexProvider}=await loadCodex();const provider=new CodexProvider();
    const status=await provider.status(true);
    assert.equal(status.available,true,status.reason);assert.equal(status.version,'codex-cli 9.9.9');assert.equal(status.authenticated,true);
    assert.equal(status.quota.source,'codex_app_server');assert.equal(status.quota.usedPercent,10);
    const result=await provider.run('agent_ask',selectedInput({task:'fixture',cwd}));
    assert.equal(result.error,null);assert.equal(result.text,'codex launch answer');assert.equal(result.sessionId,'codex-launch');
    const seen=await records(log);
    assert.deepEqual(seen.map(r=>r.args[0]).sort(),['--version','--version','app-server','app-server','exec','login'].sort());
    const exec=seen.find(r=>r.args[0]==='exec');
    assert.deepEqual(exec.args,['exec','--ignore-user-config','--sandbox','read-only','-c','windows.sandbox="unelevated"','--json','-c','mcp_servers={}','-c','features.plugins=false','--model','fixture-model','-c','model_reasoning_effort="high"','-']);
    same(exec.cwd,cwd);
    // The app-server reader accepts the same descriptor directly.
    const launch=await resolveNpmLaunch(fixture.shim,codexNpmPackage,withNode);
    const live=await readCodexStatus(launch);assert.equal(live.account.account.email,'person@example.test');
  });}finally{for(const dir of [fixture.root,state,cwd])await fs.rm(dir,{recursive:true,force:true});}
});

test('Codex cancellation through an npm Node descriptor stops the whole process tree',windows,async()=>{
  const fixture=await npmPrefix(codexNpmPackage,codexManifest,{'bin/codex.js':codexScript});
  const state=await fs.mkdtemp(path.join(os.tmpdir(),'agent-codex-cancel-state-'));
  const log=path.join(fixture.packageRoot,'bin','records.jsonl');
  try{await withEnv({CODEX_CLI:fixture.shim,CODEX_CLI_PATH:undefined,CODEX_ENABLED:'true',CODEX_MODEL:'auto',CODEX_EFFORT:'auto',AGENT_MCP_STATE_DIR:state},async()=>{
    const {CodexProvider}=await loadCodex();const controller=new AbortController();
    const running=new CodexProvider().run('agent_ask',selectedInput({task:'HANG_FIXTURE',cwd:state}, 'codex'),controller.signal);
    const grandchild=await waitFor(async()=>(await records(log)).find(r=>r.grandchild)?.grandchild as number|undefined);
    assert.equal(alive(grandchild),true);
    controller.abort('cancelled');
    const result=await running;
    assert.equal(result.errorKind,'cancelled');
    await waitFor(async()=>alive(grandchild)?undefined:true,5000);
  });}finally{for(const dir of [fixture.root,state])await fs.rm(dir,{recursive:true,force:true});}
});

test('Codex custom batch wrapper is refused for a UNC task cwd before spawn',windows,async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'agent codex custom '));
  const state=await fs.mkdtemp(path.join(os.tmpdir(),'agent-codex-unc-state-'));
  const marker=path.join(directory,'ran.txt'),wrapper=path.join(directory,'codex-wrapper.cmd');
  await fs.writeFile(wrapper,`@echo off\r\necho ran>>"${marker}"\r\n`);
  try{await withEnv({CODEX_CLI:wrapper,CODEX_CLI_PATH:undefined,CODEX_ENABLED:'true',AGENT_MCP_STATE_DIR:state},async()=>{
    const {CodexProvider}=await loadCodex();
    const result=await new CodexProvider().run('agent_implement',selectedInput({task:'fixture',cwd:uncCwd}, 'codex'));assert.match(result.error??'',/UNC working directory/);assert.ok(result.selection);
    await assert.rejects(fs.stat(marker),{code:'ENOENT'});
  });}finally{for(const dir of [directory,state])await fs.rm(dir,{recursive:true,force:true});}
});

function grokDependencies(stateRoot:string,launch:()=>Promise<LaunchCommand>):RunGrokDependencies{
  return {
    ensureHealth:async()=>({healthy:true,version:'fixture',fingerprint:'fixture',checkedAt:new Date().toISOString(),model:'fixture-model',effort:'xhigh',notices:[]}),
    getWeeklyUsage:async()=>({status:'unavailable',fresh:false,source:'unavailable',stale:true}),
    launch,stateRoot,
  };
}

test('Grok ACP and session usage run through the official npm bin with exact cwd and argv',windows,async()=>{
  const fixture=await npmPrefix(grokNpmPackage,grokManifest,grokFiles);
  const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'agent grok cwd & ^ '));
  const log=path.join(fixture.packageRoot,'bin','records.jsonl');
  try{
    const result=await runGrok('grok_ask',selectedInput({cwd,task:'fixture'}, 'grok'),undefined,undefined,grokDependencies(path.join(fixture.root,'state'),()=>resolveGrokLaunch(fixture.shim,withNode)));
    assert.equal(result.error,null);assert.equal(result.text,'launch fixture answer');
    assert.equal('childCleanedUp' in result&&result.childCleanedUp,true);
    assert.deepEqual('usage' in result&&result.usage,{status:'available',sessionId:'launch-session',inputTokens:5,outputTokens:2,reasoningTokens:1,totalTokens:8});
    const seen=await records(log);
    const acp=seen.find(r=>r.args[0]==='agent');
    assert.deepEqual(acp.args.filter((a:string)=>!a.endsWith('.md')),['agent','--no-leader','--model','fixture-model','--effort','xhigh','--agent-profile','stdio']);
    same(acp.cwd,await fs.realpath(cwd));
    assert.deepEqual(seen.find(r=>r.args[0]==='usage').args,['usage','launch-session']);
    await waitFor(async()=>alive(acp.pid)?undefined:true,5000);
  }finally{for(const dir of [fixture.root,cwd])await fs.rm(dir,{recursive:true,force:true});}
});

test('Grok ACP cancellation through the npm Node bootstrap cleans up the native child',windows,async()=>{
  const fixture=await npmPrefix(grokNpmPackage,grokManifest,grokFiles);
  const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'agent-grok-cancel-'));
  const log=path.join(fixture.packageRoot,'bin','records.jsonl');
  try{
    const controller=new AbortController();
    const result=await runGrok('grok_ask',selectedInput({cwd,task:'HANG_FIXTURE'}, 'grok'),controller.signal,{onActivity:event=>{if(event.updateType==='agent_message_chunk')controller.abort('cancelled');}},grokDependencies(path.join(fixture.root,'state'),()=>resolveGrokLaunch(fixture.shim,withNode)));
    assert.equal(result.errorKind,'cancelled');assert.equal(result.childCleanedUp,true);
    const acp=(await records(log)).find(r=>r.args[0]==='agent');
    await waitFor(async()=>alive(acp.pid)?undefined:true,5000);
  }finally{for(const dir of [fixture.root,cwd])await fs.rm(dir,{recursive:true,force:true});}
});

test('Grok custom batch wrapper still runs ACP and usage from a local cwd',windows,async()=>{
  const fixture=await npmPrefix(grokNpmPackage,grokManifest,grokFiles);
  const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'agent grok wrapper cwd '));
  const wrapper=path.join(fixture.packageRoot,'bin','company grok.cmd');
  await fs.writeFile(wrapper,`@echo off\r\n"${process.execPath}" "%~dp0native.js" %*\r\n`);
  const log=path.join(fixture.packageRoot,'bin','records.jsonl');
  try{
    assert.equal(await resolveGrokLaunch(wrapper,noNode),wrapper);
    const result=await runGrok('grok_ask',selectedInput({cwd,task:'fixture'}, 'grok'),undefined,undefined,grokDependencies(path.join(fixture.root,'state'),async()=>wrapper));
    assert.equal(result.error,null);assert.equal(result.text,'launch fixture answer');
    const acp=(await records(log)).find(r=>r.args[0]==='agent');
    assert.deepEqual(acp.args.filter((a:string)=>!a.endsWith('.md')),['agent','--no-leader','--model','fixture-model','--effort','xhigh','--agent-profile','stdio']);
    same(acp.cwd,await fs.realpath(cwd));
    assert.equal((await getSessionUsage('launch-session',wrapper,[],process.env) as any).totalTokens,8);
    // The same wrapper is refused for UNC before the ACP child could start.
    assert.throws(()=>spawnPlan(wrapper,['agent','stdio'],uncCwd),/UNC working directory/);
  }finally{for(const dir of [fixture.root,cwd])await fs.rm(dir,{recursive:true,force:true});}
});

test('Grok billing and CLI update resolve GROK_CLI npm shims through the package bin',windows,async()=>{
  const fixture=await npmPrefix(grokNpmPackage,grokManifest,grokFiles);
  const state=await fs.mkdtemp(path.join(os.tmpdir(),'agent-grok-launch-state-'));
  const log=path.join(fixture.packageRoot,'bin','records.jsonl');
  try{
    const grokUrl=new URL('../src/providers/grok.js',import.meta.url).href,billingUrl=new URL('../src/billing.js',import.meta.url).href;
    // runtime.ts reads GROK_CLI at import time, so exercise it in a fresh process.
    const script=`const {GrokProvider}=await import(${JSON.stringify(grokUrl)});const {fetchBilling}=await import(${JSON.stringify(billingUrl)});const update=await new GrokProvider().update();const billing=await fetchBilling();process.stdout.write(JSON.stringify({update,billing}));process.exit(0);`;
    const env={...process.env,GROK_CLI:fixture.shim,GROK_ENABLED:'true',AGENT_MCP_STATE_DIR:state};
    const stdout=await new Promise<string>((resolve,reject)=>execFile(process.execPath,['--input-type=module','--eval',script],{env,windowsHide:true,timeout:60000},(error,out,err)=>error?reject(Error(`${error.message}\n${err}`)):resolve(out)));
    const {update,billing}=JSON.parse(stdout);
    assert.equal(update.updated,false);assert.equal(update.error,'Grok update exited with code 7');assert.equal(update.stdout,'UPDATE_RAN');
    assert.equal(billing.config.creditUsagePercent,25);
    const seen=await records(log);
    assert.deepEqual(seen.find(r=>r.args[0]==='update').args,['update']);
    assert.deepEqual(seen.find(r=>r.args[0]==='agent').args,['agent','--no-leader','stdio']);
  }finally{for(const dir of [fixture.root,state])await fs.rm(dir,{recursive:true,force:true});}
});
