import {runCommand,type CommandOptions,type LaunchCommand} from './process.js';
import {readCodexSessionTelemetry,type CodexSessionEvidence} from './codex-session.js';

/** A final message is not a terminal event. Recover only an authenticated
 * session's task_complete when the JSON stream omitted turn.completed. */
export async function runCodexCommand(command:LaunchCommand,args:string[],options:CommandOptions&{cwd:string},startedAt=Date.now()){
 let threadId:string|undefined,completedAt:string|undefined,failed=false,lastOutput=Date.now(),lastProbe=0,recovered:CodexSessionEvidence|undefined;
 const result=await runCommand(command,args,{...options,trackDescendants:true,onStdoutLine(line){
  lastOutput=Date.now();options.onStdoutLine?.(line);
  try{const event=JSON.parse(line);
   if(event.type==='thread.started'&&typeof event.thread_id==='string')threadId=event.thread_id;
   if(event.type==='turn.failed'||event.type==='error'&&completedAt)failed=true;
   if(event.type==='turn.completed'&&!completedAt){completedAt=new Date().toISOString();options.onActivity?.({type:'codex_turn_completed',at:completedAt,source:'cli_json'});}
  }catch{}
 },async completion(){
  if(completedAt||failed)return true;
  if(!threadId||Date.now()-lastOutput<5000||Date.now()-lastProbe<5000)return false;
  lastProbe=Date.now();const evidence=await readCodexSessionTelemetry(options.cwd,threadId,startedAt);
  if(!evidence.completed)return false;
  recovered=evidence;completedAt=evidence.completedAt;options.onActivity?.({type:'codex_turn_completed',at:completedAt,source:'session_jsonl'});return true;
 }});
 return {...result,completion:{confirmed:!!completedAt,source:recovered?'session_jsonl':completedAt?'cli_json':'unavailable',completedAt:completedAt??null,processStoppedAfterCompletion:!!completedAt&&result.stopReason==='completed'},recovered};
}
