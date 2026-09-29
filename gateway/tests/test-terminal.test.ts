import test from 'node:test';
import assert from 'node:assert/strict';
import {TestTerminal} from '../src/test-terminal.js';
import {Policy} from '../src/policy.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
test('implementation default shell and Windows batch wrappers execute local verification',async()=>{
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'terminal shell fixture '));
 try{
  const safe=await new Policy(cwd,true).command(process.platform==='win32'?"Write-Output 'SHELL_OK'":"printf SHELL_OK");
  const terminal=new TestTerminal(safe.command,safe.args,cwd,Date.now()+15000,new AbortController().signal,()=>{});
  await terminal.done;assert.equal(terminal.record.exitCode,0);assert.match(terminal.record.output,/SHELL_OK/);
  if(process.platform==='win32'){
   const file=path.join(cwd,'test-wrapper.cmd');await fs.writeFile(file,'@echo off\r\necho WRAPPER_OK\r\nexit /b 3\r\n');
   const batch=new TestTerminal(file,[],cwd,Date.now()+5000,new AbortController().signal,()=>{});await batch.done;
   assert.equal(batch.record.exitCode,3);assert.match(batch.record.output,/WRAPPER_OK/);
  }
 }finally{await fs.rm(cwd,{recursive:true,force:true});}
});
test('terminal returns immediately, captures actual failure and bounds output',async()=>{
 const terminal=new TestTerminal(process.execPath,['-e','setTimeout(()=>{console.log("x".repeat(3000));process.exit(7)},100)'],process.cwd(),Date.now()+5000,new AbortController().signal,()=>{},undefined,1024);
 assert.equal(terminal.record.status,'running');await terminal.done;
 assert.equal(terminal.record.exitCode,7);assert.equal(terminal.record.truncated,true);assert.ok(terminal.record.output.length<=1024);
});
test('terminal observes deadline and cancellation without granting extra time',async()=>{
 const deadline=new TestTerminal(process.execPath,['-e','setTimeout(()=>{},60000)'],process.cwd(),Date.now()+100,new AbortController().signal,()=>{});
 await deadline.done;assert.equal(deadline.record.status,'deadline_exceeded');
 const controller=new AbortController();const terminal=new TestTerminal(process.execPath,['-e','setTimeout(()=>{},60000)'],process.cwd(),Date.now()+60000,controller.signal,()=>{});
 controller.abort();await terminal.done;assert.equal(terminal.record.status,'cancelled');
});
test('terminal reports missing executable without claiming an exit code',async()=>{
 const terminal=new TestTerminal('nonexistent-test-executable-82762',[],process.cwd(),Date.now()+1000,new AbortController().signal,()=>{});
 await terminal.done;assert.equal(terminal.record.status,'spawn_failed');assert.ok(terminal.record.output.includes('ENOENT'));
});
