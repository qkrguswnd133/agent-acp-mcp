/** Observational metadata. Neither successful commands nor end_turn prove task acceptance. */
export function executionEvidence(result:Record<string,any>){
 const commands=Array.isArray(result.commandExecutions)?result.commandExecutions:[];
 const known=commands.filter((c:any)=>typeof c?.exitCode==='number'&&Number.isFinite(c.exitCode));
 const succeeded=known.filter((c:any)=>c.exitCode===0).length,failed=known.length-succeeded;
 return {
  turnStatus:result.error?(result.errorKind==='cancelled'?'cancelled':'failed'):'completed',
  completionCriteria:{status:'unverified',requiresParentReview:true},
  commands:{observed:commands.length,succeeded,failed,unknown:commands.length-known.length,
   status:commands.length===0?'not_observed':known.length<commands.length?'incomplete':failed?(succeeded?'mixed':'failed'):'all_exited_zero',
   scope:'observed_commands_only',note:'Exit codes describe commands, not test counts or completion criteria. Earlier failures remain recorded after retries.'},
 };
}

/** A warning for parent triage, never a cancellation or a claim about unobserved edits. */
export function implementationProgress(kind:string,activity:any,now=Date.now()){
 const p=activity?.implementationProgress;
 if(typeof kind!=='string'||!kind.endsWith('implement')||!p||!Number.isFinite(Date.parse(p.startedAt)))return {status:'unavailable',reason:'No structured implementation progress from this provider'};
 const elapsedSeconds=Math.max(0,Math.floor((now-Date.parse(p.startedAt))/1000));
 const slow=elapsedSeconds>=300&&p.successfulReads>=20&&p.successfulWrites===0&&p.commandsStarted===0;
 return {...p,elapsedSeconds,status:slow?'exploration_without_observed_execution':'observed_activity',
  warning:slow?'At least 5 minutes and 20 successful reads without an observed file write or command. Review scope and the next concrete implementation step.':null,
  nextAction:slow?'parent_review_scope_and_next_step':null,automaticCancellation:false,
  coverage:'ACP client file and terminal operations only; other modifications are not inferred'};
}
