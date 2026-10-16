import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
export const MAX_TOOL_RESPONSE_BYTES=18*1024;
const size=(v:unknown)=>Buffer.byteLength(JSON.stringify(v));
const transportSize=(v:unknown)=>size({content:[{type:'text',text:JSON.stringify(v)}]});
function diagnostics(v:any):boolean{return !!v&&typeof v==='object'&&Object.entries(v).some(([k,x])=>(['checks','trackedPids','trackedProcesses','commandExecutions'].includes(k)&&Array.isArray(x)&&x.length>5)||diagnostics(x));}
const clip=(s:string,n:number)=>Array.from(s).slice(0,n).join('')+(s.length>n?' … [details in artifact]':'');
/** Content-addressed immutable details, separate from mutable job metadata. */
export async function boundedToolPayload(value:any,directory:string,verbose=false):Promise<any>{
 const original=JSON.stringify(value),bytes=Buffer.byteLength(original);
 if(bytes<MAX_TOOL_RESPONSE_BYTES&&transportSize(value)<20*1024&&!verbose&&!diagnostics(value))return value;
 let artifact:any,detailError:string|undefined;
 try{
  if(bytes>128*1024*1024)throw Error('Detail exceeds storage cap');
  await fs.mkdir(directory,{recursive:true});const root=await fs.realpath(directory),stat=await fs.lstat(directory);if(stat.isSymbolicLink()||!stat.isDirectory())throw Error('Unsafe detail directory');
  const sha256=createHash('sha256').update(original).digest('hex'),file=path.join(root,sha256+'.json');
  try{await fs.writeFile(file,original,{flag:'wx',mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;const s=await fs.lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.size!==bytes||createHash('sha256').update(await fs.readFile(file)).digest('hex')!==sha256)throw Error('Existing detail integrity mismatch');}
  artifact={path:file,bytes,sha256,format:'json'};
 }catch{detailError='Full detail storage unavailable; original operation outcome is unchanged.';}
 const source=structuredClone(value);
 function deduplicate(v:any){
  if(!v||typeof v!=='object')return;
  if(v.trackedProcessCheck&&v.worktree?.forgetAudit?.trackedProcessCheck){delete v.trackedProcessCheck;v.processCheckLocation='worktree.forgetAudit.trackedProcessCheck';}
  for(const x of Object.values(v))deduplicate(x);
 }
 deduplicate(source);
 function reduce(v:any,n:number,depth=0):any{
  if(typeof v==='string')return clip(v,n);
  if(v===null||typeof v!=='object')return v;
  if(depth>8)return '[nested details in artifact]';
  if(Array.isArray(v))return v.slice(0,5).map(x=>reduce(x,n,depth+1));
  const out:any={};const keys=Object.keys(v);const priority=['operation_id','job_id','status','outcome','error','errorKind','message','dry_run','record_only','eligible','reason','result','worktree','forgetAudit','processWarnings','processCleanupUnchanged','processWarningAcknowledged','timings','artifact','payload','wait','successCount','failureCount'];
  const sorted=[...priority.filter(k=>Object.hasOwn(v,k)),...keys.filter(k=>!priority.includes(k))];
  for(const k of sorted.slice(0,32)){
   out[k]=reduce(v[k],n,depth+1);
   if(Array.isArray(v[k])&&v[k].length>5){out[k+'Count']=v[k].length;out[k+'Truncated']=true;}
   if(k==='checks'&&Array.isArray(v[k]))out.pidDecisions=v[k].reduce((a:any,r:any)=>{const decision=typeof r?.decision==='string'?r.decision:'unknown';a[decision]=(a[decision]??0)+1;return a;},{});
  }
  if(keys.length>32)out.detailsOmitted=true;
  return out;
 }
 for(const limit of [1024,256,64]){
  const preview=reduce(source,limit),response={...preview,details:{truncated:true,originalBytes:bytes,...(artifact?{artifact}:{}),...(detailError?{error:detailError}:{}),verboseRequested:verbose}};
  if(size(response)<MAX_TOOL_RESPONSE_BYTES&&transportSize(response)<20*1024)return response;
 }
 return {job_id:value?.job_id,operation_id:value?.operation_id,status:value?.status,outcome:value?.outcome,error:value?.error?clip(String(value.error),256):undefined,details:{truncated:true,originalBytes:bytes,artifact,error:detailError},message:'Result exceeds response limit; inspect the complete artifact.'};
}
