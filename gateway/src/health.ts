import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {Readable,Writable} from 'node:stream';
import {client,ndJsonStream,type ClientConnection} from '@agentclientprotocol/sdk';
import {root,childEnv,active,terminate,shuttingDown,grokLaunch,grokLaunchFingerprint,resetGrokLaunch} from './runtime.js';
import {runCommand,spawnPlan,type LaunchCommand} from './process.js';
import {modelPolicy,effortPolicy} from './config.js';
import {grokCatalog,catalogTtlMs,type ModelCatalog} from './model-catalog.js';

export interface Health {
  healthy:boolean;version:string;fingerprint:string;checkedAt:string;
  model:string;effort:string;notices:string[];reason?:string;protocolVersion?:number;
  modelCatalog?:ModelCatalog;
  auth?:string;subscriptionTier?:string;mcpSelfTest?:boolean;smoke?:any;
}
let memory:Health|undefined;
let memoryPolicy:string|undefined;
let inFlight:Promise<Health>|undefined;
let recheck=false;
let mcpTest:(()=>Promise<boolean>)|undefined;
export function setMcpSelfTest(test:()=>Promise<boolean>){mcpTest=test;}
export function cachedHealth(){return memory;}
export function markUnhealthy(reason:string){if(memory){memory={...memory,healthy:false,reason};recheck=true;}}
const fingerprint=grokLaunchFingerprint;
async function probe(launch:LaunchCommand){
 if(shuttingDown)throw Error('Bridge is shutting down');
 const cwd=path.join(root,'work/health');await fs.mkdir(cwd,{recursive:true});
 const args=['agent','--no-leader','--agent-profile',path.join(root,'profiles/read.md'),'stdio'];
 const invocation=spawnPlan(launch,args,cwd);
 const p=spawn(invocation.command,invocation.args,{cwd,env:childEnv,windowsHide:true,windowsVerbatimArguments:invocation.windowsVerbatimArguments,shell:false,stdio:['pipe','pipe','pipe']});active.add(p);p.stderr.on('data',()=>{});
 const app=client({name:'grok-compatibility-check'});
 let conn:ClientConnection|undefined;
 app.onRequest('session/request_permission',async()=>({outcome:{outcome:'cancelled'}}));
 conn=app.connect(ndJsonStream(Writable.toWeb(p.stdin) as WritableStream<Uint8Array>,Readable.toWeb(p.stdout) as ReadableStream<Uint8Array>));
 p.on('error',e=>conn?.close(e));
 const timer=setTimeout(()=>{conn?.close();void terminate(p);},30000);
 try{
  const init=await conn.agent.request('initialize',{protocolVersion:1,clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false},clientInfo:{name:'grok-compatibility-check',version:'1.0.0'}});
  if(init.protocolVersion!==1||!init.authMethods?.some(m=>m.id==='cached_token'))throw Error('ACP v1/cached_token compatibility check failed');
  const auth=await conn.agent.request('authenticate',{methodId:'cached_token'});
  if(auth._meta?.auth_mode!=='Oidc'||auth._meta?.backend_billed===true)throw Error('Subscription OAuth login not confirmed');
  return {init,auth};
 }finally{
  clearTimeout(timer);conn.close();p.stdin.end();
  await new Promise<void>(resolve=>{if(p.exitCode!==null||p.signalCode!==null)return resolve();const t=setTimeout(resolve,500);p.once('close',()=>{clearTimeout(t);resolve();});});
  const cleaned=await terminate(p);active.delete(p);
  if(!cleaned)throw Error('Compatibility check child cleanup failed');
 }
}
export async function ensureHealth(force=false):Promise<Health>{
 let fp:string;
 try{fp=await fingerprint();}catch(e){return {healthy:false,version:'unavailable',fingerprint:'unavailable',checkedAt:new Date().toISOString(),model:'unavailable',effort:'unavailable',notices:[],reason:(e as Error).message};}
 const policy=JSON.stringify([modelPolicy('grok'),effortPolicy('grok')]);
 if(!force&&!recheck&&memory?.fingerprint===fp&&memoryPolicy===policy&&Date.now()-Date.parse(memory.checkedAt)<catalogTtlMs)return memory;
 if(inFlight)return inFlight;
 recheck=false;
 inFlight=(async()=>{
  let prior:Health|undefined;try{prior=JSON.parse(await fs.readFile(path.join(root,'state/health.json'),'utf8'));}catch{}
  const base:Health={healthy:false,version:'unavailable',fingerprint:fp,checkedAt:new Date().toISOString(),model:'unavailable',effort:'unavailable',notices:[]};
  try{
    resetGrokLaunch();
    const launch=await grokLaunch();
    const version=await runCommand(launch,['version'],{env:childEnv,timeoutMs:15000});
    if(version.code!==0)throw Error(version.timedOut?'Grok version check timed out':`Grok version check failed with exit code ${version.code}`);
    base.version=version.stdout.trim();
    const discovery=await probe(launch);
    // Preserve verified authentication even if model/config validation later fails.
    base.protocolVersion=discovery.init.protocolVersion;base.auth='cached_token';base.subscriptionTier=String(discovery.auth._meta?.subscription_tier??'unavailable');
    const state=discovery.init._meta?.modelState as any;
    base.modelCatalog=grokCatalog(state,base.version);
    if(prior&&prior.version!==base.version)base.notices.push(`Grok Build version changed: ${prior.version} -> ${base.version}. Read-only ACP initialize/authenticate and MCP discovery checks performed; no model/tool execution smoke test.`);
    // Health/discovery must never choose a task model or spend a model turn.
    base.notices.push('Model and effort are selected per task; health verifies protocol and subscription authentication only.');
    base.mcpSelfTest=mcpTest?await mcpTest():undefined;
    if(base.mcpSelfTest===false)throw Error('MCP discovery/self-test failed');
    base.healthy=true;
  }catch(e){base.reason=(e as Error).message;base.notices.push('MCP path is unhealthy. Use verified Grok Build CLI fallback; do not replay partial edits automatically.');}
  if(!shuttingDown){await fs.mkdir(path.join(root,'state'),{recursive:true}).catch(()=>{});
  await fs.writeFile(path.join(root,'state/health.json'),JSON.stringify(base,null,2)).catch(()=>{});}
  memory=base;memoryPolicy=policy;return base;
 })();
 try{return await inFlight;}finally{inFlight=undefined;}
}
