import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {resolveExecutable,runCommand} from '../src/process.js';
test('Windows discovery skips the npm POSIX shim and runs its cmd sibling',{skip:process.platform!=='win32'},async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'agent-cli-discovery-'));
 const key=Object.keys(process.env).find(key=>key.toLowerCase()==='path')??'PATH';
 const previous=process.env[key];
 try{
  await fs.writeFile(path.join(directory,'fixture-agent'),'#!/bin/sh\nexit 1');
  await fs.writeFile(path.join(directory,'fixture-agent.cmd'),'@echo off\r\necho DISCOVERY_OK\r\n');
  process.env[key]=`${directory}${path.delimiter}${previous??''}`;
  const command=await resolveExecutable(undefined,['fixture-agent']);
  assert.equal(command,path.join(directory,'fixture-agent.cmd'));
  const result=await runCommand(command!,[],{timeoutMs:5000});
  assert.equal(result.code,0);assert.equal(result.stdout.trim(),'DISCOVERY_OK');
 }finally{
  if(previous===undefined)delete process.env[key];else process.env[key]=previous;
  await fs.unlink(path.join(directory,'fixture-agent'));await fs.unlink(path.join(directory,'fixture-agent.cmd'));await fs.rmdir(directory);
 }
});
