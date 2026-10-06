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
const protectedKeys=new Set(['job_id','status','kind','provider','cwd','ownerPid','startedAt','lastActivityAt','finishedAt','error','errorKind','outcome','model','effort','observation','selection','usage','sessionId','session_id','handoff','execution','completionCriteria','implementationProgress','worktree','worktreeMigration','successCount','failureCount','results','skipped','childCleanedUp']);
type PayloadScope='job'|'result'|'providers'|'provider'|'other';
function markResponseLimit(job:any){
 if(job.payload?.schema===SCHEMA){
  job.payload.responseLimitExceededByReview=false;
  job.payload.responseLimitExceededByReview=job.payload.serializedContentBytes>0&&bytes(job)>MAX_JOB_RESPONSE_BYTES;
 }
 return job;
}

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
 const texts=[job.result?.text,...(Array.isArray(job.result?.results)?job.result.results.map((value:any)=>value?.text):[])].filter((value):value is string=>typeof value==='string');
 const contentBytes=texts.reduce((total,value)=>total+Buffer.byteLength(value),0);
 // JSON escaping can make a body substantially larger than its UTF-8 text.
 const serializedContentBytes=texts.reduce((total,value)=>total+bytes(value)-2,0);
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
 // Result bodies are the requested deliverable. Only ancillary data is reduced.
 // Try the normal limit first, even when the body leaves very little room.
 for(const [stringLimit,arrayLimit,keyLimit] of [[4096,24,96],[1024,12,48],[256,4,24],[96,2,12],[48,1,8],[24,1,0]]){
  let changes=0;
  const fields:Array<Record<string,unknown>>=[];
  const note=(field:string,detail:Record<string,unknown>)=>{changes++;if(keyLimit>0&&fields.length<32)fields.push({field:preview(field,256),...detail});};
  const visit=(value:any,field:string,depth:number,scope:PayloadScope='other'):any=>{
   if((field==='rawEvents'||field.endsWith('.rawEvents'))&&(typeof value==='string'||Array.isArray(value))){
    note(field,typeof value==='string'?{originalBytes:Buffer.byteLength(value),previewBytes:0}:{originalCount:value.length,previewCount:0});
    return typeof value==='string'?'':[];
   }
   if(typeof value==='string'){
    const limit=protectedKeys.has(field.split('.').at(-1)!)?Math.max(stringLimit,512):stringLimit;
    const reduced=preview(value,limit);if(reduced!==value)note(field,{originalBytes:Buffer.byteLength(value),previewBytes:Buffer.byteLength(reduced)});return reduced;
   }
   if(!value||typeof value!=='object')return value;
   if(depth>(keyLimit===0?5:12)){note(field,{reason:'depth_limit'});return null;}
   if(Array.isArray(value)){
    if(value.length<=arrayLimit||scope==='providers'||(field==='result.skipped'&&value.length<=10))return value.map((v,i)=>visit(v,`${field}[${i}]`,depth+1,scope==='providers'?'provider':'other'));
    const head=Math.ceil(arrayLimit/2),tail=Math.floor(arrayLimit/2);
    note(field,{originalCount:value.length,previewCount:arrayLimit});
    return [...value.slice(0,head).map((v,i)=>visit(v,`${field}[${i}]`,depth+1)),...value.slice(value.length-tail).map((v,i)=>visit(v,`${field}[${value.length-tail+i}]`,depth+1))];
   }
   const resultScope=scope==='result'||scope==='provider';
   const required=(key:string)=>(scope==='job'&&(protectedKeys.has(key)||key==='result'))||(resultScope&&(protectedKeys.has(key)||key==='text'));
   const entries=Object.entries(value).filter(([key])=>field!==''||key!=='payload').sort(([a],[b])=>Number(required(b)||protectedKeys.has(b))-Number(required(a)||protectedKeys.has(a)));
   // Essential result fields cannot be displaced by a diagnostic-heavy object.
   const metadataLimit=field.endsWith('.usage')?24:protectedKeys.has(field.split('.').at(-1)!)?8:1;
   const kept=entries.filter(([key],index)=>required(key)||(index<Math.max(keyLimit,scope==='job'||resultScope?0:metadataLimit)&&(keyLimit>0||Buffer.byteLength(key)<=256)));
   if(entries.length>kept.length)note(field,{originalFieldCount:entries.length,previewFieldCount:kept.length});
   return Object.fromEntries(kept.map(([key,item])=>[key,resultScope&&key==='text'&&typeof item==='string'?item:visit(item,field?`${field}.${key}`:key,depth+1,scope==='job'&&key==='result'?'result':scope==='result'&&key==='results'?'providers':'other')]));
  };
  const result=visit(job,'',0,'job');
  const prior=job.payload?.schema===SCHEMA?job.payload:{};
  const priorCounts=isRecord(prior.counts)?Object.fromEntries(Object.keys(counts).map(key=>[key,typeof prior.counts[key]==='number'||prior.counts[key]===null?prior.counts[key]:(counts as any)[key]])):counts;
  result.payload={schema:SCHEMA,truncated:true,originalBytes:typeof prior.originalBytes==='number'?prior.originalBytes:originalBytes,counts:priorCounts,truncatedFieldCount:changes,fields,
   contentBytes,serializedContentBytes,responseLimitExceededByReview:false,verboseAvailable:true};
  for(const key of ['artifact','artifactRoot','diagnostics'])if(prior[key]!==undefined)result.payload[key]=bytes(prior[key])<=1024?structuredClone(prior[key]):visit(prior[key],`payload.${key}`,0);
  // Leave room for the artifact reference attached after the original has been written.
  if(bytes(result)<=MAX_JOB_RESPONSE_BYTES-1024)return result;
  if(keyLimit===0){
   // A complete review may itself exceed the response budget. Make that exception
   // explicit; command output, raw events and arbitrary text never get it.
   result.payload.reason='response_byte_limit';
   return markResponseLimit(result);
  }
 }
 throw Error('No job payload compaction pass');
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
  return markResponseLimit(reduced);
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
  for(const key of ['status','error','completionPending','implementationProgress','stalled_suspected','poll_after_seconds','owner_available','message','worktree','cwd','worktreeMigration'])if(Object.hasOwn(cloned,key))result[key]=cloned[key];
  return result;
 }catch(e){return diagnostic(cloned,'hydration',e);}
}
