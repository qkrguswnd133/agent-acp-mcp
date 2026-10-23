import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {processIdentityAsync} from './process-identity.js';
import {replaceRecord} from './atomic-record.js';
export type OperationStatus='queued'|'running'|'completed'|'failed'|'interrupted';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class MaintenanceOperations {
 private active=new Map<string,Promise<void>>();private closed=false;private identity=processIdentityAsync(process.pid).catch(()=>undefined);
 constructor(private directory:string,private replace:typeof replaceRecord=replaceRecord){}
 private file(id:string){if(!uuid.test(id))throw Error('Invalid operation_id');return path.join(this.directory,id+'.json');}
 private async save(record:any){await fs.mkdir(this.directory,{recursive:true});const root=await fs.lstat(this.directory);if(!root.isDirectory()||root.isSymbolicLink())throw Error('Unsafe operation directory');const file=this.file(record.operation_id),tmp=file+'.'+randomUUID()+'.tmp';try{await fs.writeFile(tmp,JSON.stringify(record),{flag:'wx'});await this.replace(tmp,file);}finally{await fs.unlink(tmp).catch(()=>{});}}
 async start(kind:string,input:unknown,run:(phase:(name:string,elapsedMs:number)=>void)=>Promise<unknown>){
  if(this.closed)throw Error('Gateway is draining maintenance');
  const operation_id=randomUUID(),record:any={operation_id,kind,input,status:'queued',ownerPid:process.pid,startedAt:new Date().toISOString(),timings:[]};const initial=this.save(record);
  const task=initial.then(()=>new Promise<void>(resolve=>setImmediate(resolve))).then(async()=>{
   const start=performance.now();record.status='running';record.ownerStartedAt=await this.identity;await this.save(record);
   try{record.result=await run((phase,elapsedMs)=>record.timings.push({phase,elapsedMs}));record.status='completed';}
   catch(error){record.status='failed';record.error=error instanceof Error?error.message:String(error);record.evidence=Object.fromEntries(Object.entries(error&&typeof error==='object'?error:{}));}
   finally{record.finishedAt=new Date().toISOString();record.timings.push({phase:'total',elapsedMs:performance.now()-start});await this.save(record);}
  }).catch(async error=>{record.status='failed';record.error=String(error);await this.save(record).catch(()=>{});}).finally(()=>this.active.delete(operation_id));
  this.active.set(operation_id,task);await initial;
  return {operation_id,status:'queued',kind,poll_after_seconds:2,message:'Maintenance accepted; use agent_operation_status. A request timeout never cancels accepted maintenance.'};
 }
 async status(id:string){const file=this.file(id),s=await fs.lstat(file);if(!s.isFile()||s.isSymbolicLink())throw Error('Unsafe operation record');const record=JSON.parse(await fs.readFile(file,'utf8'));if(record.operation_id!==id)throw Error('Operation identity mismatch');if(['queued','running'].includes(record.status)&&!this.active.has(id)){if(record.ownerStartedAt){const actual=await processIdentityAsync(record.ownerPid).catch(()=>undefined);if(actual&&actual!==record.ownerStartedAt)return {...record,status:'interrupted',message:'Owner PID was reused; no automatic replay.'};}try{process.kill(record.ownerPid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return {...record,status:'interrupted',message:'Operation owner exited; inspect workspace and retained evidence before retrying. No automatic replay.'};}}return record;}
 isIdle(){return this.active.size===0;}
 async drain(){this.closed=true;await Promise.all([...this.active.values()]);}
}
