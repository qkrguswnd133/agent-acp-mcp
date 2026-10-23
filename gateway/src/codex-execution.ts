import {runCommand,type CommandOptions,type LaunchCommand} from './process.js';
import {readCodexSessionTelemetry,CodexSessionProgressReader,type CodexSessionEvidence} from './codex-session.js';
import {CodexProgress} from './codex-progress.js';

/** A final message is not a terminal event. Recover only an authenticated
 * session's task_complete when the JSON stream omitted turn.completed. */
export async function runCodexCommand(command:LaunchCommand,args:string[],options:CommandOptions&{cwd:string},startedAt=Date.now()){
 let threadId:string|undefined,completedAt:string|undefined,failed=false,lastOutput=Date.now(),lastProbe=0,recovered:CodexSessionEvidence|undefined,reader:CodexSessionProgressReader|undefined;
 const progress=new CodexProgress(startedAt);
 const activity=(event:Record<string,unknown>)=>{try{const snapshot=progress.snapshot();options.onActivity?.({...event,provider:'codex',sessionId:threadId??null,phase:snapshot.phase,implementationProgress:snapshot});}catch{/* Observers must not alter execution. */}};
 const result=await runCommand(command,args,{...options,trackDescendants:true,onActivity:activity,onStdoutLine(line){
  lastOutput=Date.now();options.onStdoutLine?.(line);
  try{const event=JSON.parse(line);
   if(event.type==='thread.started'&&typeof event.thread_id==='string'){threadId=event.thread_id;reader=new CodexSessionProgressReader(options.cwd,event.thread_id,startedAt,undefined,{returnedThreadId:event.thread_id});}
   if(progress.observeCli(event))activity({type:'codex_progress',at:new Date().toISOString(),source:'cli_json'});
   if(event.type==='turn.failed'||event.type==='error'&&completedAt)failed=true;
   if(event.type==='turn.completed'&&!completedAt){completedAt=new Date().toISOString();activity({type:'codex_turn_completed',at:completedAt,source:'cli_json'});}
  }catch{}
 },async completion(){
  if(completedAt||failed)return true;
  if(!threadId||!reader||Date.now()-lastProbe<5000)return false;
  lastProbe=Date.now();const observation=await reader.read();let changed=false;
  if(observation.truncated)progress.markPartial();
  for(const event of observation.events)changed=progress.observeSession(event)||changed;
  if(changed)activity({type:'codex_session_progress',at:progress.snapshot().lastActivityAt,source:'session_jsonl'});
  // Preserve the established full session completion recovery even if the
  // bounded progress window could not include a very large metadata/event row.
  if(Date.now()-lastOutput<5000)return false;
  const evidence=await readCodexSessionTelemetry(options.cwd,threadId,startedAt,undefined,undefined,{returnedThreadId:threadId});
  if(!evidence.completed)return false;
  recovered=evidence;completedAt=evidence.completedAt;activity({type:'codex_turn_completed',at:completedAt,source:'session_jsonl'});return true;
 }});
 progress.finalized();activity({type:'codex_execution_finalized',at:new Date().toISOString()});
 return {...result,implementationProgress:progress.snapshot(),completion:{confirmed:!!completedAt,source:recovered?'session_jsonl':completedAt?'cli_json':'unavailable',completedAt:completedAt??null,processStoppedAfterCompletion:!!completedAt&&result.stopReason==='completed'},recovered};
}
