import {spawn} from 'node:child_process';
import {Readable,Writable} from 'node:stream';
import {client,ndJsonStream} from '@agentclientprotocol/sdk';
import {active,childEnv,terminate,shuttingDown,grokLaunch} from './runtime.js';
import {spawnPlan} from './process.js';
import {readWeeklyUsage,type WeeklyUsage,type Unavailable} from './usage.js';
import {accountStatus,type AccountStatus} from './account.js';
let authenticatedAccount:AccountStatus|undefined;

export type BillingSnapshot = (WeeklyUsage | {status:'unavailable';fresh:false}) & {
  source:'acp_billing'|'acp_cache'|'log_fallback'|'unavailable';
  stale:boolean; refreshError?:string;
};
export function normalizeBilling(value:any,now:number):WeeklyUsage {
  if(!value || typeof value.config!=='object' || !value.config)throw Error('Invalid billing response');
  const c=value.config,p=c.currentPeriod;
  const tier=value.subscriptionTier??value.subscription_tier;
  const validPeriod=p&&typeof p.type==='string'&&typeof p.start==='string'&&typeof p.end==='string'&&Number.isFinite(Date.parse(p.start))&&Date.parse(p.end)>Date.parse(p.start);
  const period=validPeriod?{type:p.type,start:p.start,end:p.end}:'unavailable';
  const used=typeof c.creditUsagePercent==='number'&&Number.isFinite(c.creditUsagePercent)&&c.creditUsagePercent>=0&&c.creditUsagePercent<=100?c.creditUsagePercent:'unavailable';
  return {status:'available',subscriptionTier:typeof tier==='string'?tier:'unavailable',creditUsagePercent:used,remainingPercent:typeof used==='number'?100-used:'unavailable',currentPeriod:period,period,timestamp:new Date(now).toISOString(),fresh:!!validPeriod&&now>=Date.parse(p.start)&&now<Date.parse(p.end)};
}

/** Official subscription billing request only: no session/new or model prompt. */
export async function fetchBilling():Promise<unknown>{
  if(shuttingDown)throw Error('Billing unavailable during shutdown');
  const invocation=spawnPlan(await grokLaunch(),['agent','--no-leader','stdio']);
  const p=spawn(invocation.command,invocation.args,{env:childEnv,windowsHide:true,windowsVerbatimArguments:invocation.windowsVerbatimArguments,shell:false,stdio:['pipe','pipe','pipe']});active.add(p);
  p.stderr.on('data',()=>{});
  const app=client({name:'grok-billing-reader'});
  const conn=app.connect(ndJsonStream(Writable.toWeb(p.stdin) as WritableStream<Uint8Array>,Readable.toWeb(p.stdout) as ReadableStream<Uint8Array>));
  p.on('error',e=>conn.close(e));
  const timer=setTimeout(()=>{conn.close();void terminate(p);},25000);
  try{
    const init=await conn.agent.request('initialize',{protocolVersion:1,clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false},clientInfo:{name:'grok-billing-reader',version:'1.0.0'}});
    if(!init.authMethods?.some(m=>m.id==='cached_token'))throw Error('Subscription authentication unavailable');
    const auth=await conn.agent.request('authenticate',{methodId:'cached_token'});
    if(auth._meta?.auth_mode!=='Oidc'||auth._meta?.backend_billed===true)throw Error('Subscription authentication not confirmed');
    authenticatedAccount=accountStatus(true,{email:auth._meta?.email,organization:auth._meta?.team_name},'grok_acp_authenticate');
    return await conn.agent.request('_x.ai/billing',{});
  }catch(error){authenticatedAccount=undefined;throw error;
  }finally{
    clearTimeout(timer);conn.close();p.stdin.end();
    await new Promise<void>(resolve=>{if(p.exitCode!==null||p.signalCode!==null)return resolve();const t=setTimeout(resolve,300);p.once('close',()=>{clearTimeout(t);resolve();});});
    if(await terminate(p))active.delete(p);
  }
}

export class BillingReader {
  private cached?:WeeklyUsage;
  private inFlight?:Promise<BillingSnapshot>;
  private failedAt?:number;
  constructor(private fetch:()=>Promise<unknown>=fetchBilling,private fallback:()=>Promise<WeeklyUsage|Unavailable>=readWeeklyUsage,private now:()=>number=Date.now,private ttlMs=60000){}
  async read(force=false):Promise<BillingSnapshot>{
    const now=this.now();
    if(this.inFlight)return this.inFlight;
    if(!force&&this.cached&&now-Date.parse(this.cached.timestamp)<this.ttlMs&&this.cached.currentPeriod!=='unavailable'&&now<Date.parse(this.cached.currentPeriod.end))return {...this.cached,source:'acp_cache',stale:!this.cached.fresh};
    // Failures are throttled even for forced after-run refreshes.
    if(this.failedAt!==undefined&&now-this.failedAt<30000)return this.fromLog();
    this.inFlight=(async()=>{
      try{const snapshot=normalizeBilling(await this.fetch(),this.now());this.cached=snapshot;this.failedAt=undefined;return {...snapshot,source:'acp_billing' as const,stale:!snapshot.fresh};}
      catch{this.failedAt=this.now();this.cached=undefined;return this.fromLog();}
    })();
    try{return await this.inFlight;}finally{this.inFlight=undefined;}
  }
  private async fromLog():Promise<BillingSnapshot>{
    // Do not return raw upstream errors: they may contain authentication details.
    let log:WeeklyUsage|Unavailable='unavailable';try{log=await this.fallback();}catch{}
    if(log==='unavailable')return {status:'unavailable',fresh:false,source:'unavailable',stale:true,refreshError:'Live billing refresh failed; no local snapshot available'};
    return {...log,fresh:false,source:'log_fallback',stale:true,refreshError:'Live billing refresh failed; values are last-known log data'};
  }
}
export const billingReader=new BillingReader();
export async function getWeeklyUsage(force=false):Promise<BillingSnapshot>{return billingReader.read(force);}
export async function getGrokAccountStatus(force=false):Promise<AccountStatus>{
  try{const billing=await getWeeklyUsage(force);if(['acp_billing','acp_cache'].includes(billing.source)&&!billing.stale&&authenticatedAccount&&Date.now()-Date.parse(authenticatedAccount.observedAt)<60000)return {...authenticatedAccount};}catch{}
  return accountStatus('unknown',undefined,'grok_acp_authenticate_unavailable');
}
export function forDelta(value:BillingSnapshot):WeeklyUsage|Unavailable{return value.status==='available'?value:'unavailable';}

