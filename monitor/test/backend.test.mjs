import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import readline from 'node:readline';
import {parseGatewayEnvironment,createMonitor,loadMonitor,sanitizeJob,readRuntimeQuota,normalizeQuota,normalizeAccount} from '../backend/monitor.mjs';

test('standalone config selects gateway without Codex and accepts only provider settings',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agent-monitor-install-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const gateway=path.join(dir,'custom gateway'),configFile=path.join(dir,'agent-monitor.config.json');
  await fs.mkdir(path.join(gateway,'state','jobs'),{recursive:true});
  await fs.writeFile(path.join(gateway,'state','jobs','11111111-1111-1111-1111-111111111111.json'),JSON.stringify({job_id:'11111111-1111-1111-1111-111111111111',cwd:'C:\\example',status:'completed'}));
  await fs.writeFile(configFile,JSON.stringify({gatewayRoot:gateway,env:{GROK_ENABLED:'false',CLAUDE_ENABLED:'false',CODEX_ENABLED:'false',GROK_MODEL:'local-policy',XAI_API_KEY:'not-accepted',MCP_HOST:'codex'}}));
  const env={GROK_MODEL:'explicit-policy'};
  const monitor=await loadMonitor({home:dir,env,configFile});const result=await monitor.status();
  assert.equal(result.jobs.length,1);assert.equal(result.providers.every(p=>!p.enabled),true);
  assert.equal(result.providers[0].modelPolicy,'explicit-policy');assert.equal(env.XAI_API_KEY,undefined);assert.equal(env.MCP_HOST,undefined);
});

test('default gateway uses neutral per-user Programs directory ahead of legacy installation',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agent-monitor-neutral-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const local=path.join(dir,'Local'),gateway=path.join(local,'Programs','Agent ACP MCP');
  await fs.mkdir(path.join(gateway,'state','jobs'),{recursive:true});
  await fs.mkdir(path.join(dir,'.codex','tools','agent-acp-mcp'),{recursive:true});
  await fs.writeFile(path.join(gateway,'state','jobs','22222222-2222-2222-2222-222222222222.json'),JSON.stringify({job_id:'22222222-2222-2222-2222-222222222222',cwd:'C:\\neutral-project',status:'completed'}));
  const monitor=await loadMonitor({home:dir,env:{LOCALAPPDATA:local,GROK_ENABLED:'false',CLAUDE_ENABLED:'false',CODEX_ENABLED:'false'},configFile:path.join(dir,'absent.json')});
  assert.equal((await monitor.status()).jobs[0].project,'neutral-project');
});

test('gateway env parser accepts only allowlisted settings within the exact table',()=>{
  const result=parseGatewayEnvironment(`[mcp_servers.other.env]\nGROK_MODEL="wrong"\n[mcp_servers.agent.env]\nGROK_MODEL="auto"\nCLAUDE_CLI='C:\\a\\claude.cmd'\nXAI_API_KEY="secret"\nMCP_HOST="codex"\nOTHER="oops"\n[other]\nGROK_EFFORT="wrong"`);
  assert.deepEqual(result,{GROK_MODEL:'auto',CLAUDE_CLI:'C:\\a\\claude.cmd'});
});
test('job summaries discard prompts, response text, raw events and unrelated usage fields',()=>{
  const job=sanitizeJob({job_id:'x',cwd:'C:\\dev\\sample-project',status:'failed',prompt:'secret',error:'token secret',result:{results:[{provider:'claude',model:'opus',effort:'high',sessionId:'s',text:'private response',rawEvents:'private',error:'error secret',errorKind:'quota_exhausted',usage:{input_tokens:4,output_tokens:2,prompt:'secret'}}]}});
  assert.equal(job.project,'sample-project');assert.deepEqual(job.providers[0].usage,{input_tokens:4,output_tokens:2});assert.equal(JSON.stringify(job).includes('secret'),false);assert.equal(JSON.stringify(job).includes('private'),false);
});
test('runtime cache reads preserve actual reset and discard legacy invented reset and expired blocks',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agent-monitor-cache-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'quota.json'),now=Date.parse('2026-09-22T00:00:00Z');
  await fs.writeFile(file,JSON.stringify({grok:{quota:{state:'exhausted',resetsAt:'2099-01-01T00:00:00Z'},blockedUntil:now+60000}}));
  let q=await readRuntimeQuota(file,'grok',now);assert.equal(q.resetsAt,null);assert.equal(q.retryAfter,'2026-09-22T00:01:00.000Z');
  assert.equal(await readRuntimeQuota(file,'grok',now+60001),null);
  const raw={schemaVersion:2,providers:{grok:{quota:{state:'exhausted',source:'runtime_limit_error'},limitKind:'rate_limited',resetsAt:null,retryAfter:now+60000,updatedAt:'2026-09-22T00:00:00Z'}}};
  await fs.writeFile(file,JSON.stringify(raw));q=await readRuntimeQuota(file,'grok',now);assert.equal(q.limitKind,'rate_limited');assert.equal(q.resetsAt,null);assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),raw);
});
test('snapshot uses billing only, deduplicates requests, preserves unknown and sanitizes failed lookup',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agent-monitor-status-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const command=path.join(dir,'grok.exe');await fs.writeFile(command,'fixture');await fs.mkdir(path.join(dir,'state'),{recursive:true});
  await fs.writeFile(path.join(dir,'state','health.json'),JSON.stringify({model:'grok-observed',effort:'xhigh',version:'old-version',checkedAt:'2026-09-21T00:00:00Z',auth:'cached_token',healthy:true,prompt:'private'}));
  let calls=0;const monitor=createMonitor({gatewayRoot:dir,home:dir,env:{GROK_CLI:command},getWeeklyUsage:async force=>{calls++;assert.equal(force,false);return {status:'available',fresh:true,stale:false,source:'acp_billing',creditUsagePercent:23,remainingPercent:77,timestamp:'2026-09-22T00:00:00Z',currentPeriod:{end:'2026-09-25T00:00:00Z'}};},adapters:{claude:{status:async force=>{assert.equal(force,false);throw Error('secret credentials');}},codex:{status:async()=>({enabled:true,available:true,authenticated:true,subscriptionAuth:true,version:'1',quota:{state:'unknown',source:'fixture'}})}}});
  const [a,b]=await Promise.all([monitor.status(),monitor.status()]);assert.equal(calls,1);assert.deepEqual(a,b);
  assert.equal(a.providers[0].quota.usedPercent,23);assert.equal(a.providers[0].modelSource,'last_known_health');assert.equal(a.providers[1].reason,'Status lookup unavailable');assert.equal(a.providers[2].quota.usedPercent,null);assert.equal(JSON.stringify(a).includes('secret'),false);
  for(const p of a.providers){assert.equal('callable' in p,false);assert.equal('host' in p,false);}
});
test('stale Grok log remains explicitly stale and does not confirm current authentication',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agent-monitor-stale-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const command=path.join(dir,'grok.exe');await fs.writeFile(command,'fixture');
  const monitor=createMonitor({gatewayRoot:dir,home:dir,env:{GROK_CLI:command,CLAUDE_ENABLED:'false',CODEX_ENABLED:'false'},getWeeklyUsage:async()=>({status:'available',fresh:false,stale:true,source:'log_fallback',creditUsagePercent:80,remainingPercent:20})});
  const {providers}=await monitor.status();assert.equal(providers[0].authenticated,'unknown');assert.equal(providers[0].quota.state,'unknown');assert.equal(providers[0].quota.stale,true);assert.equal(providers[0].quota.usedPercent,80);assert.equal(providers[1].enabled,false);
});
test('quota epoch seconds normalize without treating unknown values as zero',()=>{
  const q=normalizeQuota({resetsAt:1789999999});assert.equal(q.resetsAt,new Date(1789999999000).toISOString());assert.equal(q.usedPercent,null);assert.equal(q.remainingPercent,null);
});

test('account normalization accepts only current authenticated identity and allowlisted fields',()=>{
  const raw={status:'authenticated',email:'person@example.com',displayName:'Person',organization:'Example',source:'claude_cli_auth_status',observedAt:'2026-09-28T00:00:00Z',accessToken:'secret',accountId:'private'};
  assert.deepEqual(normalizeAccount(raw,true),{status:'authenticated',email:'person@example.com',username:null,displayName:'Person',organization:'Example',source:'claude_cli_auth_status',observedAt:'2026-09-28T00:00:00.000Z'});
  for(const value of [{...raw,stale:true},{...raw,fresh:false},{...raw,status:'unknown'}])assert.equal(normalizeAccount(value,true).email,null);
  assert.equal(normalizeAccount(raw,false).status,'unauthenticated');assert.equal(normalizeAccount(raw,'unknown').email,null);
  assert.equal(normalizeAccount({...raw,email:'Bearer secret',organization:'sk-ant-secret'},true).email,null);
});

test('provider snapshot drops identity when CLI status becomes unauthenticated or unknown',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agent-monitor-account-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const command=path.join(dir,'grok.exe');await fs.writeFile(command,'fixture');
  let grokAccount={status:'authenticated',email:'grok@example.com',organization:'Grok Team',source:'grok_acp_authenticate'};
  let claudeAuth=true;
  const monitor=createMonitor({gatewayRoot:dir,home:dir,env:{GROK_CLI:command,CODEX_ENABLED:'false'},getWeeklyUsage:async()=>({status:'available',fresh:true,source:'acp_billing',creditUsagePercent:5}),getGrokAccountStatus:async()=>grokAccount,adapters:{claude:{status:async()=>({enabled:true,available:true,authenticated:claudeAuth,account:{status:'authenticated',email:'claude@example.com',source:'claude_cli_auth_status'},quota:{state:'unknown'}})}}});
  let result=await monitor.status();assert.equal(result.providers[0].account.email,'grok@example.com');assert.equal(result.providers[1].account.email,'claude@example.com');assert.equal(JSON.stringify(result).includes('accessToken'),false);
  grokAccount={status:'unknown',email:'grok@example.com'};claudeAuth=false;result=await monitor.status();assert.equal(result.providers[0].account.email,null);assert.equal(result.providers[1].account.status,'unauthenticated');assert.equal(result.providers[1].account.email,null);
});

test('fresh Grok period without percentage stays unknown and explicit zero remains zero',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agent-monitor-reset-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const command=path.join(dir,'grok.exe');await fs.writeFile(command,'fixture');let percent;
  const monitor=createMonitor({gatewayRoot:dir,home:dir,env:{GROK_CLI:command,CLAUDE_ENABLED:'false',CODEX_ENABLED:'false'},getWeeklyUsage:async()=>({status:'available',fresh:true,stale:false,source:'acp_billing',creditUsagePercent:percent,remainingPercent:typeof percent==='number'?100-percent:undefined,currentPeriod:{end:'2026-09-29T14:24:01Z'}})});
  const missing=(await monitor.status()).providers[0];assert.equal(missing.authenticated,true);assert.equal(missing.quota.state,'unknown');assert.equal(missing.quota.usedPercent,null);assert.equal(missing.quota.unavailableReason,'missing_percentage');assert.match(missing.quota.note,/제공되지/);assert.equal(missing.quota.resetsAt,'2026-09-29T14:24:01.000Z');
  percent=0;const zero=(await monitor.status()).providers[0];assert.equal(zero.quota.usedPercent,0);assert.equal(zero.quota.remainingPercent,100);assert.equal(zero.quota.state,'available');assert.equal(zero.quota.unavailableReason,null);assert.equal(zero.quota.note,null);
});

test('Claude window details preserve usage source and observation time',()=>{
 const q=normalizeQuota({state:'available',source:'claude_oauth_usage',usedPercent:93,remainingPercent:7,selectedWindow:'five_hour',observedAt:'2026-09-22T07:00:00Z',windows:[{id:'five_hour',label:'5시간',usedPercent:93,remainingPercent:7,resetsAt:'2026-09-22T10:00:00Z'},{id:'seven_day',label:'주간',usedPercent:35,remainingPercent:65,resetsAt:'2026-09-28T01:00:00Z'}]});
 assert.equal(q.selectedWindow,'five_hour');assert.equal(q.windows[1].usedPercent,35);assert.equal(q.observedAt,'2026-09-22T07:00:00.000Z');assert.equal(q.stale,false);
});
test('Codex window details retain observed 5-hour and weekly usage without inventing missing balances',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agent-monitor-codex-windows-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const quota={state:'available',source:'codex_app_server',usedPercent:75,selectedWindow:'seven_day',windows:[{id:'five_hour',label:'5시간',usedPercent:13,resetsAt:1789999999},{id:'seven_day',label:'주간',usedPercent:75,remainingPercent:25,resetsAt:1790000000}]};
 const monitor=createMonitor({gatewayRoot:dir,home:dir,env:{GROK_ENABLED:'false',CLAUDE_ENABLED:'false'},adapters:{codex:{status:async()=>({enabled:true,available:true,authenticated:true,subscriptionAuth:true,version:'fixture',quota})}}});
 const codex=(await monitor.status()).providers[2];assert.equal(codex.quota.selectedWindow,'seven_day');assert.deepEqual(codex.quota.windows.map(w=>[w.id,w.usedPercent,w.remainingPercent]),[['five_hour',13,null],['seven_day',75,25]]);
 assert.equal(codex.quota.windows[0].resetsAt,new Date(1789999999000).toISOString());
});
test('worker protocol exposes only status and works with unavailable gateway and disabled providers',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agent-monitor-protocol-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const worker=spawn(process.execPath,[new URL('../backend/worker.mjs',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')],{env:{...process.env,CODEX_HOME:dir,AGENT_GATEWAY_ROOT:dir,GROK_ENABLED:'false',CLAUDE_ENABLED:'false',CODEX_ENABLED:'false'},stdio:['pipe','pipe','pipe'],windowsHide:true});
  t.after(()=>worker.kill());const lines=readline.createInterface({input:worker.stdout});const responses=[];
  const result=new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('worker did not respond')),5000);lines.on('line',line=>{responses.push(JSON.parse(line));if(responses.length===2){clearTimeout(timeout);resolve();}});worker.on('error',reject);});
  worker.stdin.write('{"id":1,"method":"run"}\n{"id":2,"method":"status"}\n');await result;
  assert.equal(responses.find(r=>r.id===1).error,'unsupported_method');assert.equal(responses.find(r=>r.id===2).result.providers.every(p=>p.enabled===false),true);
  worker.stdin.end();lines.close();
});
test('all provider job labels use original project while preserving actual isolated cwd',()=>{
 for(const provider of ['grok','claude','codex']){
  const cwd='C:\\Temp\\agent-acp-worktrees\\11111111-1111-1111-1111-111111111111';
  const job=sanitizeJob({job_id:'fixture',cwd,worktree:{originalCwd:'C:\\dev\\sample-project',path:cwd},status:'completed',result:{results:[{provider,error:null}]}});
  assert.equal(job.project,'sample-project');assert.equal(job.originalCwd,'C:\\dev\\sample-project');assert.equal(job.cwd,cwd);assert.equal(job.isolated,true);
 }
 const fallback=sanitizeJob({job_id:'fixture',cwd:'C:\\dev\\ordinary',worktree:{originalCwd:'relative'},status:'completed'});
 assert.equal(fallback.project,'ordinary');assert.equal(fallback.isolated,false);
});
