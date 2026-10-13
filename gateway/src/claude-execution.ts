import {runCommand,type CommandOptions,type LaunchCommand} from './process.js';

/** Only the official top-level JSON result envelope is terminal. Assistant
 * prose, transcript assistant records and incomplete JSON never count. */
export function parseClaudeTerminalResult(stdout:string):Record<string,any>|undefined{
 try{const value=JSON.parse(stdout.trim());return value&&typeof value==='object'&&!Array.isArray(value)&&value.type==='result'&&('result' in value||value.is_error===true||Array.isArray(value.errors))?value:undefined;}catch{return undefined;}
}
export async function runClaudeCommand(command:LaunchCommand,args:string[],options:CommandOptions){
 let stdout='',dirty=false,terminalResult:Record<string,any>|undefined,completedAt:string|undefined;
 const inspect=()=>{
  if(terminalResult)return true;if(!dirty)return false;dirty=false;
  const parsed=parseClaudeTerminalResult(stdout);if(!parsed)return false;
  terminalResult=parsed;completedAt=new Date().toISOString();
  options.onActivity?.({type:'claude_turn_completed',at:completedAt,source:'cli_json_result',isError:parsed.is_error===true});return true;
 };
 const result=await runCommand(command,args,{...options,trackDescendants:true,onStdoutChunk(chunk){
  options.onStdoutChunk?.(chunk);if(!terminalResult){stdout+=chunk;dirty=true;}
 },completion:inspect});
 // A normal fast exit may precede the first completion poll.
 inspect();
 return {...result,terminalResult,completion:{confirmed:!!terminalResult,source:terminalResult?'cli_json_result':'unavailable',completedAt:completedAt??null,isError:terminalResult?.is_error===true,processStoppedAfterCompletion:!!terminalResult&&result.stopReason==='completed'}};
}
