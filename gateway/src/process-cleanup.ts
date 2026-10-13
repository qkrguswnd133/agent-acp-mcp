import type {ProviderRunResult} from './types.js';
import type {ProcessCleanup} from './process-tree.js';

export function probeProcessLiveness(pid:number):'absent'|'alive'|'unknown'{
  if(!Number.isSafeInteger(pid)||pid<1)return 'unknown';
  try{process.kill(pid,0);return 'alive';}catch(error){return (error as NodeJS.ErrnoException).code==='ESRCH'?'absent':'unknown';}
}
/** Missing exit events alone cannot prove that the root still exists. */
export function withRootExitEvidence(cleanup:ProcessCleanup,pid:number,probe=probeProcessLiveness):ProcessCleanup {
  const state=probe(pid);
  return {...cleanup,trackedPids:[...new Set([...cleanup.trackedPids,pid])],verified:cleanup.verified&&state==='absent',
    remainingPids:[...new Set([...cleanup.remainingPids,...(state==='alive'?[pid]:[])])],
    ...(state==='unknown'?{unverifiedPids:[...new Set([...(cleanup.unverifiedPids??[]),pid])]}:{}),
    note:[cleanup.note,state==='alive'?'Root process is still alive.':state==='unknown'?'Root process exit could not be checked.':'Root process is absent despite missing exit notification.'].filter(Boolean).join(' ')};
}

export type CleanupState='verified'|'remaining'|'unverified';
export interface CleanupEvidence {state:CleanupState;reported:boolean;trackedPids:number[];remainingPids:number[];unverifiedPids:number[];invalidPids:boolean;}
/** Unknown observation is not evidence of a surviving process. */
export function classifyProcessCleanup(result:any):CleanupEvidence {
  let reported=false,uncertain=false,invalidPids=false;
  const tracked=new Set<number>(),remaining=new Set<number>(),unverified=new Set<number>();
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
    }
    if(Array.isArray(value.results))for(const child of value.results)visit(child);
  };
  visit(result);for(const pid of [...remaining,...unverified])tracked.add(pid);
  return {state:remaining.size?'remaining':uncertain||invalidPids||unverified.size?'unverified':'verified',reported,trackedPids:[...tracked],remainingPids:[...remaining],unverifiedPids:[...unverified],invalidPids};
}

export function applyProcessCleanupPolicy(result:ProviderRunResult,writable:boolean):ProviderRunResult {
  const evidence=classifyProcessCleanup(result);
  if(!evidence.reported)return result;
  const fields={processCleanupState:evidence.state};
  if(evidence.state==='verified')return {...result,...fields};
  if(evidence.state==='remaining'){
    const warning=`Observed remaining process PIDs: ${evidence.remainingPids.join(', ')}. Review workspace ownership before further implementation or cleanup.`;
    return {...result,...fields,processCleanupWarning:warning,...(writable&&!result.error?{error:warning,errorKind:'process_cleanup_unconfirmed'}:{})};
  }
  return {...result,...fields,processCleanupWarning:'Process cleanup could not be fully verified; no remaining process was observed. The provider result is preserved. Before worktree cleanup, confirm idle state and perform a fresh process/workspace check.'};
}

export interface TrackedProcessCheck {checkedAt:string;trackedPids:number[];absentPids:number[];processExitScan:'passed'}
export async function verifyTrackedProcessesAbsent(pids:number[],probe:(pid:number)=>'absent'|'alive'|'unknown'=probeProcessLiveness):Promise<TrackedProcessCheck>{
  if(pids.some(pid=>!Number.isSafeInteger(pid)||pid<1))throw Error('Tracked process identity is invalid; worktree preserved');
  const unique=[...new Set(pids)],alive:number[]=[],unknown:number[]=[];
  for(const pid of unique){let state:'absent'|'alive'|'unknown';try{state=probe(pid);}catch{state='unknown';}if(state==='alive')alive.push(pid);else if(state!=='absent')unknown.push(pid);}
  if(alive.length)throw Error(`Tracked processes are still alive (PIDs: ${alive.join(', ')}); worktree preserved`);
  if(unknown.length)throw Error(`Tracked process exit is unverified (PIDs: ${unknown.join(', ')}); worktree preserved`);
  return {checkedAt:new Date().toISOString(),trackedPids:unique,absentPids:unique,processExitScan:'passed'};
}
