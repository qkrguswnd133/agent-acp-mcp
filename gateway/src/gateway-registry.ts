import fs from 'node:fs';
import path from 'node:path';
import {processIdentity} from './process-identity.js';

/** Discovery is advisory: the updater must verify each live PID identity and
 * scan /proc as well. A stale registry can never authorize terminating a PID. */
export class GatewayRegistry {
  private timer?:NodeJS.Timeout;
  private identity?:string;
  private readonly startedAt=new Date().toISOString();
  readonly file:string;
  constructor(private installRoot:string,private stateRoot:string,private idle:()=>boolean,private platform:NodeJS.Platform=process.platform,private getIdentity:(pid:number)=>string|undefined=processIdentity){
    this.file=path.join(stateRoot,'gateways',`${process.pid}.json`);
  }
  start(){
    if(this.platform!=='linux')return;
    this.identity=this.getIdentity(process.pid);
    if(!this.identity)throw Error('Cannot establish Linux gateway process identity for safe updates');
    const tick=()=>{
      fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});
      const temp=this.file+'.tmp';
      const record={schemaVersion:1,pid:process.pid,startIdentity:this.identity,platform:'linux',installRoot:this.installRoot,stateRoot:this.stateRoot,startedAt:this.startedAt,updatedAt:new Date().toISOString(),idle:this.idle()};
      fs.writeFileSync(temp,JSON.stringify(record),{encoding:'utf8',mode:0o600});fs.renameSync(temp,this.file);
    };
    tick();this.timer=setInterval(()=>{try{tick();}catch(error){console.error(JSON.stringify({event:'gateway_registry_failed',message:(error as Error).message}));}},1000);this.timer.unref();
  }
  stop(){
    if(this.timer)clearInterval(this.timer);
    if(!this.identity)return;
    try{const record=JSON.parse(fs.readFileSync(this.file,'utf8'));if(record.startIdentity===this.identity)fs.unlinkSync(this.file);}catch{}
  }
}
