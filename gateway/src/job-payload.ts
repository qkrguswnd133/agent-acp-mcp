import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const MAX_JOB_RESPONSE_BYTES=64*1024;
const MAX_ARTIFACT_BYTES=128*1024*1024;
const SCHEMA='agent-job-payload-v1';
interface Artifact {path:string;bytes:number;sha256:string;format:'json';}
const bytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value),'utf8');
const digest=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const isRecord=(v:any):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const protectedKeys=new Set(['job_id','status','kind','provider','cwd','ownerPid','startedAt','lastActivityAt','finishedAt','error','errorKind','outcome','model','effort','observation','selection','usage','sessionId','session_id','handoff','execution','completionCriteria','implementationProgress','worktree','successCount','failureCount','results','skipped','childCleanedUp']);

// Work in Unicode code points: previews must not introduce broken surrogate pairs.
function preview(value:string,limit:number){
 if(Buffer.byteLength(value,'utf8')<=limit)return value;
 const points=Array.from(value),half=Math.max(0,Math.floor((limit-32)/2));
 let head='',tail='',used=0;
 for(const point of points){const n=Buffer.byteLength(point);if(used+n>half)break;head+=point;used+=n;}
 used=0;for(let i=points.length-1;i>=0;i--){const n=Buffer.byteLength(points[i]);if(used+n>half)break;tail=points[i]+tail;used+=n;}
 return head+'\n… [truncated] …\n'+tail;
}
function compact(job:any){
 const originalBytes=bytes(job);
 let rawEventCount=0,rawEventBytes=0,rawEventLines=0,hasRawEvents=false,hasStringEvents=false,commandCount=0;
 const count=(value:any)=>{
  if(!value||typeof value!=='object')return;
  for(const [key,item] of Object.entries(value)){
   if(key==='rawEvents'&&(Array.isArray(item)||typeof item==='string')){
    hasRawEvents=true;
    if(typeof item==='string'){
     // A line is not necessarily a valid event. Do not mislabel JSONL/text line counts as events.
     hasStringEvents=true;rawEventBytes+=Buffer.byteLength(item);rawEventLines+=item.split(/\r?\n/).filter(line=>line.trim()).length;
    }else{rawEventCount+=item.length;rawEventBytes+=bytes(item);}
    continue;
   }
   if(key==='commandExecutions'&&Array.isArray(item))commandCount+=item.length;
   if(key!=='payload')count(item);
  }
 };
 count(job);
 if(originalBytes<=MAX_JOB_RESPONSE_BYTES&&!hasRawEvents)return structuredClone(job);
 const counts={rawEvents:hasStringEvents?null:rawEventCount,rawEventArrayItems:rawEventCount,rawEventBytes,rawEventTextLines:rawEventLines,commandExecutions:commandCount};
 // Each pass reduces content while retaining object field names and metadata ahead of prose.
 for(const [stringLimit,arrayLimit,keyLimit] of [[4096,24,96],[1024,12,48],[256,4,24],[96,2,12],[48,1,8]]){
  let changes=0;
  const fields:Array<Record<string,unknown>>=[];
  const note=(field:string,detail:Record<string,unknown>)=>{changes++;if(fields.length<32)fields.push({field:preview(field,256),...detail});};
  const visit=(value:any,field:string,depth:number):any=>{
   if((field==='rawEvents'||field.endsWith('.rawEvents'))&&(typeof value==='string'||Array.isArray(value))){
    note(field,typeof value==='string'?{originalBytes:Buffer.byteLength(value),previewBytes:0}:{originalCount:value.length,previewCount:0});
    return typeof value==='string'?'':[];
   }
   if(typeof value==='string'){
    const limit=protectedKeys.has(field.split('.').at(-1)!)?Math.max(stringLimit,512):stringLimit;
    const reduced=preview(value,limit);if(reduced!==value)note(field,{originalBytes:Buffer.byteLength(value),previewBytes:Buffer.byteLength(reduced)});return reduced;
   }
   if(!value||typeof value!=='object')return value;
   if(depth>12){note(field,{reason:'depth_limit'});return null;}
   if(Array.isArray(value)){
    if(value.length<=arrayLimit||(['result.results','result.skipped'].includes(field)&&value.length<=10))return value.map((v,i)=>visit(v,`${field}[${i}]`,depth+1));
    const head=Math.ceil(arrayLimit/2),tail=Math.floor(arrayLimit/2);
    note(field,{originalCount:value.length,previewCount:arrayLimit});
    return [...value.slice(0,head).map((v,i)=>visit(v,`${field}[${i}]`,depth+1)),...value.slice(value.length-tail).map((v,i)=>visit(v,`${field}[${value.length-tail+i}]`,depth+1))];
   }
   const entries=Object.entries(value).sort(([a],[b])=>Number(protectedKeys.has(b))-Number(protectedKeys.has(a)));
   const kept=entries.slice(0,keyLimit);
   if(entries.length>kept.length)note(field,{originalFieldCount:entries.length,previewFieldCount:kept.length});
   return Object.fromEntries(kept.map(([key,item])=>[key,visit(item,field?`${field}.${key}`:key,depth+1)]));
  };
  const result=visit(job,'',0);
  result.payload={schema:SCHEMA,truncated:true,originalBytes,counts,truncatedFieldCount:changes,fields,
   ...(job.payload?.schema===SCHEMA?{...job.payload}:{}),verboseAvailable:true};
  // Leave room for the artifact reference attached after the original has been written.
  if(bytes(result)<=MAX_JOB_RESPONSE_BYTES-1024)return result;
 }
 // Pathological metadata maps can still exceed the cap. Keep the job identity and outcome.
 const result:any={};
 for(const key of ['job_id','status','kind','provider','error','errorKind'])if(job[key]!==undefined)result[key]=typeof job[key]==='string'?preview(job[key],512):job[key];
 result.payload={schema:SCHEMA,truncated:true,originalBytes,counts,reason:'response_byte_limit',verboseAvailable:true};
 if(job.payload?.artifact)result.payload.artifact=job.payload.artifact;
 return result;
}
function validId(job:any){
 if(typeof job.job_id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(job.job_id))throw Error('Invalid artifact job identifier');
 return job.job_id as string;
}
async function artifactDirectory(job:any,directory:string,create:boolean){
 const id=validId(job);
 if(create)await fs.mkdir(directory,{recursive:true});
 const root=await fs.realpath(directory);
 let current=root;
 for(const part of [id,'artifacts']){
  current=path.join(current,part);
  if(create){try{await fs.mkdir(current);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}}
  const stat=await fs.lstat(current);
  if(stat.isSymbolicLink()||!stat.isDirectory()||await fs.realpath(current)!==current)throw Error('Unsafe artifact directory');
 }
 return {root,folder:current,id};
}
function diagnostic(job:any,operation:'storage'|'hydration',error:unknown){
 // Deliberately omit exception messages: filesystem paths and provider text may be sensitive.
 const code=(error as NodeJS.ErrnoException)?.code;
 job.payload={...(job.payload?.schema===SCHEMA?job.payload:{}),schema:SCHEMA,diagnostics:[{operation,code:typeof code==='string'?code:'ARTIFACT_UNAVAILABLE',message:`Job payload ${operation} failed; original task outcome is unchanged.`}]};
 return job;
}

/** Persist the lossless original before returning its compact preview. Never mutates a live job. */
export async function persistJobPayload(job:any,jobsDirectory:string):Promise<any>{
 const original=structuredClone(job);
 if(original.payload?.schema===SCHEMA&&original.payload.artifact)return original;
 const reduced=compact(original);
 if(!reduced.payload?.truncated)return original;
 try{
  const contents=JSON.stringify(original),size=Buffer.byteLength(contents);
  if(size>MAX_ARTIFACT_BYTES)throw Error('Artifact exceeds maximum size');
  const {folder,id}=await artifactDirectory(original,jobsDirectory,true),sha256=digest(contents),name=`payload-${sha256}.json`;
  const destination=path.join(folder,name);
  // Exclusive creation prevents following a substituted link or overwriting any existing file.
  try{await fs.writeFile(destination,contents,{encoding:'utf8',flag:'wx',mode:0o600});}
  catch(e){
   if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
   await readArtifact(original,jobsDirectory,{path:`${id}/artifacts/${name}`,bytes:size,sha256,format:'json'});
  }
  reduced.payload.artifact={path:`${id}/artifacts/${name}`,bytes:size,sha256,format:'json'} satisfies Artifact;
  return reduced;
 }catch(e){return diagnostic(original,'storage',e);}
}
async function readArtifact(job:any,directory:string,ref:Artifact){
 const id=validId(job);
 if(!ref||ref.format!=='json'||!Number.isSafeInteger(ref.bytes)||ref.bytes<0||ref.bytes>MAX_ARTIFACT_BYTES||!/^[a-f0-9]{64}$/.test(ref.sha256)||ref.path!==`${id}/artifacts/payload-${ref.sha256}.json`)throw Error('Invalid artifact reference');
 const {folder}=await artifactDirectory(job,directory,false),file=path.join(folder,`payload-${ref.sha256}.json`);
 const stat=await fs.lstat(file);
 if(stat.isSymbolicLink()||!stat.isFile()||stat.size!==ref.bytes||await fs.realpath(file)!==file)throw Error('Unsafe artifact file');
 const handle=await fs.open(file,'r');
 try{
  const opened=await handle.stat();
  if(!opened.isFile()||opened.size!==ref.bytes||opened.ino!==stat.ino||opened.dev!==stat.dev)throw Error('Artifact changed while opening');
  // Fixed-size read caps memory even if another process grows the file after stat.
  const contents=Buffer.alloc(ref.bytes);let offset=0;
  while(offset<contents.length){const {bytesRead}=await handle.read(contents,offset,contents.length-offset,offset);if(!bytesRead)break;offset+=bytesRead;}
  if(offset!==ref.bytes||digest(contents)!==ref.sha256)throw Error('Artifact integrity check failed');
  const value=JSON.parse(contents.toString('utf8'));
  if(!isRecord(value)||value.job_id!==id)throw Error('Artifact belongs to another job');
  return value;
 }finally{await handle.close();}
}

/** Read-only presentation also handles legacy jobs with all data still inline. */
export async function presentJobPayload(job:any,options:{verbose?:boolean;jobsDirectory:string}):Promise<any>{
 const cloned=structuredClone(job);
 if(cloned.payload?.schema===SCHEMA&&cloned.payload.artifact)cloned.payload.artifactRoot=path.resolve(options.jobsDirectory);
 if(!options.verbose)return compact(cloned);
 if(cloned.payload?.schema!==SCHEMA||!cloned.payload.artifact)return cloned;
 try{
  const full=await readArtifact(cloned,options.jobsDirectory,cloned.payload.artifact);
  // Derived status fields are added after reading persisted state; keep those current.
  const result={...cloned,...full};delete result.payload;
  for(const key of ['status','error','completionPending','implementationProgress','stalled_suspected','poll_after_seconds','owner_available','message','worktree'])if(Object.hasOwn(cloned,key))result[key]=cloned[key];
  return result;
 }catch(e){return diagnostic(cloned,'hydration',e);}
}
