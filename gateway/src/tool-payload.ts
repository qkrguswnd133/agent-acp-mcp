import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
export const MAX_TOOL_RESPONSE_BYTES=18*1024;
const size=(v:unknown)=>Buffer.byteLength(JSON.stringify(v));
const transportSize=(v:unknown)=>size({content:[{type:'text',text:JSON.stringify(v)}]});
function diagnostics(v:any):boolean{return !!v&&typeof v==='object'&&Object.entries(v).some(([k,x])=>(['checks','trackedPids','trackedProcesses','commandExecutions'].includes(k)&&Array.isArray(x)&&x.length>5)||diagnostics(x));}
const clip=(s:string,n:number)=>{const points=Array.from(s);if(points.length<=n)return s;const half=Math.floor(n/2);return points.slice(0,half).join('')+' … [details in artifact] … '+points.slice(-half).join('');};
const worktreeSummaryKeys=['path','branch','state','recordDisposition','head','tipCommit','baseCommit','originalHead','integrationCommit','integrationMethod','branchPreserved','checkoutOnly','integrationVerified','recoveryBranchPreserved','exists','checkoutState','missingTrackedFileCount','trackedFileCount','commitCount','empty','cleanEmpty','changedFileCount','trackedChangedFileCount','untrackedFileCount','ignoredFileCount','ignoredDirectories','ignoredDirectoryCount','ignoredDirectoriesTruncated','ignoredSummary','integratedIntoOriginalHead','patchEquivalentInOriginal','patchEquivalentReason','linkCount','outsideWorktreeLinkCount','linksScanComplete','linksScanErrors','diskBytes','diskBytesComplete','eligible','reason','nextAction'];
const diagnosticArrays=new Set(['checks','trackedPids','trackedProcesses','commandExecutions','commands','removedIgnoredPaths','ignoredArtifactPaths','links','fields']);
const priority=['operation_id','job_id','status','jobStatus','outcome','error','errorKind','message','dry_run','record_only','eligible','reason','text','result','items','total','next_offset','results','skipped','successCount','failureCount','worktree','implementationProgress','activity','completion','completionCriteria','execution','usage','model','effort','sessionId','processWarnings','processCleanupState','processCleanupWarning','processEvidence','processCheck','blockingJob','blockingJobs','ownershipCheck','forgetAudit','processCleanupUnchanged','processWarningAcknowledged','timings','artifact','payload','wait'];

/** Keep semantic rows and deliverable text before reducing diagnostic output.
 * A list of nine worktrees must not become five arbitrary records just because
 * each record carries a large historical PID audit or ignored-file listing. */
function semanticPreview(source:any,stringLimit:number,bodyLimit:number,listLimit:number,depth=0,field=''):any{
 if(typeof source==='string')return clip(source,field==='text'?bodyLimit:stringLimit);
 if(source===null||typeof source!=='object')return source;
 if(depth>12)return '[nested details in artifact]';
 if(Array.isArray(source))return source.map(v=>semanticPreview(v,stringLimit,bodyLimit,listLimit,depth+1,field));
 const out:any={};
 for(const key of [...priority.filter(k=>Object.hasOwn(source,k)),...Object.keys(source).filter(k=>!priority.includes(k))]){
  const value=source[key];
  if(key==='rawEvents'&&(typeof value==='string'||Array.isArray(value))){out[key]=typeof value==='string'?'':[];out.rawEventsBytes=size(value);out.rawEventsTruncated=true;continue;}
  if(key==='items'&&Array.isArray(value)&&value.some(v=>v?.job_id&&v?.worktree)){
   // Preserve every row in normal paginated responses. Only row diagnostics go
   // to the artifact; the caller can still see all jobs and their disposition.
   out.items=value.map(v=>{
    const row=Object.fromEntries(['job_id','jobStatus','status','createdAt','error','reason'].filter(k=>Object.hasOwn(v,k)).map(k=>[k,v[k]]));
    if(v.worktree)row.worktree=Object.fromEntries(worktreeSummaryKeys.filter(k=>Object.hasOwn(v.worktree,k)).map(k=>[k,v.worktree[k]]));
    return semanticPreview(row,stringLimit,bodyLimit,listLimit,depth+1,'item');
   });continue;
  }
  if(Array.isArray(value)){
   const limit=diagnosticArrays.has(key)?5:listLimit;
   // Preserve all provider results (at most three), failures and skip reasons.
   const selected=value.length>limit?[...value.slice(0,Math.ceil(limit/2)),...value.slice(-Math.floor(limit/2))]:value;
   out[key]=selected.map(v=>semanticPreview(v,stringLimit,bodyLimit,listLimit,depth+1,key));
   if(value.length>limit){out[key+'Count']=Math.max(typeof source[key+'Count']==='number'?source[key+'Count']:0,value.length);out[key+'Truncated']=true;}
   if(key==='checks')out.pidDecisions=value.reduce((a:any,r:any)=>{const decision=typeof r?.decision==='string'?r.decision:'unknown';a[decision]=(a[decision]??0)+1;return a;},{});
   continue;
  }
  out[key]=semanticPreview(value,stringLimit,bodyLimit,listLimit,depth+1,key);
  if(typeof value==='string'&&out[key]!==value)out[key+'Truncated']=true;
 }
 return out;
}
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
 for(const [limit,bodyLimit,listLimit] of [[1024,Number.MAX_SAFE_INTEGER,100],[256,Number.MAX_SAFE_INTEGER,50],[128,4096,24],[64,1024,10]]){
  const preview=semanticPreview(source,limit,bodyLimit,listLimit),response={...preview,details:{truncated:true,originalBytes:bytes,...(artifact?{artifact}:{}),...(detailError?{error:detailError}:{}),verboseRequested:verbose}};
  if(size(response)<MAX_TOOL_RESPONSE_BYTES&&transportSize(response)<20*1024)return response;
 }
 return {job_id:value?.job_id,operation_id:value?.operation_id,status:value?.status,outcome:value?.outcome,error:value?.error?clip(String(value.error),256):undefined,details:{truncated:true,originalBytes:bytes,artifact,error:detailError},message:'Result exceeds response limit; inspect the complete artifact.'};
}
