#!/usr/bin/env node
/** Real signed package / real Gateway smoke. Runs entirely in a disposable Linux HOME. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {verifyManifest,compareVersions} from '../distribution/linux/updater.mjs';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const options={};for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i];if(!['--package-dir','--report'].includes(key)||!process.argv[i+1])throw Error('Usage: node tests/Smoke-Linux.mjs --package-dir ABSOLUTE_ASSET_DIRECTORY [--report ABSOLUTE_JSON_PATH]');options[key.slice(2)]=process.argv[i+1];}
if(process.platform!=='linux')throw Error('Run this smoke test inside native Linux or WSL');
if(compareVersions(process.versions.node,'24.0.0')<0)throw Error('Use Linux Node 24 or newer for release smoke validation');
if(!options['package-dir']||!path.isAbsolute(options['package-dir']))throw Error('--package-dir must be absolute');
if(options.report&&!path.isAbsolute(options.report))throw Error('--report must be absolute');
const packageDir=options['package-dir'];
const manifest=verifyManifest(await fs.readFile(path.join(packageDir,'linux-update-manifest.json')),await fs.readFile(path.join(packageDir,'linux-update-manifest.sig'),'utf8'),await fs.readFile(path.join(repo,'distribution/linux/trusted-key.pem'),'utf8'));
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'agent-linux-signed-smoke-'));
const home=path.join(temp,'home'),installRoot=path.join(temp,'gateway'),state=path.join(temp,'state');
const report={schemaVersion:1,status:'running',platform:process.platform,architecture:process.arch,node:process.versions.node,version:manifest.version,gatewayVersion:manifest.components.gateway,asset:manifest.asset,checks:[],startedAt:new Date().toISOString()};
const sessions=[];
const env={...process.env,HOME:home,XDG_DATA_HOME:path.join(home,'.local/share'),XDG_STATE_HOME:path.join(home,'.local/state'),XDG_CONFIG_HOME:path.join(home,'.config'),AGENT_MCP_STATE_DIR:state,AGENT_MCP_WORKTREE_DIR:path.join(temp,'worktrees'),GROK_ENABLED:'false',CLAUDE_ENABLED:'false',CODEX_ENABLED:'false',ALLOW_SELF_PROVIDER:'false',GROK_DISABLE_AUTOUPDATER:'1',DISABLE_AUTOUPDATER:'1',PATH:path.dirname(process.execPath)+':/usr/local/bin:/usr/bin:/bin'};
for(const key of Object.keys(env))if(/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)||/^(?:CODEX_HOME|CLAUDE_CONFIG_DIR|GROK_HOME)$/.test(key))delete env[key];
const run=async(script,args)=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[script,...args,'--json','--install-dir',installRoot,'--state-dir',state],{env,cwd:temp,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';const timeout=setTimeout(()=>{child.kill('SIGTERM');reject(Error('Isolated updater smoke command timed out'));},60_000);
  child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.once('error',e=>{clearTimeout(timeout);reject(e);});child.once('close',code=>{clearTimeout(timeout);let records=[];try{records=stdout.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch(e){reject(Error('Invalid updater JSON output: '+e.message));return;}if(code!==0)reject(Error(`Updater exited ${code}: ${records.at(-1)?.error||stderr}`));else resolve({records,result:records.at(-1)});});
});
const readResult=response=>{assert.notEqual(response.isError,true,JSON.stringify(response));const text=response.content?.find(item=>item.type==='text')?.text;assert.ok(text);return JSON.parse(text);};
async function connectGateway(){
  const base=path.join(installRoot,'node_modules/@modelcontextprotocol/client/dist');const {Client}=await import(pathToFileURL(path.join(base,'index.mjs')).href),{StdioClientTransport}=await import(pathToFileURL(path.join(base,'stdio.mjs')).href);
  const client=new Client({name:'codex-linux-signed-package-smoke',version:'1.0.0'}),transport=new StdioClientTransport({command:process.execPath,args:[path.join(installRoot,'dist/src/index.js')],env,stderr:'pipe'});
  const session={client,transport,closed:false,errors:[]};client.onclose=()=>{session.closed=true;};client.onerror=error=>session.errors.push(String(error.message||error));sessions.push(session);await client.connect(transport);assert.equal(client.getServerVersion()?.version,manifest.components.gateway);
  const tools=await client.listTools();for(const name of ['agent_status','agent_models','agent_job_status','agent_job_wait','agent_worktree_list'])assert.ok(tools.tools.some(tool=>tool.name===name),`Missing ${name}`);
  const status=readResult(await client.callTool({name:'agent_status',arguments:{}}));assert.equal(typeof status.host==='string'?status.host:status.host.host,'codex');for(const provider of Object.values(status.providers)){assert.equal(provider.enabled,false);assert.equal(provider.callable,false);}
  return session;
}
try{
  await fs.mkdir(home,{recursive:true});
  const bootstrap=path.join(repo,'distribution/linux/updater.mjs');
  let step=await run(bootstrap,['install','--package-dir',packageDir]);assert.equal(step.result.status,'installed');assert.equal(step.result.version,manifest.version);report.checks.push('signed first installation');
  const updater=path.join(installRoot,'linux/updater.mjs');
  step=await run(updater,['status']);assert.equal(step.result.currentVersion,manifest.version);assert.equal(step.result.stateDirectory,state);assert.equal(step.result.installed,true);report.checks.push('installed updater status and recorded paths');
  const id=crypto.randomUUID(),stamp=new Date().toISOString();const job={job_id:id,kind:'agent_ask',cwd:temp,ownerPid:process.pid,status:'completed',startedAt:stamp,lastActivityAt:stamp,finishedAt:stamp,result:{text:'ISOLATED_JOB_SENTINEL',outcome:'success',results:[]}};
  await fs.mkdir(path.join(state,'jobs'),{recursive:true});await fs.writeFile(path.join(state,'jobs',id+'.json'),JSON.stringify(job));const originalJob=await fs.readFile(path.join(state,'jobs',id+'.json'));await fs.mkdir(path.join(home,'.codex'),{recursive:true});const settings='model = "fixture-model"\n# Preserve this setting\n';await fs.writeFile(path.join(home,'.codex/config.toml'),settings);
  const first=await connectGateway();const jobStatus=readResult(await first.client.callTool({name:'agent_job_status',arguments:{job_id:id}}));assert.equal(jobStatus.status,'completed');assert.equal(jobStatus.result.text,'ISOLATED_JOB_SENTINEL');report.checks.push('real MCP handshake, host, disabled providers and saved job lookup');
  const receiptFile=path.join(state,'installations/gateway.json'),receipt=JSON.parse(await fs.readFile(receiptFile));receipt.version='0.0.0';await fs.writeFile(receiptFile,JSON.stringify(receipt));
  step=await run(updater,['update','--check','--package-dir',packageDir]);assert.equal(step.result.status,'available');assert.equal(step.result.gatewayVersion,manifest.components.gateway);report.checks.push('distribution-only update with unchanged component version');
  const oldPid=first.transport.pid;assert.ok(oldPid);step=await run(updater,['update','--package-dir',packageDir]);assert.equal(step.result.status,'installed');assert.ok(step.result.backup);assert.ok(await fs.stat(step.result.backup));
  const closeDeadline=Date.now()+5000;while(!first.closed&&Date.now()<closeDeadline)await new Promise(resolve=>setTimeout(resolve,25));assert.equal(first.closed,true,'Idle Gateway did not close for maintenance');await first.client.close().catch(()=>{});report.checks.push('real idle Gateway maintenance acknowledgement and graceful exit');
  assert.deepEqual(await fs.readFile(path.join(state,'jobs',id+'.json')),originalJob);assert.equal(await fs.readFile(path.join(home,'.codex/config.toml'),'utf8'),settings);
  const second=await connectGateway();assert.equal(readResult(await second.client.callTool({name:'agent_job_status',arguments:{job_id:id}})).result.text,'ISOLATED_JOB_SENTINEL');await second.client.close();report.checks.push('updated Gateway restart with settings and job preservation');
  step=await run(updater,['rollback']);assert.equal(step.result.status,'rolled_back');assert.equal(step.result.version,'0.0.0');assert.deepEqual(await fs.readFile(path.join(state,'jobs',id+'.json')),originalJob);assert.equal(await fs.readFile(path.join(home,'.codex/config.toml'),'utf8'),settings);assert.equal(JSON.parse(await fs.readFile(path.join(installRoot,'agent-acp-installation.json'))).stateRoot,state);
  const third=await connectGateway();assert.equal(readResult(await third.client.callTool({name:'agent_job_status',arguments:{job_id:id}})).result.text,'ISOLATED_JOB_SENTINEL');await third.client.close();report.checks.push('safe rollback retains external state and Gateway can read newest job history');
  const history=(await fs.readFile(path.join(state,'updates/history.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.ok(history.some(entry=>entry.status==='installed'));assert.ok(history.some(entry=>entry.status==='rolled_back'));report.checks.push('installation and rollback history');
  report.status='passed';
}catch(e){report.status='failed';report.error=e.message;process.exitCode=1;}
finally{
  for(const session of sessions)await session.client.close().catch(()=>{});
  report.finishedAt=new Date().toISOString();
  if(options.report){await fs.mkdir(path.dirname(options.report),{recursive:true});await fs.writeFile(options.report,JSON.stringify(report,null,2)+'\n');}
  console.log(JSON.stringify(report,null,2));await fs.rm(temp,{recursive:true,force:true});
}
