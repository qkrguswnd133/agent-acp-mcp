import type {ProviderRunResult} from './types.js';
import type {ProcessCleanup} from './process-tree.js';
import {readProcessInventory,sameProcessCreation,validCreationTime,type RecordedProcessIdentity,type ProcessInventory} from './process-inventory.js';

export function probeProcessLiveness(pid:number):'absent'|'alive'|'unknown'{
  if(!Number.isSafeInteger(pid)||pid<1)return 'unknown';
  try{process.kill(pid,0);return 'alive';}catch(error){return (error as NodeJS.ErrnoException).code==='ESRCH'?'absent':'unknown';}
}
/** Missing exit events alone cannot prove that the root still exists. */
export function withRootExitEvidence(cleanup:ProcessCleanup,pid:number,probe=probeProcessLiveness):ProcessCleanup {
  const state=probe(pid);
  return {...cleanup,rootPid:pid,trackedPids:[...new Set([...cleanup.trackedPids,pid])],verified:cleanup.verified&&state==='absent',
    remainingPids:[...new Set([...cleanup.remainingPids,...(state==='alive'?[pid]:[])])],
    ...(state==='unknown'?{unverifiedPids:[...new Set([...(cleanup.unverifiedPids??[]),pid])]}:{}),
    note:[cleanup.note,state==='alive'?'Root process is still alive.':state==='unknown'?'Root process exit could not be checked.':'Root process is absent despite missing exit notification.'].filter(Boolean).join(' ')};
}

export type CleanupState='verified'|'remaining'|'unverified';
export interface RemainingWorkspaceCheck {pid:number;usage:'referenced'|'not_referenced'|'unknown';evidence:Array<'commandLine'|'cwd'>;reason:string;}
/** Attribute only observable command/cwd evidence. No path match does not prove
 * there are no open handles, and never authorizes physical worktree removal. */
export async function observeRemainingProcessWorkspace(result:ProviderRunResult,workspacePaths:string[],options:{snapshot?:()=>Promise<ProcessInventory>;platform?:NodeJS.Platform}={}):Promise<ProviderRunResult>{
 const cleanup=classifyProcessCleanup(result);if(!cleanup.remainingPids.length)return result;
 const normalize=(text:string)=>(options.platform??process.platform)==='win32'?text.replace(/\\/g,'/').toLowerCase():text;
 const targets=workspacePaths.filter(Boolean).map(value=>normalize(value).replace(/\/$/,''));
 const references=(text:string)=>targets.some(target=>{const value=normalize(text);let offset=value.indexOf(target);while(offset!==-1){const before=value[offset-1],after=value[offset+target.length];if((before===undefined||/[\s='"\x00]/.test(before))&&(after===undefined||/[\s/'"\x00]/.test(after)))return true;offset=value.indexOf(target,offset+1);}return false;});
 let inventory:ProcessInventory|undefined;try{inventory=await (options.snapshot??readProcessInventory)();}catch{}
 const checks:RemainingWorkspaceCheck[]=cleanup.remainingPids.map(pid=>{
  const current=inventory?.processes.find(row=>row.pid===pid),recorded=[...cleanup.trackedProcesses,...cleanup.rootProcesses].filter(row=>row.pid===pid);
  const unknown=(reason:string):RemainingWorkspaceCheck=>({pid,usage:'unknown',evidence:[],reason});
  if(!current)return unknown(inventory?.complete?'Previously remaining PID is absent from the fresh inventory':'Fresh process inventory is unavailable or incomplete');
  if(!targets.length)return unknown('Workspace path is unavailable');
  if(recorded.length&&!recorded.some(row=>sameProcessCreation(row,current)===true))return unknown('Current PID creation does not match a recorded remaining process');
  const evidence=(['commandLine','cwd'] as const).filter(key=>typeof current[key]==='string'&&!!current[key]?.trim());
  if(!evidence.length)return unknown('Command line and cwd are unavailable; open handles were not inspected');
  const matched=evidence.filter(key=>references(current[key]!));
  return {pid,usage:matched.length?'referenced':'not_referenced',evidence:matched.length?matched:evidence,reason:matched.length?'Observed metadata references the workspace':'Available command/cwd metadata does not reference the workspace; open handles were not inspected'};
 });
 return {...result,processWorkspaceCheck:{checkedAt:new Date().toISOString(),checks}};
}
export interface CleanupEvidence {state:CleanupState;reported:boolean;trackedPids:number[];remainingPids:number[];unverifiedPids:number[];invalidPids:boolean;trackedProcesses:RecordedProcessIdentity[];rootPids:number[];rootProcesses:RecordedProcessIdentity[];cleanupAt?:string;}
/** Unknown observation is not evidence of a surviving process. */
export function classifyProcessCleanup(result:any):CleanupEvidence {
  let reported=false,uncertain=false,invalidPids=false;
  const tracked=new Set<number>(),remaining=new Set<number>(),unverified=new Set<number>();
  const trackedProcesses:RecordedProcessIdentity[]=[],rootProcesses:RecordedProcessIdentity[]=[],rootPids=new Set<number>();let cleanupAt:string|undefined;
  const collect=(value:unknown,target:Set<number>)=>{
    if(value===undefined)return;
    if(!Array.isArray(value)){invalidPids=true;return;}
    for(const pid of value){if(!Number.isSafeInteger(pid)||pid<1){invalidPids=true;continue;}target.add(pid);}
  };
  const visit=(value:any)=>{
    if(!value||typeof value!=='object')return;
    if(typeof value.childCleanedUp==='boolean'){reported=true;if(!value.childCleanedUp)uncertain=true;}
    if(value.processCleanup&&typeof value.processCleanup==='object'){
      reported=true;const cleanup=value.processCleanup;
      if(cleanup.verified!==true)uncertain=true;
      collect(cleanup.trackedPids,tracked);collect(cleanup.remainingPids,remaining);collect(cleanup.unverifiedPids,unverified);
      if(cleanup.rootPid!==undefined)collect([cleanup.rootPid],rootPids);
      for(const [input,target] of [[cleanup.trackedProcesses,trackedProcesses],[cleanup.rootProcesses,rootProcesses],[cleanup.rootProcess===undefined?undefined:[cleanup.rootProcess],rootProcesses]] as const){
        if(input===undefined)continue;if(!Array.isArray(input)){invalidPids=true;continue;}
        for(const identity of input){if(!identity||!Number.isSafeInteger(identity.pid)||identity.pid<1){invalidPids=true;continue;}target.push(identity);}
      }
      const observed=cleanup.observedAt??cleanup.at;if(typeof observed==='string'&&Number.isFinite(Date.parse(observed))&&(!cleanupAt||Date.parse(observed)>Date.parse(cleanupAt)))cleanupAt=observed;
    }
    if(Array.isArray(value.results))for(const child of value.results)visit(child);
  };
  visit(result);for(const row of rootProcesses)rootPids.add(row.pid);for(const row of trackedProcesses)tracked.add(row.pid);for(const pid of [...remaining,...unverified,...rootPids])tracked.add(pid);
  return {state:remaining.size?'remaining':uncertain||invalidPids||unverified.size?'unverified':'verified',reported,trackedPids:[...tracked],remainingPids:[...remaining],unverifiedPids:[...unverified],invalidPids,trackedProcesses,rootPids:[...rootPids],rootProcesses,cleanupAt};
}

export function applyProcessCleanupPolicy(result:ProviderRunResult,writable:boolean):ProviderRunResult {
  const evidence=classifyProcessCleanup(result);
  if(!evidence.reported)return result;
  const fields={processCleanupState:evidence.state};
  if(evidence.state==='verified')return {...result,...fields};
  if(evidence.state==='remaining'){
    const checks=(result.processWorkspaceCheck as {checks?:RemainingWorkspaceCheck[]}|undefined)?.checks??[];
    const referenced=evidence.remainingPids.filter(pid=>checks.some(row=>row.pid===pid&&row.usage==='referenced'));
    const warning=`Observed remaining process PIDs: ${evidence.remainingPids.join(', ')}. ${referenced.length?`Workspace references observed for PIDs: ${referenced.join(', ')}.`:'Workspace use is unrelated in available metadata or unknown; the provider result is preserved.'} Review workspace ownership before further implementation or cleanup.`;
    return {...result,...fields,processCleanupWarning:warning,...(writable&&referenced.length&&!result.error?{error:warning,errorKind:'process_cleanup_unconfirmed'}:{})};
  }
  return {...result,...fields,processCleanupWarning:'Process cleanup could not be fully verified; no remaining process was observed. The provider result is preserved. Before worktree cleanup, confirm idle state and perform a fresh process/workspace check.'};
}

export interface ProcessCheckItem {pid:number;currentImageName:string|null;currentCreatedAt:string|null;recordedCreatedAt:string|null;decision:'alive'|'reused'|'absent'|'unknown';reason:string;}
export interface TrackedProcessCheck {checkedAt:string;trackedPids:number[];absentPids:number[];processExitScan:'passed';reusedPids?:number[];checks?:ProcessCheckItem[];snapshotCount?:number;}
export interface ProcessCheckContext {startedAt?:string;finishedAt?:string;cleanupAt?:string;trackedProcesses?:RecordedProcessIdentity[];rootPids?:number[];rootProcesses?:RecordedProcessIdentity[];rootAnchorSource?:string;snapshot?:()=>Promise<ProcessInventory>;}
function independentAncestry(current:RecordedProcessIdentity,rows:Map<number,RecordedProcessIdentity>,tracked:Set<number>):{independent:boolean|undefined;reason:string}{
 const visited=new Set<number>([current.pid]);let child=current;
 while(child.parentPid!==0){
  const pid=child.parentPid;if(typeof pid!=='number'||!Number.isSafeInteger(pid)||pid<1||visited.has(pid))return {independent:undefined,reason:`Parent identity is invalid or cyclic at PID ${child.pid}`};
  if(tracked.has(pid))return {independent:false,reason:`Legacy PID current ancestry reaches tracked/root-anchor PID ${pid}`};
  const parent=rows.get(pid),parentTime=validCreationTime(parent?.createdAt),childTime=validCreationTime(child.createdAt);
  if(!parent)return {independent:undefined,reason:`Parent PID ${pid} of PID ${child.pid} is absent; historical ancestry cannot be established`};
  if(parentTime===undefined||childTime===undefined||parentTime>childTime)return {independent:undefined,reason:`Parent creation evidence is missing or inconsistent at PID ${pid}`};
  visited.add(pid);child=parent;
 }
 return {independent:true,reason:'Legacy PID has a fully proven independent current ancestry'};
}
export async function verifyTrackedProcessesAbsent(pids:number[],context:ProcessCheckContext|((pid:number)=>'absent'|'alive'|'unknown')={}):Promise<TrackedProcessCheck>{
 const unique=[...new Set(pids)],checks:ProcessCheckItem[]=[],checkedAt=new Date().toISOString();let snapshotCount=0;
 const finish=()=>{
  const proof={checkedAt,trackedPids:unique,absentPids:checks.filter(row=>row.decision==='absent').map(row=>row.pid),reusedPids:checks.filter(row=>row.decision==='reused').map(row=>row.pid),checks,snapshotCount,...(typeof context==='object'?{rootPids:context.rootPids??[],rootAnchorSource:context.rootAnchorSource??'provider'}:{})};
  const alive=checks.filter(row=>row.decision==='alive'),unknown=checks.filter(row=>row.decision==='unknown');
  if(alive.length||unknown.length)throw Object.assign(Error((alive.length?`Tracked processes are still alive (PIDs: ${alive.map(row=>row.pid).join(', ')}); worktree preserved`:`Tracked process exit is unverified (PIDs: ${unknown.map(row=>row.pid).join(', ')}); worktree preserved`)+'. See processCheck.checks for each PID image, current/recorded creation time and decision.'),{processCheck:{...proof,processExitScan:'blocked'}});
  return {...proof,processExitScan:'passed' as const};
 };
 if(unique.some(pid=>!Number.isSafeInteger(pid)||pid<1)){for(const pid of unique)checks.push({pid,currentImageName:null,currentCreatedAt:null,recordedCreatedAt:null,decision:'unknown',reason:'Invalid tracked process identity'});try{return finish();}catch(error){(error as Error).message='Tracked process identity is invalid; worktree preserved';throw error;}}
 if(typeof context==='function'){
  for(const pid of unique){let decision:'absent'|'alive'|'unknown';try{decision=context(pid);}catch{decision='unknown';}checks.push({pid,currentImageName:null,currentCreatedAt:null,recordedCreatedAt:null,decision,reason:'Injected liveness probe; no creation evidence permits reuse'});}return finish();
 }
 const recorded=[...(context.trackedProcesses??[]),...(context.rootProcesses??[])];
 let inventory:ProcessInventory;
 try{snapshotCount++;inventory=await (context.snapshot??readProcessInventory)();if(!inventory||!Array.isArray(inventory.processes)||new Set(inventory.processes.map(row=>row.pid)).size!==inventory.processes.length||inventory.processes.some(row=>!Number.isSafeInteger(row.pid)||row.pid<0))throw Error('Invalid inventory');}
 catch{for(const pid of unique)checks.push({pid,currentImageName:null,currentCreatedAt:null,recordedCreatedAt:recorded.find(row=>row.pid===pid&&row.createdAt)?.createdAt??null,decision:'unknown',reason:'Current process creation inventory unavailable'});return finish();}
 const rows=new Map(inventory.processes.map(row=>[row.pid,row])),tracked=new Set([...unique,...(context.rootPids??[])]);
 const start=validCreationTime(context.startedAt),end=validCreationTime(context.finishedAt??context.cleanupAt);
 for(const pid of unique){
  const current=rows.get(pid),saved=recorded.filter(row=>row.pid===pid),item:ProcessCheckItem={pid,currentImageName:current?.imageName??null,currentCreatedAt:current?.createdAt??null,recordedCreatedAt:saved[0]?.createdAt??null,decision:'unknown',reason:'Creation or ancestry evidence unavailable'};
  if(!current){if(inventory.complete){item.decision='absent';item.reason='PID absent from complete fresh inventory';}}
  else if(saved.length){
   const comparisons=saved.map(row=>sameProcessCreation(row,current));
   if(comparisons.includes(true)){item.decision='alive';item.reason='Current process creation matches a recorded identity';}
   else if(comparisons.every(value=>value===false)){item.decision='reused';item.reason='Current process creation differs from every recorded identity';}
  }else{
   const created=validCreationTime(current.createdAt);
   if(created!==undefined&&start!==undefined&&end!==undefined&&end>=start){
    if(created<start||created>end){item.decision='reused';item.reason='Legacy PID current creation is outside the recorded job lifetime';}
    else if(inventory.complete&&(context.rootPids?.length??0)>0&&context.rootPids!.every(value=>Number.isSafeInteger(value)&&value>0)){const independent=independentAncestry(current,rows,tracked);item.reason=independent.reason;if(independent.independent===true)item.decision='reused';else if(independent.independent===false)item.decision='alive';}
   }
  }
  checks.push(item);
 }
 return finish();
}
