import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {AgentRouter} from '../src/router.js';
import {providerChildEnv,safeChildEnv,delegationKey} from '../src/process.js';
test('delegated child marker is inherited and blocks further routing and CLI maintenance',async()=>{
 const env=providerChildEnv();assert.equal(env[delegationKey],'1');assert.equal(env.OPENAI_API_KEY,undefined);
 const child=spawnSync(process.execPath,['-e',`process.stdout.write(process.env.${delegationKey}||'missing')`],{env,windowsHide:true,encoding:'utf8'});
 assert.equal(child.status,0);assert.equal(child.stdout,'1');
 const previous=process.env[delegationKey];process.env[delegationKey]='1';
 try{
  assert.equal(safeChildEnv({[delegationKey]:'0'})[delegationKey],'1');
  const router=new AgentRouter([]),host={host:'codex' as const,clientName:'codex'};
  await assert.rejects(()=>router.plan('codex',host,false,true),/NESTED_DELEGATION_BLOCKED/);
  await assert.rejects(()=>router.cliUpdate('claude',host),/NESTED_DELEGATION_BLOCKED/);
  const status=await router.status(host,false,true);assert.equal(status.providers.codex.blocked_reason,'nested_delegation_blocked');
 }finally{if(previous===undefined)delete process.env[delegationKey];else process.env[delegationKey]=previous;}
});
