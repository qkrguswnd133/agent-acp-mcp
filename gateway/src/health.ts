import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Readable,Writable} from 'node:stream';
import {client,ndJsonStream,type ClientConnection} from '@agentclientprotocol/sdk';
import {root,executable,childEnv,active,terminate,shuttingDown} from './runtime.js';
import {readWeeklyUsage,getSessionUsage,weeklyDelta} from './usage.js';
import {modelPolicy,effortPolicy} from './config.js';
import {confirmSessionConfig} from './session-config.js';

export interface Selection { model:string;effort:string;notices:string[] }
export function selectModel(models:any[],defaultModel?:string,preferredModel='auto',preferredEffort='xhigh',strict:{model?:boolean;effort?:boolean}={}):Selection {
  const candidates=models.filter(m=>typeof m.modelId==='string' && /^grok-/i.test(m.modelId) && /build|cod/i.test(String(m._meta?.agentType??'')) && m._meta?.supportsToolUse!==false && m._meta?.apiKeyRequired!==true);
  const requestedModel=preferredModel;
  let chosen=preferredModel==='auto'?undefined:candidates.find(m=>m.modelId===requestedModel);
  if(!chosen&&preferredModel!=='auto'&&strict.model)throw Error(`Requested Grok model ${preferredModel} is not advertised for subscription coding; refusing fallback`);
  const notices:string[]=[];
  if(!chosen){
    // Select the highest advertised version among coding-capable subscription Grok models.
    const version=(m:any)=>m.modelId.match(/grok-(\d+(?:\.\d+)*)/i)?.[1];
    const versioned=candidates.filter(m=>version(m));
    versioned.sort((a,b)=>{
      const order=version(b).localeCompare(version(a),undefined,{numeric:true});
      if(order)return order;
      // Prefer the ordinary model over priced/special variants of the same version.
      const plain=(m:any)=>m.modelId===`grok-${version(m)}`;
      return Number(plain(b))-Number(plain(a)) || Number(b.modelId===defaultModel)-Number(a.modelId===defaultModel);
    });
    chosen=versioned[0]??candidates.find(m=>m.modelId===defaultModel);
    if(!chosen)throw Error('No verified subscription coding model is advertised by ACP');
    if(preferredModel!=='auto')notices.push(`Configured ${requestedModel} is unavailable; selected advertised coding model ${chosen.modelId}.`);
  }
  const levels=(chosen._meta?.reasoningEfforts??[]).map((v:any)=>v.id??v.value);
  if(chosen._meta?.supportsReasoningEffort!==true)throw Error('Reasoning configuration is not advertised for selected model');
  const requestedEffort=preferredEffort==='auto'?'xhigh':preferredEffort;
  if(strict.effort&&preferredEffort!=='auto'&&!levels.includes(requestedEffort))throw Error(`Requested Grok effort ${preferredEffort} is not supported by ${chosen.modelId}; refusing fallback`);
  const effort=levels.includes(requestedEffort)?requestedEffort:['ultracode','max','xhigh','high','medium','low','minimal','none'].find(v=>levels.includes(v));
  if(!effort)throw Error('No recognized reasoning effort is advertised');
  if(effort!==requestedEffort)notices.push(`Selected model does not support requested effort ${requestedEffort}; using its highest supported effort ${effort}.`);
  return {model:chosen.modelId,effort,notices};
}
export interface Health {
  healthy:boolean;version:string;fingerprint:string;checkedAt:string;
  model:string;effort:string;notices:string[];reason?:string;protocolVersion?:number;
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
async function fingerprint(){const s=await fs.stat(executable);return `${s.size}:${s.mtimeMs}`;}
async function probe(selection?:Selection,smoke=false){
 if(shuttingDown)throw Error('Bridge is shutting down');
 const cwd=path.join(root,'work/health');await fs.mkdir(cwd,{recursive:true});
 const args=['agent','--no-leader',...(selection?['--model',selection.model,'--effort',selection.effort]:[]),'--agent-profile',path.join(root,'profiles/read.md'),'stdio'];
 const p=spawn(executable,args,{cwd,env:childEnv,windowsHide:true,stdio:['pipe','pipe','pipe']});active.add(p);p.stderr.on('data',()=>{});
 const app=client({name:'grok-compatibility-check'});
 let text='',conn:ClientConnection|undefined;
 app.onRequest('session/request_permission',async()=>({outcome:{outcome:'cancelled'}}));
 app.onNotification('session/update',({params:{update}})=>{if(update.sessionUpdate==='agent_message_chunk'&&update.content.type==='text')text+=update.content.text;});
 conn=app.connect(ndJsonStream(Writable.toWeb(p.stdin) as WritableStream<Uint8Array>,Readable.toWeb(p.stdout) as ReadableStream<Uint8Array>));
 p.on('error',e=>conn?.close(e));
 const timer=setTimeout(()=>{conn?.close();void terminate(p);},smoke?90000:30000);
 let smokeResult:any;
 try{
  const init=await conn.agent.request('initialize',{protocolVersion:1,clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false},clientInfo:{name:'grok-compatibility-check',version:'1.0.0'}});
  if(init.protocolVersion!==1||!init.authMethods?.some(m=>m.id==='cached_token'))throw Error('ACP v1/cached_token compatibility check failed');
  const auth=await conn.agent.request('authenticate',{methodId:'cached_token'});
  if(auth._meta?.auth_mode!=='Oidc'||auth._meta?.backend_billed===true)throw Error('Subscription OAuth login not confirmed');
  if(selection){
    const s=await conn.agent.request('session/new',{cwd,mcpServers:[],_meta:{yoloMode:false,autoMode:false}});
    await confirmSessionConfig(s.configOptions??[],selection.model,selection.effort,
      (configId,value)=>conn!.agent.request('session/set_config_option',{sessionId:s.sessionId,configId,value}));
    if(smoke){
      const before=await readWeeklyUsage();const startedAt=new Date().toISOString();
      const result=await conn.agent.request('session/prompt',{sessionId:s.sessionId,prompt:[{type:'text',text:'Read-only compatibility test. Do not use any tools. Reply exactly ACP_HEALTH_OK.'}]});
      const after=await readWeeklyUsage();
      smokeResult={sessionId:s.sessionId,model:selection.model,effort:selection.effort,stopReason:result.stopReason,text,usage:await getSessionUsage(s.sessionId,executable,[],childEnv),weekly:after,weeklyDelta:weeklyDelta(before,after,startedAt)};
      if(result.stopReason!=='end_turn'||text.trim()!=='ACP_HEALTH_OK')throw Error('Read-only ACP smoke failed');
    }
  }
  return {init,auth,smoke:smokeResult};
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
 if(!force&&!recheck&&memory?.fingerprint===fp&&memoryPolicy===policy)return memory;
 if(inFlight)return inFlight;
 const retryAfterError=recheck;recheck=false;
 inFlight=(async()=>{
  let prior:Health|undefined;
  try{prior=JSON.parse(await fs.readFile(path.join(root,'state/health.json'),'utf8'));}catch{}
  const base:Health={healthy:false,version:'unavailable',fingerprint:fp,checkedAt:new Date().toISOString(),model:'unavailable',effort:'unavailable',notices:[]};
  try{
    const {stdout}=await promisify(execFile)(executable,['version'],{env:childEnv,windowsHide:true,timeout:15000});base.version=stdout.trim();
    const discovery=await probe();
    // Preserve verified authentication even if model/config validation later fails.
    base.protocolVersion=discovery.init.protocolVersion;base.auth='cached_token';base.subscriptionTier=String(discovery.auth._meta?.subscription_tier??'unavailable');
    const state=discovery.init._meta?.modelState as any;
    const selected=selectModel(state?.availableModels??[],state?.currentModelId,modelPolicy('grok'),effortPolicy('grok'));
    Object.assign(base,selected);
    if(prior&&prior.version!==base.version)base.notices.push(`Grok Build version changed: ${prior.version} -> ${base.version}. Compatibility smoke performed.`);
    if(prior&&(prior.model!==selected.model||prior.effort!==selected.effort))base.notices.push(`Model/effort changed: ${prior.model} / ${prior.effort} -> ${selected.model} / ${selected.effort}.`);
    const needsSmoke=!prior?.healthy||prior.fingerprint!==fp||prior.model!==selected.model||prior.effort!==selected.effort||retryAfterError;
    const verified=await probe(selected,needsSmoke);
    base.protocolVersion=verified.init.protocolVersion;base.auth='cached_token';base.subscriptionTier=String(verified.auth._meta?.subscription_tier??'unavailable');
    base.smoke=verified.smoke??prior?.smoke;
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
