import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readCodexStatus} from '../src/codex-app-server.js';
test('Codex account and quota requests fail independently without running a model',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex account fixture '));
 try{for(const fail of ['none','account','limits']){
  const server=`import readline from 'node:readline';for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);if(!m.id)continue;const key=m.method==='account/read'?'account':m.method==='account/rateLimits/read'?'limits':'init';if(key==='account'&&m.params.refreshToken!==false)throw Error('unexpected refresh');const response=key===${JSON.stringify(fail)}?{error:{code:-1,message:'fixture failure'}}:{result:key==='account'?{account:{type:'chatgpt',email:'person@example.test'}}:key==='limits'?{rateLimits:{primary:{usedPercent:12}}}:{}};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,...response})+'\\n');}`;
  await fs.writeFile(path.join(dir,'server.mjs'),server);
  const cmd=path.join(dir,process.platform==='win32'?'cli.cmd':'cli.sh');
  await fs.writeFile(cmd,process.platform==='win32'?`@echo off\r\n"${process.execPath}" "%~dp0server.mjs"\r\n`:`#!/bin/sh\n"${process.execPath}" "$(dirname "$0")/server.mjs"\n`);if(process.platform!=='win32')await fs.chmod(cmd,0o755);
  const value=await readCodexStatus(cmd);
  if(fail==='account')assert.equal(value.account,null);else assert.equal(value.account.account.email,'person@example.test');
  if(fail==='limits')assert.equal(value.limits,null);else assert.equal(value.limits.rateLimits.primary.usedPercent,12);
 }}finally{await fs.rm(dir,{recursive:true,force:true});}
});


