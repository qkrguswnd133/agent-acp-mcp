/** Command evidence from a provider's own tool event, never from assistant prose. */
export interface CommandExecution {
 command:string;
 cwd:string|null;
 exitCode:number|null;
 output:string|null;
 source:'session_jsonl'|'codex_json';
}

export function observedExitCode(...values:unknown[]):number|null {
 for(const value of values)if(typeof value==='number'&&Number.isInteger(value))return value;
 return null;
}

export function observedOutput(value:unknown):string|null {
 if(typeof value==='string')return value;
 if(Array.isArray(value)){
  const parts=value.flatMap((part:any)=>typeof part==='string'?[part]:typeof part?.text==='string'?[part.text]:[]);
  return parts.length?parts.join('\n'):null;
 }
 return null;
}
