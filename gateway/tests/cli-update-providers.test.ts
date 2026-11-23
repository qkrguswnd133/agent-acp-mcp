import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import {cliUpdateEnvironment,createCliProviderUpdates} from '../src/cli-update-providers.js';
import {execFileSync} from 'node:child_process';
import type {ProviderName} from '../src/types.js';

test('native install environment passes the official Windows installer platform check', {skip:process.platform!=='win32'}, ()=>{
 const env=cliUpdateEnvironment(true);
 const shell=path.join(process.env.SystemRoot!,'System32','WindowsPowerShell','v1.0','powershell.exe');
 const output=execFileSync(shell,['-NoProfile','-Command',"if ($env:OS -ne 'Windows_NT') { exit 1 }; $env:CODEX_NON_INTERACTIVE"],{env,windowsHide:true,encoding:'utf8'});
 assert.equal(output.trim(),'true');
 assert.equal(env.OPENAI_API_KEY,undefined);
});

function fixture(provider:ProviderName,method:'native'|'npm'|'desktop'|'unknown',options:{unchanged?:boolean;offline?:boolean;alternate?:boolean;directory?:string}={}){
 const directory=options.directory??os.tmpdir(),selected=path.join(directory,provider);
 const command={command:selected},npm={command:path.join(directory,'node'),argsPrefix:[path.join(directory,'npm-cli.js')]};
 const log:{command:string,args:string[],install:boolean}[]=[];
 let installed='1.1.0',updated=false,resolutions=0,verifying=false;
 const api=createCliProviderUpdates({
   resolve:async()=>{resolutions++;return {path:updated&&options.alternate?path.join(directory,'another',provider):selected,real:selected,launch:command,method,processPaths:[selected],npm,prefix:directory,packageRoot:directory,packageVersion:installed};},
   metadata:async url=>{if(options.offline)throw Error('offline test');if(url.startsWith('https://releases.openai.com/'))return '{"tag_name":"rust-v1.2.0"}';
     if(url.startsWith('https://downloads.claude.ai/'))return '1.2.0';return '{"latest":"1.2.0","stable":"1.2.0"}';},
   run:async(launch,args,install=false)=>{
     log.push({command:typeof launch==='string'?launch:launch.command,args:[...args],install});
     if(install){updated=true;if(!options.unchanged)installed='1.2.0';return '';}
     if(args.includes('--help'))return provider==='grok'?'--check --json --version':'   update   Update this CLI';
     if(args.includes('--check'))return JSON.stringify({currentVersion:installed,latestVersion:'1.2.0',installer:method==='native'?'internal':'npm',channel:'stable'});
     return provider==='codex'?'codex-cli '+installed:provider==='grok'?'grok '+installed:installed+' (Claude Code)';
   },
 });
 return {...api,log,prefix:directory,observations:()=>({resolutions,verifying}),verify:async()=>{verifying=true;}};
}
test('list uses read-only queries for all three providers; native installs re-resolve and verify',async()=>{
 for(const provider of ['codex','grok','claude'] as const){
   const f=fixture(provider,'native'),row=await f.inspectCli(provider);
   assert.equal(row.status,'available');assert.equal(row.currentVersion,'1.1.0');assert.equal(row.latestVersion,'1.2.0');
   assert.ok(f.log.every(call=>!call.install));
   if(provider==='grok')assert.ok(f.log.some(call=>call.args.join(' ')==='update --check --json'));
   const result=await f.applyCli(provider,row,f.verify);
   assert.equal(result.status,'current');assert.equal(result.currentVersion,'1.2.0');assert.deepEqual(f.observations(),{resolutions:3,verifying:true});
   assert.deepEqual(f.log.filter(call=>call.install).map(call=>call.args),[provider==='grok'?['update','--version','1.2.0']:['update']]);
 }
});
test('npm installation pins the package version and exact selected prefix',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cli-package-prefix-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const f=fixture('codex','npm',{directory}),row=await f.inspectCli('codex');assert.equal(row.status,'available');
 assert.equal((await f.applyCli('codex',row)).status,'current');
 const [install]=f.log.filter(call=>call.install);
 assert.equal(install.args[install.args.indexOf('--prefix')+1],f.prefix);assert.equal(install.args.at(-1),'@openai/codex@1.2.0');
});
test('exit zero cannot confirm an unchanged version or different installation',async()=>{
 for(const options of [{unchanged:true},{alternate:true}]){
   const f=fixture('codex','native',options);const row=await f.inspectCli('codex');
   assert.equal((await f.applyCli('codex',row)).status,'error');
 }
});
test('stale selections, offline metadata, unknown wrappers and desktop installs never run install',async()=>{
 const f=fixture('codex','native');const row=await f.inspectCli('codex');
 assert.equal((await f.applyCli('codex',{...row,path:'another'})).status,'error');
 assert.equal((await f.applyCli('codex',{...row,latestVersion:'1.3.0'})).status,'error');
 assert.equal(f.log.some(call=>call.install),false);
 const offline=fixture('codex','native',{offline:true});
 const failure=await offline.inspectCli('codex');assert.equal(failure.status,'error');assert.equal(failure.currentVersion,'1.1.0');
 for(const method of ['unknown','desktop'] as const){
   const manual=fixture('codex',method);const result=await manual.inspectCli('codex');assert.equal(result.status,'manual');
   assert.equal((await manual.applyCli('codex',result)).status,'manual');assert.ok(manual.log.every(call=>!call.install));
   if(method==='unknown')assert.equal(manual.log.length,0);
 }
});

test('Gateway explicit selection wins over a second installation on PATH',async t=>{
 const {execFile}=await import('node:child_process');
 const {promisify}=await import('node:util');
 const win=process.platform==='win32',root=await fs.mkdtemp(path.join(os.tmpdir(),'agent-cli-selection-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 async function install(name:string,release:string){
   const prefix=path.join(root,name),bin=win?prefix:path.join(prefix,'bin');
   const pkg=path.join(prefix,win?'':'lib','node_modules','@openai','codex');
   await fs.mkdir(bin,{recursive:true});await fs.mkdir(pkg,{recursive:true});
   await fs.writeFile(path.join(pkg,'package.json'),JSON.stringify({name:'@openai/codex',bin:{codex:'cli.js'},version:release}));
   const entry=path.join(pkg,'cli.js');
   await fs.writeFile(entry,'#!/usr/bin/env node\nconsole.log("codex-cli '+release+'")\n',{mode:0o755});
   const shim=path.join(bin,win?'codex.cmd':'codex');
   if(win)await fs.writeFile(shim,'@exit /b 1\r\n');else await fs.symlink(entry,shim);
   return {bin,shim};
 }
 const selected=await install('selected','1.1.0'),other=await install('other','1.9.0');
 const env={...process.env,HOME:root,USERPROFILE:root,CODEX_CLI:selected.shim};
 const pathKey=Object.keys(env).find(k=>k.toLowerCase()==='path')??'PATH';
 (env as NodeJS.ProcessEnv)[pathKey]=other.bin+path.delimiter+(env as NodeJS.ProcessEnv)[pathKey];
 const module=new URL('../src/cli-update-providers.js',import.meta.url).href;
 const script='globalThis.fetch=async()=>new Response(JSON.stringify({latest:"2.0.0"}));const {inspectCli}=await import('+JSON.stringify(module)+');console.log(JSON.stringify(await inspectCli("codex")))';
 const out=await promisify(execFile)(process.execPath,['--input-type=module','-e',script],{env,cwd:root,timeout:30000,windowsHide:true});
 const row=JSON.parse(out.stdout);
 assert.equal(row.path,selected.shim);assert.equal(row.method,'npm');assert.equal(row.currentVersion,'1.1.0');assert.equal(row.status,'available');
});
