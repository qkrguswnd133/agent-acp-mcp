import './isolated-environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('idle gateway stays alive with host stdin open and exits promptly on EOF without provider calls',{timeout:60000},async()=>{
 const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),root=await fs.mkdtemp(path.join(os.tmpdir(),'gateway-idle-lifecycle-')),gateway=path.join(root,'gateway');
 let child:ReturnType<typeof spawn>|undefined;
 try{
  await fs.mkdir(path.join(gateway,'dist'),{recursive:true});
  // All writable/removable test objects are owned copies, never junctions to
  // the actual checkout or its dependency tree.
  await fs.cp(path.join(source,'dist/src'),path.join(gateway,'dist/src'),{recursive:true});
  await fs.cp(path.join(source,'node_modules'),path.join(gateway,'node_modules'),{recursive:true,filter:async source=>!(await fs.lstat(source)).isSymbolicLink()});
  await fs.writeFile(path.join(gateway,'package.json'),'{"type":"module"}');
  child=spawn(process.execPath,[path.join(gateway,'dist/src/index.js')],{cwd:gateway,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,GROK_ENABLED:'false',CLAUDE_ENABLED:'false',CODEX_ENABLED:'false',AGENT_MCP_STATE_DIR:path.join(root,'state')}});
  let stderr='';child.stderr!.on('data',value=>{stderr+=String(value);});child.stdout!.on('data',()=>{});
  const exited=new Promise<number|null>((resolve,reject)=>{child!.once('exit',resolve);child!.once('error',reject);});
  const startupDeadline=Date.now()+15_000;
  while(!stderr.includes('agent_bridge_start')&&Date.now()<startupDeadline){assert.equal(child.exitCode,null,stderr);assert.equal(child.signalCode,null,stderr);await new Promise(resolve=>setTimeout(resolve,25));}
  assert.match(stderr,/agent_bridge_start/);
  await new Promise(resolve=>setTimeout(resolve,200));assert.equal(child.exitCode,null,stderr);
  child.stdin!.end();let timeout:NodeJS.Timeout|undefined;
  try{assert.equal(await Promise.race([exited,new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(Error('Idle gateway missed EOF: '+stderr)),5000);})]),0,stderr);}finally{clearTimeout(timeout);}
 }finally{
  if(child?.exitCode===null){const exited=new Promise(resolve=>child!.once('exit',resolve));child.kill();await exited;}
  await fs.rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});
 }
});
