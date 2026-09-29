import fs from 'node:fs/promises';
import {validateRunSettings} from './model-settings.js';
import {workspaceConflict,workspaceConflictMessage} from './workspace-lock.js';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {RunInput} from './types.js';
import {createManagedWorktree,inspectManagedWorktree,cleanupManagedWorktree,type ManagedWorktree} from './managed-worktree.js';

type Runner=(kind:string,input:RunInput,signal:AbortSignal,hooks:{onActivity:(event:Record<string,unknown>)=>void})=>Promise<any>;
type Status='queued'|'running'|'cancelling'|'completed'|'failed'|'cancelled'|'interrupted';
interface Job {worktree?:ManagedWorktree;provider?:string;job_id:string;kind:string;cwd:string;ownerPid:number;status:Status;startedAt:string;lastActivityAt:string;finishedAt?:string;activity?:Record<string,unknown>;result?:any;error?:string;}
interface Active {job:Job;controller:AbortController;done:Promise<void>;writes:Promise<void>;dirty:boolean;}
const terminal=new Set<Status>(['completed','failed','cancelled','interrupted']);
export class JobManager {
  private active=new Map<string,Active>();
  private closing=false;
  private starting:Promise<unknown>=Promise.resolve();
  private maintenanceCheck:()=>void=()=>{};
  private pendingStarts=0;
  constructor(private directory:string,private runner:Runner,private stallMs=15*60*1000){}
  setMaintenanceCheck(check:()=>void){this.maintenanceCheck=check;}
  isIdle(){return this.active.size===0&&this.pendingStarts===0;}
  private file(id:string){if(!/^[0-9a-f-]{36}$/i.test(id))throw Error('Invalid job_id');return path.join(this.directory,id+'.json');}
  private async save(job:Job){
    await fs.mkdir(this.directory,{recursive:true});
    const destination=this.file(job.job_id),tmp=destination+'.tmp';
    await fs.writeFile(tmp,JSON.stringify(job,null,2),'utf8');
    await fs.rename(tmp,destination);
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
    return {job_id:job.job_id,status:job.status,cwd:job.cwd,...(worktree?{worktree}:{}),poll_after_seconds:5,message:'Task accepted. Poll agent_job_status until terminal; do not report completion or start fallback while active. Managed worktrees are preserved until parent integration and verification.'};
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
      clearInterval(flush);job.finishedAt=new Date().toISOString();
      // Persistence failure must not become an unhandled rejection or erase the in-memory result.
      try{await this.persist(entry);this.active.delete(job.job_id);}catch{job.error=(job.error??'')+' Job state persistence failed; retain this result.';}
    }
  }
  async status(id:string){
    const entry=this.active.get(id);
    const job:Job=entry?structuredClone(entry.job):JSON.parse(await fs.readFile(this.file(id),'utf8'));
    if(!entry&&!terminal.has(job.status)){
      let alive=false;try{process.kill(job.ownerPid,0);alive=true;}catch{}
      if(!alive||job.ownerPid===process.pid){job.status='interrupted';job.error='Bridge process ended before completion. Inspect partial edits; no automatic replay.';}
      else return {...job,implementationProgress:implementationProgress(job.kind,job.activity),owner_available:false,stalled_suspected:false,poll_after_seconds:15,message:'Owned by another bridge process. Use that process to cancel; do not replay.'};
    }
    const suspected=job.status==='running'&&Date.now()-Date.parse(job.lastActivityAt)>this.stallMs;
    return {...job,implementationProgress:implementationProgress(job.kind,job.activity,job.finishedAt?Date.parse(job.finishedAt):Date.now()),stalled_suspected:suspected,poll_after_seconds:terminal.has(job.status)?0:15};
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
    const job=await this.status(id);if(!job.worktree)throw Error('Job has no managed worktree');
    return {job_id:id,jobStatus:job.status,worktree:await inspectManagedWorktree(job.worktree)};
  }
  cleanupWorktree(id:string,integrationRef:string,verificationSummary:string){
    const result=this.starting.then(()=>this.cleanupExclusive(id,integrationRef,verificationSummary));
    this.starting=result.catch(()=>{});return result;
  }
  private async cleanupExclusive(id:string,integrationRef:string,verificationSummary:string){
    const job=await this.status(id);if(!job.worktree)throw Error('Job has no managed worktree');
    if(job.status!=='completed'||job.result?.error)throw Error('Failed, cancelled, incomplete or running jobs are preserved; parent must review and handle manually');
    if(!verificationSummary.trim())throw Error('Parent verification summary is required');
    // Conservatively protect work owned by other live gateway processes sharing job storage.
    for(const name of await fs.readdir(this.directory)){
      if(!name.endsWith('.json'))continue;
      let other:Job;try{other=JSON.parse(await fs.readFile(path.join(this.directory,name),'utf8'));}catch{continue;}
      if(other.job_id===id||terminal.has(other.status)||!other.cwd)continue;
      let alive=false;try{process.kill(other.ownerPid,0);alive=true;}catch{}
      if(alive&&(workspaceConflict({cwd:job.worktree.path,kind:'agent_implement'},other)||workspaceConflict({cwd:job.worktree.originalCwd,kind:'agent_implement'},other)))throw Error('Original or isolated workspace has an active job; preserved');
    }
    if([...this.active.values()].some(e=>!terminal.has(e.job.status)&&(workspaceConflict({cwd:job.worktree!.path,kind:'agent_implement'},e.job)||workspaceConflict({cwd:job.worktree!.originalCwd,kind:'agent_implement'},e.job))))throw Error('Original or isolated workspace still has an active job');
    job.worktree=await cleanupManagedWorktree(job.worktree,integrationRef,verificationSummary);
    await this.save(job);return {job_id:id,worktree:job.worktree};
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
