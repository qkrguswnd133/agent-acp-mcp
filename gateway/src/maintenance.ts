import fs from 'node:fs';
import path from 'node:path';
import {processIdentityAsync} from './process-identity.js';

export interface MaintenanceRequest {schemaVersion:1;operationId:string;ownerPid:number;ownerStartedAt:string;platform?:'linux'|'win32';requestedAt:string;expiresAt:string;phase:'prepare'|'commit'}
export interface MaintenanceOptions {platform?:NodeJS.Platform;identity?:(pid:number)=>string|undefined|Promise<string|undefined>;alive?:(pid:number)=>boolean;}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A sibling lease survives an MCP host respawn and stays outside the swappable program tree. */
export class MaintenanceGate {
  readonly requestFile:string;
  readonly acknowledgementPrefix:string;
  private timer?:NodeJS.Timeout;
  private acknowledgedOperation?:string;
  private committing=false;
  private verifiedOwner?:{key:string;checkedAt:number;valid:boolean};
  private ownerCheck?:{key:string;pending:Promise<boolean>};
  private stopped=false;
  constructor(gatewayRoot:string,private idle:()=>boolean,private onReady:()=>void,private options:MaintenanceOptions={}){
    const target=path.resolve(gatewayRoot);
    this.requestFile=target+'.maintenance.json';
    this.acknowledgementPrefix=target+'.maintenance.';
  }
  async request():Promise<MaintenanceRequest|undefined> {
    let value:MaintenanceRequest;
    try {value=JSON.parse(fs.readFileSync(this.requestFile,'utf8'));} catch {return undefined;}
    const platform=this.options.platform??process.platform;
    const validIdentity=platform==='linux'?value?.platform==='linux'&&/^linux:[0-9a-f-]{36}:\d+:\d+$/i.test(value?.ownerStartedAt):platform==='win32'&&(value?.platform===undefined||value.platform==='win32')&&/^\d{15,20}$/.test(value?.ownerStartedAt);
    if(value?.schemaVersion!==1||typeof value.operationId!=='string'||!uuid.test(value.operationId)||!Number.isSafeInteger(value.ownerPid)||value.ownerPid<1||!validIdentity||typeof value.requestedAt!=='string'||typeof value.expiresAt!=='string'||!['prepare','commit'].includes(value.phase))return undefined;
    const start=Date.parse(value.requestedAt),end=Date.parse(value.expiresAt),now=Date.now();
    if(!Number.isFinite(start)||!Number.isFinite(end)||start>now+30_000||end<=now||end<=start||end-start>31*60_000)return undefined;
    try {if(this.options.alive){if(!this.options.alive(value.ownerPid))return undefined;}else process.kill(value.ownerPid,0);} catch {return undefined;}
    const ownerKey=value.operationId+':'+value.ownerPid+':'+value.ownerStartedAt;
    if(platform==='linux'||!this.verifiedOwner||this.verifiedOwner.key!==ownerKey||now-this.verifiedOwner.checkedAt>1000){
      if(this.ownerCheck?.key!==ownerKey){
        const pending=(async()=>{try{return await (this.options.identity??processIdentityAsync)(value.ownerPid)===value.ownerStartedAt;}catch{return false;}})();
        this.ownerCheck={key:ownerKey,pending};
      }
      const check=this.ownerCheck;const valid=await check.pending;
      if(this.ownerCheck===check)this.ownerCheck=undefined;
      this.verifiedOwner={key:ownerKey,checkedAt:Date.now(),valid};
    }
    if(!this.verifiedOwner.valid)return undefined;
    // Identity lookup can outlive the lease or a phase replacement. Re-read the
    // small record; a stale prepare/commit decision must never exit a gateway.
    try{if(JSON.stringify(JSON.parse(fs.readFileSync(this.requestFile,'utf8')))!==JSON.stringify(value)||Date.parse(value.expiresAt)<=Date.now())return undefined;}catch{return undefined;}
    return value;
  }
  async blocked(){return !!await this.request();}
  async assertAvailable(){if(await this.blocked())throw Error('GATEWAY_MAINTENANCE: update in progress; retry after it finishes');}
  start(){
    this.stopped=false;let pending=false;
    const tick=async()=>{
      if(pending||this.stopped)return;pending=true;
      try{
      const request=await this.request();
      if(this.stopped||!request||!this.idle())return;
      if(request.phase==='commit'){
        if(!this.committing){this.committing=true;this.onReady();}
        return;
      }
      if(this.acknowledgedOperation===request.operationId)return;
      const gatewayStartedAt=(this.options.platform??process.platform)==='linux'?await (this.options.identity??processIdentityAsync)(process.pid):undefined;
      if((this.options.platform??process.platform)==='linux'&&!gatewayStartedAt)return;
      if(this.stopped||!this.idle())return;
      const ack={schemaVersion:1,operationId:request.operationId,gatewayPid:process.pid,...(gatewayStartedAt?{gatewayStartedAt,platform:'linux'}:{}),acknowledgedAt:new Date().toISOString()};
      try{
        const target=this.acknowledgementPrefix+request.operationId+'.'+process.pid+'.ack.json';
        const temp=target+'.tmp';
        fs.writeFileSync(temp,JSON.stringify(ack),'utf8');fs.renameSync(temp,target);
        this.acknowledgedOperation=request.operationId;
      }catch(e){console.error(JSON.stringify({event:'maintenance_ack_failed',message:(e as Error).message}));}
      }finally{pending=false;}
    };
    void tick();this.timer=setInterval(()=>{void tick();},100);
  }
  stop(){this.stopped=true;if(this.timer)clearInterval(this.timer);}
}
