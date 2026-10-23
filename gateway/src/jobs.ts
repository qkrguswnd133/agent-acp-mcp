import fs from 'node:fs/promises';
import {validateRunSettings} from './model-settings.js';
import {workspaceConflict,workspaceConflictMessage} from './workspace-lock.js';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {RunInput} from './types.js';
import {createManagedWorktree,inspectManagedWorktree,cleanupManagedWorktree,cleanupJobCreatedIgnoredArtifacts,migrateManagedWorktree,rollbackManagedWorktreeMigration,recoverManagedWorktree,forgetManagedWorktree,type ManagedWorktree} from './managed-worktree.js';
import {persistJobPayload,presentJobPayload} from './job-payload.js';
import {verifyInterruptedOwnership,verifyFinishedOwnership} from './interrupted-ownership.js';
import {classifyProcessCleanup,verifyTrackedProcessesAbsent} from './process-cleanup.js';
import {acquireMaintenanceLock} from './maintenance-lock.js';
import {readProcessInventory,validCreationTime,type ProcessInventory} from './process-inventory.js';
import {inspectWorktreeLinks} from './worktree-links.js';
import {replaceRecord} from './atomic-record.js';

type Runner=(kind:string,input:RunInput,signal:AbortSignal,hooks:{onActivity:(event:Record<string,unknown>)=>void})=>Promise<any>;
type Status='queued'|'running'|'cancelling'|'completed'|'failed'|'cancelled'|'interrupted';
interface Job {worktree?:ManagedWorktree;provider?:string;job_id:string;kind:string;cwd:string;ownerPid:number;status:Status;startedAt:string;lastActivityAt:string;finishedAt?:string;activity?:Record<string,unknown>;runtimeEvidence?:Record<string,unknown>;maintenanceLockRecovery?:unknown[];result?:any;error?:string;}
interface Active {job:Job;controller:AbortController;done:Promise<void>;writes:Promise<void>;dirty:boolean;finalizing?:boolean;}
const terminal=new Set<Status>(['completed','failed','cancelled','interrupted']);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function ownerAlive(pid:unknown){if(!Number.isSafeInteger(pid)||Number(pid)<1)return true;try{process.kill(Number(pid),0);return true;}catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH';}}
function unconfirmedChildCleanup(result:any):boolean{const evidence=classifyProcessCleanup(result);return evidence.reported&&evidence.state!=='verified';}
function freshProcessEvidenceAvailable(result:any):boolean{
 if(!result||typeof result!=='object')return true;
 if(result.childCleanedUp===false&&!result.processCleanup)return false;
 if(result.processCleanup&&(!Array.isArray(result.processCleanup.trackedPids)||!Array.isArray(result.processCleanup.remainingPids)))return false;
 return !Array.isArray(result.results)||result.results.every(freshProcessEvidenceAvailable);
}
interface CleanupOptions {dryRun?:boolean;verified?:boolean;emptyOnly?:boolean;automatic?:boolean;allowPatchEquivalent?:boolean;preserveBranch?:boolean;idleConfirmed?:boolean;removeIgnoredArtifacts?:boolean;unlinkLinks?:boolean;onPhase?:(name:string,ms:number)=>void}
export const MAX_JOB_WAIT_SECONDS=25;
function stallEvidence(job:Job,stallMs:number){
 const last=Date.parse(job.lastActivityAt),idleMs=Number.isFinite(last)?Math.max(0,Date.now()-last):null;
 const active=!terminal.has(job.status),completedAt=job.runtimeEvidence?.turnCompletedAt??job.runtimeEvidence?.codexTurnCompletedAt??null;
 const suspected=active&&idleMs!==null&&idleMs>stallMs;
 return {stalled_suspected:suspected,stallEvidence:{lastActivityAt:job.lastActivityAt??null,idleMs,thresholdMs:stallMs,turnCompletedAt:completedAt,turnCompletedWithoutFurtherOutput:active&&!!completedAt&&idleMs!==null&&idleMs>5000,cpuIdle:'unavailable',reasons:[...(suspected?['no_activity_beyond_threshold']:[]),...(active&&!!completedAt&&idleMs!==null&&idleMs>5000?['turn_completed_without_further_output']:[])],automaticCancellation:false}};
}
interface WorktreeMaintenanceOptions {dryRun?:boolean;targetRoot?:string;verified?:boolean;summary?:string;idleConfirmed?:boolean;acknowledgeProcessWarning?:boolean;unlinkLinks?:boolean;onPhase?:(name:string,ms:number)=>void}
export class JobManager {
  private active=new Map<string,Active>();
  private closing=false;
  private starting:Promise<unknown>=Promise.resolve();
  private maintenanceCheck:()=>void|Promise<void>=()=>{};
  private maintenanceTasks=new Set<Promise<unknown>>();
  private maintenanceReservations=new Map<string,string[]>();
  private pendingStarts=0;
  private preflight:((input:RunInput)=>Promise<unknown>)|undefined;
  setPreflight(check:(input:RunInput)=>Promise<unknown>){this.preflight=check;}
  constructor(private directory:string,private runner:Runner,private stallMs=15*60*1000,private interruptedOwnership=verifyInterruptedOwnership,private finishedOwnership=verifyFinishedOwnership,private trackedProcessesAbsent=verifyTrackedProcessesAbsent){}
  setMaintenanceCheck(check:()=>void|Promise<void>){this.maintenanceCheck=check;}
  isIdle(){return ![...this.active.values()].some(e=>!terminal.has(e.job.status)||e.finalizing)&&this.pendingStarts===0&&this.maintenanceTasks.size===0;}
  private file(id:string){if(!uuid.test(id))throw Error('Invalid job_id');return path.join(this.directory,id+'.json');}
  private async save(job:Job,recordOnly?:{expected:string}){
    await fs.mkdir(this.directory,{recursive:true});
    const destination=this.file(job.job_id),tmp=destination+'.'+randomUUID()+'.tmp';
    const stored=recordOnly?structuredClone(job):await persistJobPayload(job,this.directory);
    try{await fs.writeFile(tmp,JSON.stringify(stored,null,2),'utf8');await replaceRecord(tmp,destination,{beforeAttempt:async()=>{if(recordOnly&&await fs.readFile(destination,'utf8')!==recordOnly.expected)throw Error('Job record changed during forget; preserved');}});}finally{await fs.unlink(tmp).catch(()=>{});}
  }
  private persist(entry:Active){
    // Serialize writes; snapshot now so late progress cannot overwrite completion.
    const snapshot=structuredClone(entry.job);entry.dirty=false;
    entry.writes=entry.writes.catch(()=>{}).then(()=>this.save(snapshot));
    return entry.writes;
  }
  start(kind:string,input:RunInput){
    this.pendingStarts++;
    const result=this.starting.then(()=>this.startExclusive(kind,input)).finally(()=>{this.pendingStarts--;});
    this.starting=result.catch(()=>{});return result;
  }
  private async startExclusive(kind:string,input:RunInput){
    await this.maintenanceCheck();
    validateRunSettings(input);
    if(this.closing)throw Error('Bridge is shutting down');
    await this.maintenanceCheck();
    if(!path.isAbsolute(input.cwd))throw Error('cwd must be absolute');
    let cwd=await fs.realpath(input.cwd);
    this.assertNoMaintenanceConflict(cwd,kind);
    if(!(await fs.stat(cwd)).isDirectory())throw Error('cwd must be a directory');
    if(this.closing)throw Error('Bridge is shutting down');
    await this.maintenanceCheck();

    const conflict=[...this.active.values()].find(e=>(!terminal.has(e.job.status)||e.finalizing)&&workspaceConflict({cwd,kind},e.job));
    const isolate=kind==='agent_implement'&&(input.workspace_mode==='isolated'||(input.workspace_mode==='auto'&&!!conflict));
    if(conflict&&!isolate)throw Error(workspaceConflictMessage({...conflict.job,provider:typeof conflict.job.activity?.provider==='string'?conflict.job.activity.provider:conflict.job.provider}));
    const id=randomUUID();let worktree:ManagedWorktree|undefined;
    // Prevalidate every candidate before managed-worktree or provider writes.
    await this.preflight?.(input);
    this.assertNoMaintenanceConflict(cwd,kind);
    if(this.closing)throw Error('Bridge is shutting down');
    await this.maintenanceCheck();
    if(isolate){const prepared=await createManagedWorktree({...input,cwd},id);input=prepared.input;cwd=input.cwd;worktree=prepared.worktree;
      if(this.closing)throw Error(`Bridge is shutting down; newly created worktree preserved at ${worktree.path}`);
      await this.maintenanceCheck();
      if([...this.active.values()].some(e=>!terminal.has(e.job.status)&&workspaceConflict({cwd,kind},e.job)))throw Error(`Managed worktree overlaps active work; preserved at ${worktree.path}`);
    }
    await this.maintenanceCheck();
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
        if(['codex_turn_completed','claude_turn_completed','grok_turn_completed'].includes(String(event.type)))job.runtimeEvidence={...job.runtimeEvidence,turnCompletedAt:job.lastActivityAt,completedProvider:event.provider??String(event.type).split('_')[0],...(event.type==='codex_turn_completed'?{codexTurnCompletedAt:job.lastActivityAt}:{})};
        if(event.type==='process_cleanup')job.runtimeEvidence={...job.runtimeEvidence,processCleanup:event};
      }});
      job.status=job.result.errorKind==='cancelled'?'cancelled':job.result.error?'failed':'completed';
    }catch(e){job.status=controller.signal.aborted?'cancelled':'failed';job.error=(e as Error).message;}
    finally{
      clearInterval(flush);entry.finalizing=true;job.finishedAt=new Date().toISOString();
      if(job.worktree?.state==='preserved'){
        if(process.env.AGENT_MCP_AUTO_CLEAN_IGNORED_ARTIFACTS==='true'){
          try{(job as any).worktreeArtifactCleanup=await this.reserveMaintenance(job.job_id,false,()=>this.cleanupGeneratedArtifacts(job));}
          catch(error){(job as any).worktreeArtifactCleanup={eligible:false,warning:true,reason:error instanceof Error?error.message:String(error),...Object.fromEntries(Object.entries(error&&typeof error==='object'?error:{}))};}
        }
        try{
          const links=await inspectWorktreeLinks(job.worktree.path);
          if(links.outsideWorktreeLinkCount||!links.linksScanComplete){
            const warning={kind:'worktree_links',message:links.outsideWorktreeLinkCount?'Worktree has external links. Review before cleanup; targets must remain untouched.':'Worktree link inspection incomplete; parent must inspect before cleanup.',...links};
            job.result={...job.result,handoff:{...job.result?.handoff,requiresWorkspaceReview:true,worktreeLinkWarning:warning}};
          }
        }catch(error){job.result={...job.result,handoff:{...job.result?.handoff,requiresWorkspaceReview:true,worktreeLinkWarning:{kind:'worktree_links',linksScanComplete:false,message:String(error)}}};}

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
      else return {...job,implementationProgress:implementationProgress(job.kind,job.activity),owner_available:false,...stallEvidence(job,this.stallMs),poll_after_seconds:15,message:'Owned by another bridge process. Use that process to cancel; do not replay.'};
    }
    return {...job,implementationProgress:implementationProgress(job.kind,job.activity,job.finishedAt?Date.parse(job.finishedAt):Date.now()),...stallEvidence(job,this.stallMs),poll_after_seconds:terminal.has(job.status)?0:15};
  }
  async status(id:string,verbose=false){
    const job=await this.readJob(id);
    if(this.active.get(id)?.finalizing)Object.assign(job,{status:'running',completionPending:true,poll_after_seconds:1});
    return presentJobPayload(job,{verbose,jobsDirectory:this.directory});
  }
  async wait(id:string,timeoutSeconds=25,verbose=false,signal?:AbortSignal){
    if(!Number.isFinite(timeoutSeconds)||timeoutSeconds<0||timeoutSeconds>60)throw Error('timeout_seconds must be between 0 and 60');
    // Keep accepting legacy 60-second calls but return before common host deadlines.
    const effectiveTimeout=Math.min(timeoutSeconds,MAX_JOB_WAIT_SECONDS),deadline=Date.now()+effectiveTimeout*1000;
    for(;;){
      const job=await this.readJob(id),finalizing=!!this.active.get(id)?.finalizing;
      const finished=terminal.has(job.status)&&!finalizing;
      if(finished||signal?.aborted||Date.now()>=deadline){
        const value=await this.status(id,verbose);return presentJobPayload({...value,wait:{completed:finished,timed_out:!finished&&!signal?.aborted,cancelled:!!signal?.aborted,requested_timeout_seconds:timeoutSeconds,effective_timeout_seconds:effectiveTimeout}},{verbose,jobsDirectory:this.directory});
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
  async worktreeStatus(id:string,includeDiskSize=false,verbose=false){
    const job=await this.readJob(id);if(!job.worktree)throw Error('Job has no managed worktree');
    const view=await presentJobPayload(job,{jobsDirectory:this.directory});
    return {job_id:id,jobStatus:job.status,worktree:await inspectManagedWorktree(job.worktree,{includeDiskSize,verbose}),...(view.processEvidence?{processEvidence:view.processEvidence}:{}),...(view.payload?.artifact?{payload:{artifact:view.payload.artifact,artifactRoot:view.payload.artifactRoot}}:{})};
  }
  async exclusiveMaintenance<T>(operation:()=>Promise<T>):Promise<T>{
    await this.maintenanceCheck();
    const result=this.starting.then(async()=>{await this.maintenanceCheck();if(!this.isIdle())throw Error('Gateway has active or pending jobs; maintenance refused');return operation();});
    this.starting=result.catch(()=>{});return result;
  }
  private assertNoMaintenanceConflict(cwd:string,kind:string){
    for(const [id,paths] of this.maintenanceReservations)if(paths.some(target=>workspaceConflict({cwd,kind},{cwd:target,kind:'agent_implement'})))throw Error('Workspace maintenance in progress for job '+id);
  }
  private reserveMaintenance<T>(id:string,recordOnly:boolean,operation:()=>Promise<T>):Promise<T>{
    this.file(id);let reserved=false;
    const reserve=this.starting.then(async()=>{
      await this.maintenanceCheck();if(this.maintenanceReservations.has(id))throw Error('Worktree maintenance already in progress');
      const job=await this.readJob(id);reserved=true;this.maintenanceReservations.set(id,job.worktree?[job.worktree.path]:[job.cwd]);
    });
    this.starting=reserve.catch(()=>{});
    const task=reserve.then(operation).finally(()=>{if(reserved)this.maintenanceReservations.delete(id);this.maintenanceTasks.delete(task);});
    this.maintenanceTasks.add(task);return task;
  }
  cleanupWorktree(id:string,integrationRef='HEAD',verificationSummary='',options:CleanupOptions={}){
    return this.reserveMaintenance(id,false,()=>this.cleanupExclusive(id,integrationRef,verificationSummary,options));
  }
  private async lockAudit(id:string,recovered:unknown[]){
    if(!recovered.length)return;
    const file=this.file(id),before=await fs.readFile(file,'utf8'),job=JSON.parse(before);
    job.maintenanceLockRecovery=[...(job.maintenanceLockRecovery??[]),...recovered];
    await this.save(job,{expected:before});
    const entry=this.active.get(id);if(entry)entry.job.maintenanceLockRecovery=structuredClone(job.maintenanceLockRecovery);
  }
  private async phase<T>(name:string,fn:()=>Promise<T>,report?:((name:string,ms:number)=>void)):Promise<T>{const start=performance.now();try{return await fn();}finally{report?.(name,performance.now()-start);}}
  private async cleanupGeneratedArtifacts(job:Job){
    if(!job.worktree||!terminal.has(job.status)||job.status==='interrupted')throw Error('Generated-artifact cleanup requires a terminal owned job');
    const evidence=classifyProcessCleanup(job.result);
    if(evidence.invalidPids||!freshProcessEvidenceAvailable(job.result))throw Error('Generated-artifact cleanup has insufficient process evidence; preserved');
    let inventory:Promise<ProcessInventory>|undefined;const snapshot=()=>inventory??=readProcessInventory();
    const lock=await acquireMaintenanceLock(this.file(job.job_id)+'.cleanup.lock',{operation:'generated_artifacts',jobId:job.job_id,processInventory:snapshot});
    try{
      await this.assertTargetWorktreeIdle(job.job_id,job.worktree.path,snapshot);
      const trackedProcessCheck=await this.trackedProcessesAbsent(evidence.trackedPids,{snapshot,startedAt:job.startedAt,finishedAt:job.finishedAt,cleanupAt:evidence.cleanupAt,trackedProcesses:evidence.trackedProcesses,rootPids:[...evidence.rootPids,job.ownerPid],rootProcesses:evidence.rootProcesses,rootAnchorSource:'job_owner_and_observed_provider_roots'});
      const reused=new Set(trackedProcessCheck.reusedPids??[]);
      const idleCheck=await this.finishedOwnership({ownerPid:job.ownerPid,workspacePaths:[job.worktree.path],startedAt:job.startedAt,trackedPids:evidence.trackedPids.filter(pid=>!reused.has(pid)),rootPids:evidence.rootPids.filter(pid=>!reused.has(pid))},{snapshot});
      const result=await cleanupJobCreatedIgnoredArtifacts(job.worktree,{dryRun:false,beforeMutation:()=>lock.assertOwned()});
      return {...result,automatic:true,optIn:'AGENT_MCP_AUTO_CLEAN_IGNORED_ARTIFACTS',trackedProcessCheck,idleCheck};
    }finally{await lock.release();}
  }
  /** Maintenance mutates only this isolated checkout. Other jobs sharing the
   * original Git repository do not own it. Persisted owners are rechecked with
   * process creation evidence; a running label alone is not proof of work. */
  private async assertTargetWorktreeIdle(id:string,target:string,snapshot:()=>Promise<ProcessInventory>){
    let staleOwnerRecord=false;
    const overlapping=(job:Job)=>job.job_id!==id&&!!job.cwd&&workspaceConflict({cwd:target,kind:'agent_implement'},job);
    const blocker=(job:Job,liveness:string,currentCreatedAt:string|null=null)=>Object.assign(Error(`Target worktree has an active or unverified job; preserved. Blocking job ${job.job_id}, owner PID ${job.ownerPid}, liveness: ${liveness}`),{blockingJob:{job_id:job.job_id,ownerPid:job.ownerPid,status:job.status,cwd:job.cwd,liveness,currentCreatedAt,lastActivityAt:job.lastActivityAt??null},workspacePath:target});
    for(const entry of this.active.values())if(overlapping(entry.job)&&(!terminal.has(entry.job.status)||entry.finalizing))throw blocker(entry.job,entry.finalizing?'in_process_finalizing':'in_process_active');
    for(const name of await fs.readdir(this.directory)){
      if(!name.endsWith('.json'))continue;
      let other:Job;try{other=JSON.parse(await fs.readFile(path.join(this.directory,name),'utf8'));}catch{throw Error(`Unreadable job record ${name}; cannot confirm target worktree is idle`);}
      if(!overlapping(other)||terminal.has(other.status)||this.active.has(other.job_id))continue;
      // This manager has no live entry for a persisted record owned by itself;
      // readJob reports the same record as interrupted, never running.
      if(other.ownerPid===process.pid){staleOwnerRecord=true;continue;}
      if(!Number.isSafeInteger(other.ownerPid)||other.ownerPid<1)throw blocker(other,'unknown_owner_identity');
      let inventory:ProcessInventory;try{inventory=await snapshot();}catch{throw blocker(other,'inventory_unavailable');}
      const owner=inventory.processes.find(row=>row.pid===other.ownerPid);
      if(!owner){if(inventory.complete){staleOwnerRecord=true;continue;}throw blocker(other,'inventory_incomplete');}
      const created=validCreationTime(owner.createdAt),started=validCreationTime(other.startedAt);
      if(created!==undefined&&started!==undefined&&created>started){staleOwnerRecord=true;continue;}
      throw blocker(other,created===undefined?'owner_creation_unknown':'owner_alive',owner.createdAt);
    }
    return {staleOwnerRecord};
  }
  private async cleanupExclusive(id:string,integrationRef:string,verificationSummary:string,options:CleanupOptions){
    await this.maintenanceCheck();
    let job=await this.readJob(id);const currentStatus=job.status;if(!job.worktree)throw Error('Job has no managed worktree');
    // Destructive decisions must inspect complete evidence, never a response preview.
    if((job as any).payload?.artifact){job=await presentJobPayload(job,{verbose:true,jobsDirectory:this.directory});if((job as any).payload?.diagnostics)throw Error('Full job evidence is unavailable; worktree preserved');}
    job.status=currentStatus;
    if(!job.worktree)throw Error('Job has no managed worktree');
    if(!terminal.has(job.status))throw Error('Running or owned jobs are preserved');
    const interrupted=job.status==='interrupted';
    if(interrupted&&(options.automatic||(!options.dryRun&&(!options.idleConfirmed||!verificationSummary.trim()))))throw Error('Interrupted cleanup requires idle_confirmed=true and a verification summary after parent workspace review');
    if(!options.automatic&&this.active.get(id)?.finalizing)throw Error('Job is still finalizing; preserved');
    if(job.worktree.state==='removed')return {job_id:id,worktree:job.worktree,already_removed:true};
    const cleanupEvidence=classifyProcessCleanup(job.result),cleanupReview=unconfirmedChildCleanup(job.result);
    if(cleanupEvidence.invalidPids)throw Error('Provider child cleanup has invalid tracked PID evidence; worktree preserved');
    if(!interrupted&&cleanupReview&&!freshProcessEvidenceAvailable(job.result))throw Error('Provider child cleanup is unconfirmed and tracked process evidence is unavailable; worktree preserved');
    const recorded=interrupted?JSON.parse(await fs.readFile(this.file(id),'utf8')):undefined;
    if(recorded&&(recorded.job_id!==id||recorded.ownerPid!==job.ownerPid||recorded.cwd!==job.cwd))throw Error('Interrupted job record changed during inspection; preserved');
    const lockFile=this.file(id)+'.cleanup.lock';
    let inventory:Promise<ProcessInventory>|undefined;const snapshot=()=>inventory??=this.phase('process_inventory',()=>readProcessInventory(),options.onPhase);
    const lock=await this.phase('lock',()=>acquireMaintenanceLock(lockFile,{operation:options.dryRun?'cleanup_dry_run':'cleanup',jobId:id,processInventory:snapshot}),options.onPhase);
    try{
    await this.lockAudit(id,lock.recovered);
    if(lock.recovered.length)job.maintenanceLockRecovery=[...(job.maintenanceLockRecovery??[]),...lock.recovered];
    const reviewedFailure=job.status==='failed'||job.status==='cancelled'||(job.status==='completed'&&!!job.result?.error);
    // Failed/cancelled committed work requires actual ancestry, never patch equivalence.
    const allowPatchEquivalent=reviewedFailure?false:options.allowPatchEquivalent;
    const inspection=await this.phase('worktree_scan',()=>cleanupManagedWorktree(job.worktree!,integrationRef,verificationSummary,{dryRun:true,emptyOnly:options.emptyOnly,allowPatchEquivalent,preserveBranch:options.preserveBranch,removeIgnoredArtifacts:options.removeIgnoredArtifacts,unlinkLinks:options.unlinkLinks,onPhase:options.onPhase,beforeMutation:()=>lock.assertOwned()}),options.onPhase);
    if(!inspection.eligible)throw Object.assign(Error(inspection.reason??'Worktree not eligible for cleanup'),inspection);
    const empty=inspection.empty===true;
    const requiresFailureReview=!empty&&reviewedFailure;
    if(requiresFailureReview&&(options.automatic||(!options.dryRun&&(!options.idleConfirmed||options.verified!==true||!verificationSummary.trim()))))throw Error('Failed or cancelled committed work requires verified=true, idle_confirmed=true and verification_summary after parent review');
    if((!empty||options.preserveBranch)&&!options.dryRun&&(options.verified!==true||!verificationSummary.trim()))throw Error('Parent verification and summary are required');
    const targetIdle=await this.assertTargetWorktreeIdle(id,job.worktree.path,snapshot);
    const ownershipInput={ownerPid:job.ownerPid,workspacePaths:[job.worktree.path],startedAt:job.startedAt,trackedPids:cleanupEvidence.trackedPids,rootPids:cleanupEvidence.rootPids};
    const processContext={snapshot,startedAt:job.startedAt,finishedAt:job.finishedAt,cleanupAt:cleanupEvidence.cleanupAt??(job.runtimeEvidence?.processCleanup as any)?.at,trackedProcesses:cleanupEvidence.trackedProcesses,rootPids:[...cleanupEvidence.rootPids,...(Number.isSafeInteger(job.ownerPid)&&job.ownerPid>0?[job.ownerPid]:[])],rootProcesses:cleanupEvidence.rootProcesses,rootAnchorSource:'job_owner_and_observed_provider_roots'};
    let trackedProcessCheck=cleanupReview?await this.phase('pid_check',()=>this.trackedProcessesAbsent(cleanupEvidence.trackedPids,processContext),options.onPhase):undefined;
    if(trackedProcessCheck?.reusedPids?.length){const reused=new Set(trackedProcessCheck.reusedPids);ownershipInput.trackedPids=ownershipInput.trackedPids.filter(pid=>!reused.has(pid));ownershipInput.rootPids=ownershipInput.rootPids.filter(pid=>!reused.has(pid));}
    const idleCheck=await (interrupted?this.interruptedOwnership(ownershipInput,{snapshot}):requiresFailureReview||cleanupReview||targetIdle.staleOwnerRecord||lock.recovered.length>0?this.finishedOwnership(ownershipInput,{snapshot}):Promise.resolve(undefined)).catch(error=>{if(trackedProcessCheck&&error&&typeof error==='object')error.processCheck=trackedProcessCheck;throw error;});

    if(options.dryRun)return {job_id:id,worktree:inspection,dry_run:true,eligible:true,requires_parent_verification:!empty||options.preserveBranch===true,lockRecovery:lock.recovered,...(interrupted||requiresFailureReview||cleanupReview?{requires_idle_confirmation:interrupted||requiresFailureReview,idleCheck,trackedProcessCheck}:{})};
    try{job.worktree=await this.phase('remove',()=>cleanupManagedWorktree(job.worktree!,integrationRef,verificationSummary,{emptyOnly:options.emptyOnly,allowPatchEquivalent,preserveBranch:options.preserveBranch,removeIgnoredArtifacts:options.removeIgnoredArtifacts,unlinkLinks:options.unlinkLinks,onPhase:options.onPhase,beforeMutation:()=>lock.assertOwned()}),options.onPhase);}
    catch(error){
      if(error&&typeof error==='object'&&('removedIgnoredPaths' in error||'unlinkedPaths' in error)){
        (job as any).worktreeCleanup={state:'preserved',reason:String(error),removedIgnoredPaths:(error as any).removedIgnoredPaths,ignoredArtifactPaths:(error as any).ignoredArtifactPaths,unlinkedPaths:(error as any).unlinkedPaths};
        await this.save(job).catch(()=>{});
      }
      throw error;
    }
    if(requiresFailureReview||cleanupReview)(job as any).worktreeIdleCheck={...idleCheck,trackedProcessCheck,parentConfirmed:options.idleConfirmed===true,automaticFreshCheck:!interrupted&&!requiresFailureReview,verificationSummary};
    if(recorded){job.status=recorded.status;if(recorded.error===undefined)delete job.error;else job.error=recorded.error;(job as any).worktreeIdleCheck={...idleCheck,trackedProcessCheck,parentConfirmed:true,verificationSummary,scope:'owner, descendants and observable workspace references; detached/manual writers reviewed by parent'};}
    const entry=this.active.get(id);if(entry){entry.job.worktree=job.worktree;if((job as any).worktreeIdleCheck)(entry.job as any).worktreeIdleCheck=(job as any).worktreeIdleCheck;}
    this.warningCache=undefined;
    await lock.assertOwned();await this.save(job);return {job_id:id,worktree:job.worktree,lockRecovery:lock.recovered,...(cleanupReview?{idleCheck,trackedProcessCheck}:{})};
    }finally{await lock.release();}
  }
  async cleanupWorktrees(ids:string[],integrationRef='HEAD',summary='',options:CleanupOptions={}){
    if(!ids.length||ids.length>50)throw Error('Provide 1 to 50 job IDs');
    const results=[];for(const id of [...new Set(ids)]){try{results.push({ok:true,...await this.cleanupWorktree(id,integrationRef,summary,options)});}catch(error){results.push({job_id:id,ok:false,eligible:false,reason:error instanceof Error?error.message:String(error),...Object.fromEntries(Object.entries(error&&typeof error==='object'?error:{})),...((error as any)?.removedIgnoredPaths?{removedIgnoredPaths:(error as any).removedIgnoredPaths}:{})});}}
    return {dry_run:!!options.dryRun,results};
  }
  private async recordedWorktrees(){
    let names:string[];try{names=await fs.readdir(this.directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
    const jobs:Job[]=[];for(const name of names){if(!uuid.test(name.replace(/\.json$/,''))||!name.endsWith('.json'))continue;try{const job=await this.readJob(name.slice(0,-5));if(job.worktree)jobs.push(job);}catch{}}
    return jobs.sort((a,b)=>a.job_id.localeCompare(b.job_id));
  }
  async listWorktrees(offset=0,limit=50,includeRemoved=false,includeDiskSize=false,verbose=false){
    const jobs=(await this.recordedWorktrees()).filter(job=>includeRemoved||job.worktree!.state!=='removed');
    const selected=jobs.slice(offset,offset+limit),items:any[]=new Array(selected.length);let next=0;
    await Promise.all(Array.from({length:Math.min(4,selected.length)},async()=>{for(;;){const index=next++;if(index>=selected.length)break;const job=selected[index];try{const {changes,changedFiles,...worktree}=await inspectManagedWorktree(job.worktree!,{includeDiskSize,verbose,includePatchEquivalence:verbose}) as any;items[index]={job_id:job.job_id,jobStatus:job.status,createdAt:job.worktree!.createdAt??job.startedAt,worktree};}catch(error){items[index]={job_id:job.job_id,jobStatus:job.status,createdAt:job.startedAt,error:error instanceof Error?error.message:String(error)};}}}));
    return {items,total:jobs.length,next_offset:offset+limit<jobs.length?offset+limit:null,include_disk_size:includeDiskSize};
  }
  worktreeMaintenance(id:string,action:'migrate'|'restore'|'remove'|'forget',options:WorktreeMaintenanceOptions={}){
    return this.reserveMaintenance(id,action==='forget',()=>this.worktreeMaintenanceExclusive(id,action,options));
  }
  /** Record-only disposition. No process termination or workspace mutation is authorized here. */
  private async forgetWorktreeExclusive(id:string,options:WorktreeMaintenanceOptions){
    await this.maintenanceCheck();
    const file=this.file(id),dryRun=options.dryRun===true;
    let inventory:Promise<ProcessInventory>|undefined;const snapshot=()=>inventory??=this.phase('process_inventory',()=>readProcessInventory(),options.onPhase);
    const lock=await this.phase('lock',()=>acquireMaintenanceLock(file+'.cleanup.lock',{operation:'forget',jobId:id,processInventory:snapshot}),options.onPhase);
    try{
    await this.lockAudit(id,lock.recovered);
      const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw Error('Unsafe job record path; forget refused');
      const before=await fs.readFile(file,'utf8'),stored=JSON.parse(before) as Job;
      if(stored.job_id!==id||!stored.worktree)throw Error('Invalid job/worktree record; preserved');
      const live=this.active.get(id);
      const orphaned=['queued','running','cancelling'].includes(stored.status)&&!ownerAlive(stored.ownerPid);
      if(!terminal.has(stored.status)&&!orphaned||live&&(!terminal.has(live.job.status)||live.finalizing))throw Error('Job must be finished and have no pending record finalization before forget');
      if(stored.status==='interrupted'&&ownerAlive(stored.ownerPid))throw Error('Interrupted job owner may still update the record; forget refused');
      if(stored.worktree.recordDisposition==='forgotten')return {job_id:id,worktree:stored.worktree,already_forgotten:true,record_only:true};
      if(stored.worktree.state==='removed')throw Error('Job has no active managed worktree');
      const full=await presentJobPayload(stored,{verbose:true,jobsDirectory:this.directory});
      if(full.payload?.diagnostics)throw Error('Full job evidence unavailable; forget refused');
      // Keep absence checks fail-closed, even when the caller acknowledges a PID warning.
      const preview=await forgetManagedWorktree(stored.worktree,options.summary??'',true);
      const evidence=classifyProcessCleanup(full.result),warnings:string[]=[];
      let trackedProcessCheck:any;
      if(orphaned)warnings.push('The Gateway record owner is absent; historical interrupted status and any child-process uncertainty remain preserved.');
      if(evidence.reported&&evidence.state!=='verified')warnings.push('Historical provider cleanup remains '+evidence.state+'; forgetting the listing does not verify process cleanup.');
      if(evidence.invalidPids)warnings.push('Historical tracked PID evidence is invalid; process state remains unknown.');
      else if(evidence.trackedPids.length){
        try{trackedProcessCheck=await this.phase('pid_check',()=>this.trackedProcessesAbsent(evidence.trackedPids,{snapshot,startedAt:stored.startedAt,finishedAt:stored.finishedAt,cleanupAt:evidence.cleanupAt??(full.runtimeEvidence?.processCleanup as any)?.at,trackedProcesses:evidence.trackedProcesses,rootPids:[...evidence.rootPids,...(Number.isSafeInteger(stored.ownerPid)&&stored.ownerPid>0?[stored.ownerPid]:[])],rootProcesses:evidence.rootProcesses,rootAnchorSource:'job_owner_and_observed_provider_roots'}),options.onPhase);}
        catch(error){trackedProcessCheck=(error as any)?.processCheck??{processExitScan:'unknown',checkedAt:new Date().toISOString(),trackedPids:evidence.trackedPids,reason:error instanceof Error?error.message:String(error)};warnings.push('Current tracked process check is unresolved or observes live processes; inspect the retained PID evidence.');}
      }
      const audit={lockRecovery:lock.recovered,at:new Date().toISOString(),recordOnly:true,processCleanupUnchanged:true,processWarnings:warnings,trackedProcessCheck,processWarningAcknowledged:options.acknowledgeProcessWarning===true,verificationSummary:options.summary??''};
      // Audit contains diagnostics, never a claim that the provider/children exited.
      if(await fs.readFile(file,'utf8')!==before)throw Error('Job record changed during forget; preserved');
      await forgetManagedWorktree(stored.worktree,options.summary??'',true);
      if(dryRun)return {job_id:id,worktree:preview,dry_run:true,record_only:true,lockRecovery:lock.recovered,requires_process_warning_ack:warnings.length>0,processWarnings:warnings,trackedProcessCheck};
      if(options.verified!==true||!options.summary?.trim())throw Error('Record-only forget requires verified=true and verification_summary');
      if(warnings.length&&options.acknowledgeProcessWarning!==true)throw Object.assign(Error('Record-only forget requires acknowledge_process_warning=true; process cleanup remains unverified'),{processCheck:trackedProcessCheck,processWarnings:warnings});
      await this.maintenanceCheck();
      if((orphaned||stored.status==='interrupted')&&ownerAlive(stored.ownerPid))throw Error('Job record owner appeared during forget; preserved');
      const worktree=await forgetManagedWorktree(stored.worktree,options.summary,true);
      const forgotten={...worktree,state:'removed' as const,recordDisposition:'forgotten' as const,forgottenAt:audit.at,verificationSummary:options.summary,recordOnly:true,forgetAudit:audit};
      delete (forgotten as any).eligible;delete (forgotten as any).dryRun;
      try{await lock.assertOwned();await this.save({...stored,worktree:forgotten},{expected:before});}catch(error){throw Error('Record-only forget metadata save failed; '+String(error));}
      if(live)live.job.worktree=forgotten;
      this.warningCache=undefined;
      return {job_id:id,worktree:forgotten,record_only:true,lockRecovery:lock.recovered,processWarnings:warnings,trackedProcessCheck};
    }finally{await lock.release();}
  }
  private async worktreeMaintenanceExclusive(id:string,action:'migrate'|'restore'|'remove'|'forget',options:WorktreeMaintenanceOptions){
    if(action==='forget')return this.forgetWorktreeExclusive(id,options);
    await this.maintenanceCheck();let job=await this.readJob(id);const currentStatus=job.status;
    if((job as any).payload?.artifact){job=await presentJobPayload(job,{verbose:true,jobsDirectory:this.directory});if((job as any).payload?.diagnostics)throw Error('Full job evidence unavailable; maintenance refused');}
    job.status=currentStatus;
    if(!job.worktree||job.worktree.state==='removed')throw Error('Job has no active managed worktree');
    if(!terminal.has(job.status)||this.active.get(id)?.finalizing)throw Error('Job must be finished with confirmed idle ownership');
    const interrupted=job.status==='interrupted';
    const cleanupEvidence=classifyProcessCleanup(job.result),cleanupReview=unconfirmedChildCleanup(job.result);
    if(cleanupEvidence.invalidPids)throw Error('Provider child cleanup has invalid tracked PID evidence; preserved');
    if(!interrupted&&cleanupReview&&!freshProcessEvidenceAvailable(job.result))throw Error('Provider child cleanup is unconfirmed and tracked process evidence is unavailable; physical maintenance preserved');
    if(interrupted&&!options.dryRun&&(!options.idleConfirmed||!options.summary?.trim()))throw Error('Interrupted maintenance requires idle_confirmed=true and a verification summary confirming no manually launched or untracked workspace writers');
    if(action!=='migrate'&&!options.dryRun&&(!options.verified||!options.summary?.trim()))throw Error('Recovery requires verified=true and a verification summary');
    const recorded=interrupted?JSON.parse(await fs.readFile(this.file(id),'utf8')):undefined;
    if(recorded&&(recorded.job_id!==id||recorded.ownerPid!==job.ownerPid||recorded.cwd!==job.cwd))throw Error('Interrupted job record changed during inspection; preserved');
    const original=job.worktree,lockFile=this.file(id)+'.cleanup.lock';
    let inventory:Promise<ProcessInventory>|undefined;const snapshot=()=>inventory??=this.phase('process_inventory',()=>readProcessInventory(),options.onPhase);
    const lock=await this.phase('lock',()=>acquireMaintenanceLock(lockFile,{operation:action,jobId:id,processInventory:snapshot}),options.onPhase);
    try{
    await this.lockAudit(id,lock.recovered);
      const targetIdle=await this.assertTargetWorktreeIdle(id,original.path,snapshot);
      const relative=path.relative(original.path,job.cwd);
      if(action==='migrate'&&(relative.startsWith('..'+path.sep)||relative==='..'||path.isAbsolute(relative)))throw Error('Job cwd is outside its managed worktree; migration refused');
    const processContext={snapshot,startedAt:job.startedAt,finishedAt:job.finishedAt,cleanupAt:cleanupEvidence.cleanupAt??(job.runtimeEvidence?.processCleanup as any)?.at,trackedProcesses:cleanupEvidence.trackedProcesses,rootPids:[...cleanupEvidence.rootPids,...(Number.isSafeInteger(job.ownerPid)&&job.ownerPid>0?[job.ownerPid]:[])],rootProcesses:cleanupEvidence.rootProcesses,rootAnchorSource:'job_owner_and_observed_provider_roots'};
      let trackedProcessCheck=cleanupReview?await this.phase('pid_check',()=>this.trackedProcessesAbsent(cleanupEvidence.trackedPids,processContext),options.onPhase):undefined;
      const ownershipInput={ownerPid:job.ownerPid,workspacePaths:[original.path],startedAt:job.startedAt,trackedPids:cleanupEvidence.trackedPids,rootPids:cleanupEvidence.rootPids};
      if(trackedProcessCheck?.reusedPids?.length){const reused=new Set(trackedProcessCheck.reusedPids);ownershipInput.trackedPids=ownershipInput.trackedPids.filter(pid=>!reused.has(pid));ownershipInput.rootPids=ownershipInput.rootPids.filter(pid=>!reused.has(pid));}
      const idleCheck=await (interrupted?this.interruptedOwnership(ownershipInput,{snapshot}):cleanupReview||targetIdle.staleOwnerRecord||lock.recovered.length>0?this.finishedOwnership(ownershipInput,{snapshot}):Promise.resolve(undefined)).catch(error=>{if(trackedProcessCheck&&error&&typeof error==='object')error.processCheck=trackedProcessCheck;throw error;});

      const result=action==='migrate'?await migrateManagedWorktree(original,{dryRun:options.dryRun,targetRoot:options.targetRoot,onPhase:options.onPhase,beforeMutation:()=>lock.assertOwned()}):await recoverManagedWorktree(original,options.summary??'',{dryRun:options.dryRun,action,unlinkLinks:options.unlinkLinks,onPhase:options.onPhase,beforeMutation:()=>lock.assertOwned()});
      if(options.dryRun)return {job_id:id,worktree:result,dry_run:true,lockRecovery:lock.recovered,...(interrupted||cleanupReview?{requires_idle_confirmation:interrupted,idleCheck,trackedProcessCheck,...(interrupted?{ownershipNote:'Process scan cannot identify every detached or manually launched writer; parent must confirm the workspace is idle before applying.'}:{})}:{})};
      const oldCwd=job.cwd;job.worktree=result;
      if(cleanupReview)(job as any).worktreeIdleCheck={...idleCheck,trackedProcessCheck,parentConfirmed:options.idleConfirmed===true,automaticFreshCheck:!interrupted,verificationSummary:options.summary};
      if(recorded){job.status=recorded.status;if(recorded.error===undefined)delete job.error;else job.error=recorded.error;(job as any).worktreeIdleCheck={...idleCheck,trackedProcessCheck,parentConfirmed:true,verificationSummary:options.summary,scope:'owner, descendants and observable workspace references; detached/manual writers reviewed by parent'};}
      if(action==='migrate'){
        job.cwd=path.join(result.path,relative);(job as any).worktreeMigration={previousCwd:oldCwd,currentCwd:job.cwd,at:new Date().toISOString(),restartRequired:true};
      }
      try{await lock.assertOwned();(job as any).maintenanceLockRecovery=[...((job as any).maintenanceLockRecovery??[]),...lock.recovered];await this.save(job);}catch(error){
        if(action==='migrate'){try{await rollbackManagedWorktreeMigration(original,result,{beforeMutation:()=>lock.assertOwned()});}catch(rollback){throw Error(`Job save and migration rollback failed. Worktree destination: ${result.path}; source: ${original.path}; ${String(rollback)}`);}}
        throw Error(`Worktree ${action} completed${action==='migrate'?' and rolled back':''}, but job metadata save failed: ${String(error)}`);
      }
      const entry=this.active.get(id);if(entry){entry.job.worktree=result;entry.job.cwd=job.cwd;if((job as any).worktreeIdleCheck)(entry.job as any).worktreeIdleCheck=(job as any).worktreeIdleCheck;if(action==='migrate')(entry.job as any).worktreeMigration=(job as any).worktreeMigration;}
      this.warningCache=undefined;return {job_id:id,cwd:job.cwd,worktree:result,lockRecovery:lock.recovered,...(cleanupReview?{idleCheck,trackedProcessCheck}:{}),...(action==='migrate'?{restartRequired:true}:{})};
    }finally{await lock.release();}
  }
  private warningCache?:{at:number;value:any};
  async worktreeWarnings(){
    if(this.warningCache&&Date.now()-this.warningCache.at<60000)return this.warningCache.value;
    try{const jobs=(await this.recordedWorktrees()).filter(job=>job.worktree!.state!=='removed'&&Date.now()-Date.parse(job.worktree!.createdAt??job.startedAt)>3*86400000);
      const value={olderThanDays:3,count:jobs.length,job_ids:jobs.slice(0,20).map(job=>job.job_id),note:jobs.length?'Managed worktrees older than 3 days remain. TEMP cleanup schedules vary; migrate legacy TEMP worktrees or inspect before cleanup.':null};this.warningCache={at:Date.now(),value};return value;
    }catch{return {olderThanDays:3,count:null,note:'Worktree inventory unavailable'};}
  }
  async close(){
    this.closing=true;
    await this.starting;
    const entries=[...this.active.values()];
    for(const e of entries){if(!terminal.has(e.job.status)){e.job.status='cancelling';e.controller.abort();}}
    await Promise.all(entries.map(e=>e.done));await Promise.allSettled([...this.maintenanceTasks]);
  }
  /** Losing the MCP transport is not a job cancellation. Finish accepted work
   * under its original deadline; a reconnect can read the persisted job. */
  async drain(){this.closing=true;await this.starting;await Promise.all([...this.active.values()].map(e=>e.done));await Promise.allSettled([...this.maintenanceTasks]);}
}
import {implementationProgress} from './execution-evidence.js';
