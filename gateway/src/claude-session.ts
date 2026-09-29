import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import path from 'node:path';
import {home} from './process.js';
import {observedExitCode,observedOutput} from './command-telemetry.js';
import type {CommandExecution} from './command-telemetry.js';

export function reportedEffort(value:unknown):string|undefined{
 return typeof value==='string'&&['minimal','low','medium','high','xhigh','max','none'].includes(value)?value:undefined;
}
const unavailable=()=>({effort:'unavailable',effortSource:'unavailable',observedEfforts:[] as string[],effortComplete:false,commandExecutions:[] as CommandExecution[]});
const normalized=(value:string)=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);

export interface ClaudeSessionTelemetry {
 effort:string;
 effortSource:string;
 observedEfforts:string[];
 effortComplete:boolean;
 /** Text emitted before a malformed CLI result or a process failure. */
 text?:string;
 /** A CLI-reported usage object, never a calculated aggregate. */
 usage?:unknown;
 usageSource?:'session_jsonl';
 usageScope?:'last_observed_message';
 observedUsage?:unknown[];
 /** The one model named by matching official assistant records, if unambiguous. */
 model?:string;
 observedModels?:string[];
 commandExecutions:CommandExecution[];
}

function assistantText(entry:any):string|undefined{
 const message=entry?.message;
 const direct=[entry?.text,message?.text,typeof message==='string'?message:undefined].find(value=>typeof value==='string'&&value.trim());
 if(typeof direct==='string')return direct.trim();
 const content=message?.content??entry?.content;
 if(Array.isArray(content)){
  const values=content.flatMap((part:any)=>typeof part==='string'?[part]:typeof part?.text==='string'?[part.text]:typeof part?.content==='string'?[part.content]:[]).map((value:string)=>value.trim()).filter(Boolean);
  return values.length?values.join('\n'):undefined;
 }
 return undefined;
}

function entryUsage(entry:any):unknown{
 const value=entry?.usage??entry?.message?.usage??entry?.message?.modelUsage??entry?.modelUsage;
 return value===undefined?undefined:value;
}

/**
 * Read the official JSONL transcript for exactly one Claude session.  This is
 * best-effort telemetry: a corrupt or unavailable transcript never changes
 * the primary CLI result.
 */
export async function readClaudeSessionTelemetry(cwd:string,sessionId:string,roots=[
 path.join(process.env.CLAUDE_CONFIG_DIR??path.join(home,'.claude'),'projects'),
 path.join(home,'.config','claude','projects'),
]):Promise<ClaudeSessionTelemetry>{
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId))return unavailable();
 try{
  for(const root of [...new Set(roots)]){
   const dirs=await fs.readdir(root,{withFileTypes:true}).catch(()=>[]);
   for(const dir of dirs){
    if(!dir.isDirectory())continue;
    const file=path.join(root,dir.name,`${sessionId}.jsonl`);
    const stat=await fs.stat(file).catch(()=>undefined);
    if(!stat?.isFile()||stat.size>64*1024*1024)continue;
    const input=createReadStream(file,{encoding:'utf8'});
    const lines=createInterface({input,crlfDelay:Infinity});
    const observed=new Set<string>(),models=new Set<string>(),texts:string[]=[],seenTexts=new Set<string>(),seenUsage=new Set<string>();
    const commands=new Map<string,CommandExecution>();let usage:unknown, count=0,missing=0;
    try{for await(const line of lines){
     let entry:any;try{entry=JSON.parse(line);}catch{continue;}
     if(entry.isSidechain===true||entry.sessionId!==sessionId||typeof entry.cwd!=='string'||normalized(entry.cwd)!==normalized(cwd)||entry.message?.model==='<synthetic>')continue;
     if(entry.type==='user'){
      for(const part of Array.isArray(entry.message?.content)?entry.message.content:[]){
       if(part?.type!=='tool_result'||typeof part.tool_use_id!=='string')continue;
       const execution=commands.get(part.tool_use_id);if(!execution)continue;
       const result=entry.toolUseResult;
       execution.exitCode=observedExitCode(result?.exitCode,result?.exit_code,part?.exitCode,part?.exit_code);
       const stdout=observedOutput(result?.stdout),stderr=observedOutput(result?.stderr);
       execution.output=stdout!==null||stderr!==null?[stdout,stderr].filter(value=>value!==null).join('\n'):observedOutput(part.content);
      }
      continue;
     }
     if(entry.type!=='assistant')continue;
     count++;
     for(const part of Array.isArray(entry.message?.content)?entry.message.content:[]){
      if(part?.type!=='tool_use'||part?.name!=='Bash'||typeof part.id!=='string'||typeof part.input?.command!=='string'||!part.input.command.trim()||commands.has(part.id))continue;
      commands.set(part.id,{command:part.input.command,cwd:typeof part.input.cwd==='string'?part.input.cwd:entry.cwd,exitCode:null,output:null,source:'session_jsonl'});
     }
     const effort=reportedEffort(entry.perTurnEffort??entry.effort);
     if(effort)observed.add(effort);else missing++;
     const model=entry?.message?.model??entry?.model;if(typeof model==='string'&&model.trim()&&model!=='<synthetic>')models.add(model.trim());
     const text=assistantText(entry);if(text&&!seenTexts.has(text)){seenTexts.add(text);texts.push(text);}
     const reportedUsage=entryUsage(entry);
     if(reportedUsage!==undefined){
      let key:string;try{key=JSON.stringify(reportedUsage);}catch{key=String(reportedUsage);}
      // Transcript entries may repeat a cumulative usage payload. Keep the
      // last distinct reported payload; never sum or infer token counts.
      if(!seenUsage.has(key)){seenUsage.add(key);usage=reportedUsage;}
     }
    }}finally{lines.close();input.destroy();}
    if(count){const efforts=[...observed];return {
     effort:missing||!efforts.length?'unavailable':efforts.length===1?efforts[0]:'mixed',
     effortSource:'session_jsonl',observedEfforts:efforts,effortComplete:missing===0,observedModels:[...models],commandExecutions:[...commands.values()],
     ...(texts.length?{text:texts.join('\n')}:{}),...(usage!==undefined?{usage,usageSource:'session_jsonl' as const,usageScope:'last_observed_message' as const,observedUsage:[...seenUsage].map(value=>{try{return JSON.parse(value);}catch{return value;}})}:{}),...(models.size===1?{model:[...models][0]}:{}),
    };}
   }
  }
 }catch{/* Missing/invalid telemetry must not fail the provider task. */}
 return unavailable();
}

/** Read only the returned session's official transcript, never another session's settings. */
export async function readClaudeSessionEffort(cwd:string,sessionId:string,roots=[
 path.join(process.env.CLAUDE_CONFIG_DIR??path.join(home,'.claude'),'projects'),
 path.join(home,'.config','claude','projects'),
]){
 const telemetry=await readClaudeSessionTelemetry(cwd,sessionId,roots);
 return {effort:telemetry.effort,effortSource:telemetry.effortSource,observedEfforts:telemetry.observedEfforts,effortComplete:telemetry.effortComplete};
}
