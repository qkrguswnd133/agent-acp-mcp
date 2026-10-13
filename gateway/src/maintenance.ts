import fs from 'node:fs';
import path from 'node:path';
import {processIdentity} from './process-identity.js';

export interface MaintenanceRequest {schemaVersion:1;operationId:string;ownerPid:number;ownerStartedAt:string;platform?:'linux'|'win32';requestedAt:string;expiresAt:string;phase:'prepare'|'commit'}
export interface MaintenanceOptions {platform?:NodeJS.Platform;identity?:(pid:number)=>string|undefined;alive?:(pid:number)=>boolean;}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A sibling lease survives an MCP host respawn and stays outside the swappable program tree. */
export class MaintenanceGate {
  readonly requestFile:string;
  readonly acknowledgementPrefix:string;
  private timer?:NodeJS.Timeout;
  private acknowledgedOperation?:string;
  private committing=false;
  private verifiedOwner?:{key:string;checkedAt:number;valid:boolean};
  constructor(gatewayRoot:string,private idle:()=>boolean,private onReady:()=>void,private options:MaintenanceOptions={}){
    const target=path.resolve(gatewayRoot);
    this.requestFile=target+'.maintenance.json';
    this.acknowledgementPrefix=target+'.maintenance.';
  }
  request():MaintenanceRequest|undefined {
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
      let valid=false;
      try {
        const actual=(this.options.identity??processIdentity)(value.ownerPid);
        valid=actual===value.ownerStartedAt;
      } catch {}
      this.verifiedOwner={key:ownerKey,checkedAt:now,valid};
    }
    if(!this.verifiedOwner.valid)return undefined;
    return value;
  }
  blocked(){return !!this.request();}
  assertAvailable(){if(this.blocked())throw Error('GATEWAY_MAINTENANCE: update in progress; retry after it finishes');}
  start(){
    const tick=()=>{
      const request=this.request();
      if(!request||!this.idle())return;
      if(request.phase==='commit'){
        if(!this.committing){this.committing=true;this.onReady();}
        return;
      }
      if(this.acknowledgedOperation===request.operationId)return;
      const gatewayStartedAt=(this.options.platform??process.platform)==='linux'?(this.options.identity??processIdentity)(process.pid):undefined;
      if((this.options.platform??process.platform)==='linux'&&!gatewayStartedAt)return;
      const ack={schemaVersion:1,operationId:request.operationId,gatewayPid:process.pid,...(gatewayStartedAt?{gatewayStartedAt,platform:'linux'}:{}),acknowledgedAt:new Date().toISOString()};
      try{
        const target=this.acknowledgementPrefix+request.operationId+'.'+process.pid+'.ack.json';
        const temp=target+'.tmp';
        fs.writeFileSync(temp,JSON.stringify(ack),'utf8');fs.renameSync(temp,target);
        this.acknowledgedOperation=request.operationId;
      }catch(e){console.error(JSON.stringify({event:'maintenance_ack_failed',message:(e as Error).message}));}
    };
    tick();this.timer=setInterval(tick,100);
  }
  stop(){if(this.timer)clearInterval(this.timer);}
}
