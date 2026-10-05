import fs from 'node:fs/promises';
import {validateRunSettings} from './model-settings.js';
import {workspaceConflict,workspaceConflictMessage} from './workspace-lock.js';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {RunInput} from './types.js';
import {createManagedWorktree,inspectManagedWorktree,cleanupManagedWorktree,type ManagedWorktree} from './managed-worktree.js';
import {persistJobPayload,presentJobPayload} from './job-payload.js';

type Runner=(kind:string,input:RunInput,signal:AbortSignal,hooks:{onActivity:(event:Record<string,unknown>)=>void})=>Promise<any>;
type Status='queued'|'running'|'cancelling'|'completed'|'failed'|'cancelled'|'interrupted';
interface Job {worktree?:ManagedWorktree;provider?:string;job_id:string;kind:string;cwd:string;ownerPid:number;status:Status;startedAt:string;lastActivityAt:string;finishedAt?:string;activity?:Record<string,unknown>;result?:any;error?:string;}
interface Active {job:Job;controller:AbortController;done:Promise<void>;writes:Promise<void>;dirty:boolean;finalizing?:boolean;}
const terminal=new Set<Status>(['completed','failed','cancelled','interrupted']);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function ownerAlive(pid:unknown){if(!Number.isSafeInteger(pid)||Number(pid)<1)return true;try{process.kill(Number(pid),0);return true;}catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH';}}
interface CleanupOptions {dryRun?:boolean;verified?:boolean;emptyOnly?:boolean;automatic?:boolean}
export class JobManager {
  private active=new Map<string,Active>();
  private closing=false;
  private starting:Promise<unknown>=Promise.resolve();
  private maintenanceCheck:()=>void=()=>{};
  private pendingStarts=0;
  private preflight:((input:RunInput)=>Promise<unknown>)|undefined;
  setPreflight(check:(input:RunInput)=>Promise<unknown>){this.preflight=check;}
  constructor(private directory:string,private runner:Runner,private stallMs=15*60*1000){}
  setMaintenanceCheck(check:()=>void){this.maintenanceCheck=check;}
  isIdle(){return ![...this.active.values()].some(e=>!terminal.has(e.job.status)||e.finalizing)&&this.pendingStarts===0;}
  private file(id:string){if(!uuid.test(id))throw Error('Invalid job_id');return path.join(this.directory,id+'.json');}
  private async save(job:Job){
    await fs.mkdir(this.directory,{recursive:true});
    const destination=this.file(job.job_id),tmp=destination+'.'+randomUUID()+'.tmp';
    const stored=await persistJobPayload(job,this.directory);
    try{await fs.writeFile(tmp,JSON.stringify(stored,null,2),'utf8');await fs.rename(tmp,destination);}finally{await fs.unlink(tmp).catch(()=>{});}
  }
  private persist(entry:Active){
    // Serialize writes; snapshot now so late progress cannot overwrite completion.
    const snapshot=structuredClone(entry.job);entry.dirty=false;
    entry.writes=entry.writes.catch(()=>{}).then(()=>this.save(snapshot));
    return entry.writes;
  }
  start(kind:string,input:RunInput){
    this.maintenanceCheck();this.pendingStarts++;
    const result=this.starting.then(()=>this.startExclusive(kind,input)).finally(()=>{this.pendingStarts--;});
    this.starting=result.catch(()=>{});return result;
  }
  private async startExclusive(kind:string,input:RunInput){
    this.maintenanceCheck();
    validateRunSettings(input);
    if(this.closing)throw Error('Bridge is shutting down');
    this.maintenanceCheck();
    if(!path.isAbsolute(input.cwd))throw Error('cwd must be absolute');
    let cwd=await fs.realpath(input.cwd);
    if(!(await fs.stat(cwd)).isDirectory())throw Error('cwd must be a directory');
    if(this.closing)throw Error('Bridge is shutting down');
    this.maintenanceCheck();

    const conflict=[...this.active.values()].find(e=>!terminal.has(e.job.status)&&workspaceConflict({cwd,kind},e.job));
    const isolate=kind==='agent_implement'&&(input.workspace_mode==='isolated'||(input.workspace_mode==='auto'&&!!conflict));
    if(conflict&&!isolate)throw Error(workspaceConflictMessage({...conflict.job,provider:typeof conflict.job.activity?.provider==='string'?conflict.job.activity.provider:conflict.job.provider}));
    const id=randomUUID();let worktree:ManagedWorktree|undefined;
    // Prevalidate every candidate before managed-worktree or provider writes.
    await this.preflight?.(input);
    if(this.closing)throw Error('Bridge is shutting down');
    this.maintenanceCheck();
    if(isolate){const prepared=await createManagedWorktree({...input,cwd},id);input=prepared.input;cwd=input.cwd;worktree=prepared.worktree;
      if(this.closing)throw Error(`Bridge is shutting down; newly created worktree preserved at ${worktree.path}`);
      this.maintenanceCheck();
      if([...this.active.values()].some(e=>!terminal.has(e.job.status)&&workspaceConflict({cwd,kind},e.job)))throw Error(`Managed worktree overlaps active work; preserved at ${worktree.path}`);
    }
    this.maintenanceCheck();
    const now=new Date().toISOString();
    const job:Job={job_id:id,kind,cwd,...(worktree?{worktree}:{}),provider:input.provider??'auto',ownerPid:process.pid,status:'queued',startedAt:now,lastActivityAt:now};
    const entry:Active={job,controller:new AbortController(),done:Promise.resolve(),writes:Promise.resolve(),dirty:false};
    this.active.set(job.job_id,entry);
    const initial=this.persist(entry);
    entry.done=initial.then(()=>this.execute(entry,{...input,cwd}),()=>{this.active.delete(job.job_id);});
    await initial;
    return {job_id:job.job_id,status:job.status,cwd:job.cwd,...(worktree?{worktree}:{}),poll_after_seconds:5,message:'Task accepted. Use agent_job_wait or agent_job_status until terminal; do not report completion or start fallback while active. Clean empty worktrees are automatically removed; changes and commits require parent review.'};
  }
  private async execute(entry:Active,input:RunInput){
    const {job,controller}=entry;
    const flush=setInterval(()=>{if(entry.dirty)void this.persist(entry).catch(()=>{});},1000);
    try{
      if(controller.signal.aborted){job.status='cancelled';job.error='Cancelled before execution';return;}
      job.status='running';await this.persist(entry);
      job.result=await this.runner(job.kind,input,controller.signal,{onActivity:event=>{
        job.lastActivityAt=new Date().toISOString();job.activity=event;entry.dirty=true;
      }});
      job.status=job.result.errorKind==='cancelled'?'cancelled':job.result.error?'failed':'completed';
    }catch(e){job.status=controller.signal.aborted?'cancelled':'failed';job.error=(e as Error).message;}
    finally{
      clearInterval(flush);entry.finalizing=true;job.finishedAt=new Date().toISOString();
      if(job.worktree?.state==='preserved'){
        // The runner has returned and released its process/workspace ownership.
        // Never delete changed or committed work, including on cancellation.
        try{await this.persist(entry);await this.cleanupWorktree(job.job_id,'HEAD','No changes or commits produced',{emptyOnly:true,automatic:true});}
        catch(error){(job as any).worktreeCleanup={state:'preserved',reason:error instanceof Error?error.message:String(error)};}
      }
      // Persistence failure must not become an unhandled rejection or erase the in-memory result.
      try{await this.persist(entry);this.active.delete(job.job_id);}catch{job.error=(job.error??'')+' Job state persistence failed; retain this result.';}finally{entry.finalizing=false;}
    }
  }
  private async readJob(id:string){
    this.file(id);
    const entry=this.active.get(id);
    const job:Job=entry?structuredClone(entry.job):JSON.parse(await fs.readFile(this.file(id),'utf8'));
    if(job.job_id!==id)throw Error('Job record identity mismatch');
    if(!entry&&!terminal.has(job.status)){
      const alive=ownerAlive(job.ownerPid);
      if(!alive||job.ownerPid===process.pid){job.status='interrupted';job.error='Bridge process ended before completion. Inspect partial edits; no automatic replay.';}
      else return {...job,implementationProgress:implementationProgress(job.kind,job.activity),owner_available:false,stalled_suspected:false,poll_after_seconds:15,message:'Owned by another bridge process. Use that process to cancel; do not replay.'};
    }
    const suspected=job.status==='running'&&Date.now()-Date.parse(job.lastActivityAt)>this.stallMs;
    return {...job,implementationProgress:implementationProgress(job.kind,job.activity,job.finishedAt?Date.parse(job.finishedAt):Date.now()),stalled_suspected:suspected,poll_after_seconds:terminal.has(job.status)?0:15};
  }
  async status(id:string,verbose=false){
    const job=await this.readJob(id);
    if(this.active.get(id)?.finalizing)Object.assign(job,{status:'running',completionPending:true,poll_after_seconds:1});
    return presentJobPayload(job,{verbose,jobsDirectory:this.directory});
  }
  async wait(id:string,timeoutSeconds=25,verbose=false,signal?:AbortSignal){
    if(!Number.isFinite(timeoutSeconds)||timeoutSeconds<0||timeoutSeconds>60)throw Error('timeout_seconds must be between 0 and 60');
    const deadline=Date.now()+timeoutSeconds*1000;
    for(;;){
      const job=await this.readJob(id),finalizing=!!this.active.get(id)?.finalizing;
      const finished=terminal.has(job.status)&&!finalizing;
      if(finished||signal?.aborted||Date.now()>=deadline){
        const value=await this.status(id,verbose);return presentJobPayload({...value,wait:{completed:finished,timed_out:!finished&&!signal?.aborted,cancelled:!!signal?.aborted}},{verbose,jobsDirectory:this.directory});
      }
      await new Promise<void>(resolve=>{let timer:NodeJS.Timeout;const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',done);resolve();};timer=setTimeout(done,Math.min(500,Math.max(0,deadline-Date.now())));signal?.addEventListener('abort',done,{once:true});if(signal?.aborted)done();});
    }
  }
  async cancel(id:string){
    const entry=this.active.get(id);
    if(!entry){const job=await this.status(id);if(!terminal.has(job.status))throw Error('Cannot cancel a job owned by another bridge process');return job;}
    if(!terminal.has(entry.job.status)){
      entry.job.status='cancelling';entry.controller.abort();await this.persist(entry);
    }
    return this.status(id);
  }
  async worktreeStatus(id:string){
    const job=await this.readJob(id);if(!job.worktree)throw Error('Job has no managed worktree');
    return {job_id:id,jobStatus:job.status,worktree:await inspectManagedWorktree(job.worktree)};
  }
  cleanupWorktree(id:string,integrationRef='HEAD',verificationSummary='',options:CleanupOptions={}){
    this.file(id);
    const result=this.starting.then(()=>this.cleanupExclusive(id,integrationRef,verificationSummary,options));
    this.starting=result.catch(()=>{});return result;
  }
  private async cleanupExclusive(id:string,integrationRef:string,verificationSummary:string,options:CleanupOptions){
    this.maintenanceCheck();
    let job=await this.readJob(id);if(!job.worktree)throw Error('Job has no managed worktree');
    // Destructive decisions must inspect complete evidence, never a response preview.
    if((job as any).payload?.artifact){job=await presentJobPayload(job,{verbose:true,jobsDirectory:this.directory});if((job as any).payload?.diagnostics)throw Error('Full job evidence is unavailable; worktree preserved');}
    if(!job.worktree)throw Error('Job has no managed worktree');
    if(!terminal.has(job.status))throw Error('Running or owned jobs are preserved');
    if(job.status==='interrupted')throw Error('Interrupted owner may have surviving child processes; manual workspace review is required');
    if(!options.automatic&&this.active.get(id)?.finalizing)throw Error('Job is still finalizing; preserved');
    if(job.worktree.state==='removed')return {job_id:id,worktree:job.worktree,already_removed:true};
    if(job.result?.childCleanedUp===false||job.result?.results?.some((r:any)=>r.childCleanedUp===false))throw Error('Provider child cleanup is unconfirmed; worktree preserved');
    const lockFile=this.file(id)+'.cleanup.lock';
    const lock=options.dryRun?undefined:await fs.open(lockFile,'wx').catch(()=>{throw Error('Worktree cleanup already in progress; preserved');});
    try{
    const inspection=await cleanupManagedWorktree(job.worktree,integrationRef,verificationSummary,{dryRun:true,emptyOnly:options.emptyOnly});
    if(!inspection.eligible)throw Error(inspection.reason??'Worktree not eligible for cleanup');
    const empty=inspection.empty===true;
    if(!empty&&(job.status!=='completed'||job.result?.error))throw Error('Failed, cancelled or incomplete jobs with commits are preserved; parent review required');
    if(!empty&&!options.dryRun&&(options.verified===false||!verificationSummary.trim()))throw Error('Parent verification and summary are required');
    // Conservatively protect work owned by other live gateway processes sharing job storage.
    for(const name of await fs.readdir(this.directory)){
      if(!name.endsWith('.json'))continue;
      let other:Job;try{other=JSON.parse(await fs.readFile(path.join(this.directory,name),'utf8'));}catch{throw Error('Unreadable job record; cannot confirm idle workspace');}
      if(other.job_id===id||terminal.has(other.status)||!other.cwd)continue;
      const alive=ownerAlive(other.ownerPid);
      if(alive&&(workspaceConflict({cwd:job.worktree.path,kind:'agent_implement'},other)||(!empty&&workspaceConflict({cwd:job.worktree.originalCwd,kind:'agent_implement'},other))))throw Error('Original or isolated workspace has an active job; preserved');
    }
    if([...this.active.values()].some(e=>e.job.job_id!==id&&(!terminal.has(e.job.status)||e.finalizing)&&(workspaceConflict({cwd:job.worktree!.path,kind:'agent_implement'},e.job)||(!empty&&workspaceConflict({cwd:job.worktree!.originalCwd,kind:'agent_implement'},e.job)))))throw Error('Original or isolated workspace still has an active job');
    if(options.dryRun)return {job_id:id,worktree:inspection,dry_run:true,eligible:true,requires_parent_verification:!empty};
    job.worktree=await cleanupManagedWorktree(job.worktree,integrationRef,verificationSummary,{emptyOnly:options.emptyOnly});
    const entry=this.active.get(id);if(entry)entry.job.worktree=job.worktree;
    this.warningCache=undefined;
    await this.save(job);return {job_id:id,worktree:job.worktree};
    }finally{if(lock){await lock.close();await fs.unlink(lockFile).catch(()=>{});}}
  }
  async cleanupWorktrees(ids:string[],integrationRef='HEAD',summary='',options:CleanupOptions={}){
    if(!ids.length||ids.length>50)throw Error('Provide 1 to 50 job IDs');
    const results=[];for(const id of [...new Set(ids)]){try{results.push({ok:true,...await this.cleanupWorktree(id,integrationRef,summary,options)});}catch(error){results.push({job_id:id,ok:false,eligible:false,reason:error instanceof Error?error.message:String(error)});}}
    return {dry_run:!!options.dryRun,results};
  }
  private async recordedWorktrees(){
    let names:string[];try{names=await fs.readdir(this.directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
    const jobs:Job[]=[];for(const name of names){if(!uuid.test(name.replace(/\.json$/,''))||!name.endsWith('.json'))continue;try{const job=await this.readJob(name.slice(0,-5));if(job.worktree)jobs.push(job);}catch{}}
    return jobs.sort((a,b)=>a.job_id.localeCompare(b.job_id));
  }
  async listWorktrees(offset=0,limit=50,includeRemoved=false){
    const jobs=(await this.recordedWorktrees()).filter(job=>includeRemoved||job.worktree!.state!=='removed');
    const items=[];for(const job of jobs.slice(offset,offset+limit)){try{const {changes,changedFiles,...worktree}=await inspectManagedWorktree(job.worktree!) as any;items.push({job_id:job.job_id,jobStatus:job.status,createdAt:job.worktree!.createdAt??job.startedAt,worktree});}catch(error){items.push({job_id:job.job_id,jobStatus:job.status,createdAt:job.startedAt,error:error instanceof Error?error.message:String(error)});}}
    return {items,total:jobs.length,next_offset:offset+limit<jobs.length?offset+limit:null};
  }
  private warningCache?:{at:number;value:any};
  async worktreeWarnings(){
    if(this.warningCache&&Date.now()-this.warningCache.at<60000)return this.warningCache.value;
    try{const jobs=(await this.recordedWorktrees()).filter(job=>job.worktree!.state!=='removed'&&Date.now()-Date.parse(job.worktree!.createdAt??job.startedAt)>14*86400000);
      const value={olderThanDays:14,count:jobs.length,job_ids:jobs.slice(0,20).map(job=>job.job_id),note:jobs.length?'Old managed worktree records remain; inspect agent_worktree_list before cleanup.':null};this.warningCache={at:Date.now(),value};return value;
    }catch{return {olderThanDays:14,count:null,note:'Worktree inventory unavailable'};}
  }
  async close(){
    this.closing=true;
    await this.starting;
    const entries=[...this.active.values()];
    for(const e of entries){if(!terminal.has(e.job.status)){e.job.status='cancelling';e.controller.abort();}}
    await Promise.all(entries.map(e=>e.done));
  }
}
import {implementationProgress} from './execution-evidence.js';
