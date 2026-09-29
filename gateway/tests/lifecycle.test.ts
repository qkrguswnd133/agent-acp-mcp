import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {terminate,childEnv} from '../src/acp.js';
test('child environment excludes API keys and arbitrary inherited credentials',()=>{
 assert.equal(childEnv.XAI_API_KEY,undefined);assert.equal(childEnv.AWS_SECRET_ACCESS_KEY,undefined);assert.equal(childEnv.NODE_OPTIONS,undefined);
 assert.equal(childEnv.GROK_DISABLE_AUTOUPDATER,'1');
});
test('cleanup waits for native process and descendant termination',async()=>{
 const p=spawn(process.execPath,['-e',"const {spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)"],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 const [chunk]=await once(p.stdout,'data');const childPid=Number(String(chunk).trim());
 assert.ok(childPid>0);assert.equal(await terminate(p),true);
 assert.ok(p.exitCode!==null||p.signalCode!==null);
 assert.throws(()=>process.kill(childPid,0));
});
