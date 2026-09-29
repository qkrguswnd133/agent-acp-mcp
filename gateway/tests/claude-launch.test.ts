import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {officialClaudePackage,resolveClaudeLaunch} from '../src/claude-launch.js';
import {refreshClaudeCredentials} from '../src/claude-auth-refresh.js';
import {assertBatchCwdSupported,commandInvocation,isUncPath,runCommand,type LaunchCommand} from '../src/process.js';
import {TestTerminal} from '../src/test-terminal.js';

const windows={skip:process.platform!=='win32'};
const noNode:{currentRuntime:null;nodeCandidates:string[];searchPath:false}={currentRuntime:null,nodeCandidates:[],searchPath:false};

/** npm-style prefix: claude.cmd shim (which must never run) beside node_modules. */
async function npmPrefix(manifest:Record<string,unknown>,files:Record<string,string>={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'agent claude npm '));
  const packageRoot=path.join(root,'node_modules','@anthropic-ai','claude-code');
  await fs.mkdir(path.join(packageRoot,'bin'),{recursive:true});
  await fs.writeFile(path.join(packageRoot,'package.json'),JSON.stringify(manifest));
  for(const [name,content] of Object.entries(files)){await fs.mkdir(path.dirname(path.join(packageRoot,name)),{recursive:true});await fs.writeFile(path.join(packageRoot,name),content);}
  const shim=path.join(root,'claude.cmd');
  await fs.writeFile(shim,'@echo off\r\necho SHIM_MUST_NOT_RUN\r\nexit /b 9\r\n');
  return {root,packageRoot,shim};
}
const echoArgs=`process.stdout.write(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));`;

test('native non-batch launcher is returned unchanged',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'agent-claude-native-'));
  const native=path.join(directory,process.platform==='win32'?'claude.exe':'claude');
  try{
    await fs.writeFile(native,'');
    assert.equal(await resolveClaudeLaunch({explicit:native,candidates:[]}),native);
    assert.equal(await resolveClaudeLaunch({explicit:path.join(directory,'missing.exe'),candidates:[native],names:[]}),native);
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});
test('custom wrapper beside official npm package is preserved',windows,async()=>{
  const fixture=await npmPrefix({name:officialClaudePackage,bin:{claude:'bin/claude.exe'}},{'bin/claude.exe':''});
  try{
    const custom=path.join(fixture.root,'company-claude.cmd');await fs.writeFile(custom,'@echo off\r\necho CUSTOM\r\n');
    assert.equal(await resolveClaudeLaunch({explicit:custom,candidates:[],...noNode}),custom);
  }finally{await fs.rm(fixture.root,{recursive:true,force:true});}
});
test('direct batch invocation and ACP test terminals reject UNC before spawning',windows,()=>{
  const cwd='\\\\wsl.localhost\\Ubuntu\\tmp\\fixture';
  assert.throws(()=>commandInvocation('fixture.cmd',[],cwd),/UNC working directory/);
  assert.throws(()=>new TestTerminal('fixture.cmd',[],cwd,Date.now()+1000,new AbortController().signal,()=>{}),/UNC working directory/);
});

test('official npm shim with a native exe bin launches the exe directly',windows,async()=>{
  const fixture=await npmPrefix({name:officialClaudePackage,bin:{claude:'bin/claude.exe'},engines:{node:'>=22.0.0'}},{'bin/claude.exe':''});
  try{
    const launch=await resolveClaudeLaunch({explicit:fixture.shim,candidates:[],...noNode});
    assert.deepEqual(launch,{command:await fs.realpath(path.join(fixture.packageRoot,'bin','claude.exe')),argsPrefix:[],source:'official_npm_native'});
  }finally{await fs.rm(fixture.root,{recursive:true,force:true});}
});

test('official npm shim with a JS bin runs through genuine Node without a shell and keeps cwd and arguments',windows,async()=>{
  const fixture=await npmPrefix({name:officialClaudePackage,bin:{claude:'cli wrapper.mjs'},engines:{node:'>=18'}},{'cli wrapper.mjs':echoArgs});
  const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'agent claude cwd & ^ '));
  try{
    const launch=await resolveClaudeLaunch({explicit:fixture.shim,candidates:[],currentRuntime:{execPath:process.execPath,versions:process.versions},nodeCandidates:[],searchPath:false});
    assert.ok(launch&&typeof launch==='object');
    assert.equal(launch.command,process.execPath);assert.equal(launch.source,'official_npm_node');
    assert.deepEqual(launch.argsPrefix,[await fs.realpath(path.join(fixture.packageRoot,'cli wrapper.mjs'))]);
    const args=['-p','a b','quote"inside','amp&pipe|caret^','%PATH%','','trailing\\','{"mcpServers":{}}'];
    const result=await runCommand(launch,args,{cwd,timeoutMs:15000});
    assert.equal(result.code,0,result.stderr);
    const parsed=JSON.parse(result.stdout);
    assert.deepEqual(parsed.args,args);assert.equal(path.resolve(parsed.cwd).toLowerCase(),path.resolve(cwd).toLowerCase());
  }finally{await fs.rm(fixture.root,{recursive:true,force:true});await fs.rm(cwd,{recursive:true,force:true});}
});

test('malformed or out-of-package bin entries are refused instead of running the shim',windows,async()=>{
  const outside=await fs.mkdtemp(path.join(os.tmpdir(),'agent-claude-outside-'));
  await fs.writeFile(path.join(outside,'evil.exe'),'');
  const cases:[unknown,RegExp][]=[
    [{claude:'../../../../evil.exe'},/escapes/],
    [{claude:path.join(outside,'evil.exe')},/absolute/],
    [{other:'bin/claude.exe'},/no "claude" bin/],
    [{claude:'bin/missing.exe'},/missing/],
    [{claude:'bin/claude.sh'},/unsupported bin type/],
    [42,/no "claude" bin/]
  ];
  try{
    for(const [bin,expected] of cases){
      const fixture=await npmPrefix({name:officialClaudePackage,bin},{'bin/claude.sh':'#!/bin/sh'});
      try{await assert.rejects(resolveClaudeLaunch({explicit:fixture.shim,candidates:[],...noNode}),expected);}
      finally{await fs.rm(fixture.root,{recursive:true,force:true});}
    }
    // A different package beside a shim is a custom launcher, preserved as-is.
    const custom=await npmPrefix({name:'not-claude',bin:{claude:'bin/claude.exe'}},{'bin/claude.exe':''});
    try{assert.equal(await resolveClaudeLaunch({explicit:custom.shim,candidates:[],...noNode}),custom.shim);}
    finally{await fs.rm(custom.root,{recursive:true,force:true});}
  }finally{await fs.rm(outside,{recursive:true,force:true});}
});

test('JS bin without a supported non-Electron Node fails with a clear error',windows,async()=>{
  const fixture=await npmPrefix({name:officialClaudePackage,bin:{claude:'cli.js'},engines:{node:'>=99'}},{'cli.js':echoArgs});
  try{
    await assert.rejects(resolveClaudeLaunch({explicit:fixture.shim,candidates:[],...noNode}),/requires Node\.js >= 99\.0\.0.*no supported non-Electron Node\.js runtime/);
    // Current runtime is too old for engines >=99, and PATH candidates too.
    await assert.rejects(resolveClaudeLaunch({explicit:fixture.shim,candidates:[],nodeCandidates:[process.execPath]}),/Node\.js >= 99/);
    await fs.writeFile(path.join(fixture.packageRoot,'package.json'),JSON.stringify({name:officialClaudePackage,bin:{claude:'cli.js'},engines:{node:'>=18'}}));
    // Electron's execPath is never Node, even when it reports a Node version.
    await assert.rejects(resolveClaudeLaunch({explicit:fixture.shim,candidates:[],currentRuntime:{execPath:process.execPath,versions:{node:'22.0.0',electron:'33.0.0'}},nodeCandidates:[],searchPath:false}),/non-Electron/);
  }finally{await fs.rm(fixture.root,{recursive:true,force:true});}
});

test('batch launchers are refused before spawn for every UNC cwd form',windows,async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'agent-claude-unc-'));
  const cmd=path.join(directory,'custom claude.cmd');
  await fs.writeFile(cmd,'@echo off\r\necho SHOULD_NOT_RUN\r\n');
  try{
    for(const cwd of ['\\\\wsl.localhost\\Ubuntu\\home\\user','\\\\wsl$\\Ubuntu\\tmp','\\\\server\\share\\dir','//wsl.localhost/Ubuntu/home','//server/share']){
      assert.ok(isUncPath(cwd));
      for(const launch of [cmd,{command:cmd,argsPrefix:['x']},cmd.toUpperCase().replace(/\.CMD$/,'.BAT')] as LaunchCommand[]){
        let spawned=false;
        await assert.rejects(runCommand(launch,[],{cwd,onSpawn:()=>{spawned=true;}}),/UNC working directory/);
        assert.equal(spawned,false);
      }
    }
    assert.throws(()=>assertBatchCwdSupported('C:/x/claude.cmd','\\\\wsl$\\d','win32'),/UNC/);
    assert.doesNotThrow(()=>assertBatchCwdSupported('C:/x/claude.exe','\\\\wsl$\\d','win32'));
    assert.doesNotThrow(()=>assertBatchCwdSupported('/x/claude.cmd','//server/share','linux'));
    assert.equal(isUncPath('C:\\Users\\park'),false);assert.equal(isUncPath('/home/user'),false);
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});

test('local batch launchers still run with descriptor prefixes and local cwd',windows,async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'agent claude local '));
  const cmd=path.join(directory,'custom claude.cmd');
  await fs.writeFile(cmd,'@echo off\r\necho [%~1][%~2][%CD%]\r\n');
  try{
    const result=await runCommand({command:cmd,argsPrefix:['a b']},['c'],{cwd:directory,timeoutMs:10000});
    assert.equal(result.code,0,result.stderr);
    assert.equal(result.stdout.trim().toLowerCase(),`[a b][c][${directory}]`.toLowerCase());
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});

test('auth refresh passes the resolved descriptor with its prefix to every command',async()=>{
  const launch={command:process.execPath,argsPrefix:['C:/pkg/cli.js'],source:'official_npm_node'};
  const auth={loggedIn:true,email:'example@example.com',orgId:'org-a'};
  const seen:LaunchCommand[]=[];
  const run:typeof runCommand=async(command,args)=>{
    seen.push(command);
    if(args[0]==='-p')return {code:0,signal:null,timedOut:false,stderr:'',stdout:JSON.stringify({type:'control_response',response:{subtype:'success',request_id:'usage-auth-initialize'}})};
    return {code:0,signal:null,timedOut:false,stderr:'',stdout:JSON.stringify(auth)};
  };
  const {claudeUsageAccountKey}=await import('../src/claude-auth-refresh.js');
  await refreshClaudeCredentials(launch,claudeUsageAccountKey(auth),run);
  assert.equal(seen.length,2);for(const command of seen)assert.equal(command,launch);
});

test('Claude provider status uses the official package bin instead of the npm cmd shim',windows,async()=>{
  const script=`const a=process.argv.slice(2).join(' ');if(a==='--version')process.stdout.write('9.9.9 (Claude Code)');else if(a==='auth status')process.stdout.write(JSON.stringify({loggedIn:false}));else process.exit(3);`;
  const fixture=await npmPrefix({name:officialClaudePackage,bin:{claude:'bin/cli.mjs'},engines:{node:'>=18'}},{'bin/cli.mjs':script});
  const state=await fs.mkdtemp(path.join(os.tmpdir(),'agent-claude-launch-state-'));
  const keys=['CLAUDE_CLI','AGENT_MCP_STATE_DIR'] as const;const previous=keys.map(key=>process.env[key]);
  try{
    process.env.CLAUDE_CLI=fixture.shim;process.env.AGENT_MCP_STATE_DIR=state;
    const {ClaudeProvider}=await import(`${new URL('../src/providers/claude.js',import.meta.url).href}?launch=${Date.now()}`);
    const status=await new ClaudeProvider().status();
    assert.equal(status.available,true,status.reason);assert.equal(status.version,'9.9.9 (Claude Code)');assert.equal(status.authenticated,false);
  }finally{
    keys.forEach((key,i)=>{if(previous[i]===undefined)delete process.env[key];else process.env[key]=previous[i];});
    await fs.rm(fixture.root,{recursive:true,force:true});await fs.rm(state,{recursive:true,force:true});
  }
});
