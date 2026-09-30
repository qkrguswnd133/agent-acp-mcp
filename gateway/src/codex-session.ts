import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import path from 'node:path';
import {home} from './process.js';

export interface CodexSessionEvidence {model?:string;effort?:string;observedModels:string[];observedEfforts:string[];source:'session_jsonl'|'unavailable';}
const empty=():CodexSessionEvidence=>({observedModels:[],observedEfforts:[],source:'unavailable'});
const setting=(v:unknown)=>typeof v==='string'&&v.trim()&&!['auto','unavailable','unknown'].includes(v.trim())?v.trim():undefined;
const samePath=(a:string,b:string)=>process.platform==='win32'?path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase():path.resolve(a)===path.resolve(b);

/** Reads only the returned thread ID, never the newest unrelated conversation.
 * Context is CLI-observed configuration, not proof of server-internal routing. */
export async function readCodexSessionTelemetry(cwd:string,sessionId:string|undefined,startedAt:number,endedAt=Date.now(),root=path.join(process.env.CODEX_HOME??path.join(home,'.codex'),'sessions')):Promise<CodexSessionEvidence>{
 if(!sessionId||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId)||!Number.isFinite(startedAt)||endedAt<startedAt||endedAt-startedAt>86400000)return empty();
 try{
  const directories=new Set<string>();
  // Date folders can follow local time; cover the adjacent UTC days as well.
  for(let day=startedAt-86400000;day<=endedAt+2*86400000;day+=86400000){const date=new Date(day).toISOString().slice(0,10).split('-');directories.add(path.join(root,...date));}
  for(const directory of directories){
   const files=await fs.readdir(directory,{withFileTypes:true}).catch(()=>[]);
   for(const entry of files){
    if(!entry.isFile()||!entry.name.startsWith('rollout-')||!entry.name.endsWith(`-${sessionId}.jsonl`))continue;
    const file=path.join(directory,entry.name),stat=await fs.stat(file);
    if(stat.size>64*1024*1024)continue;
    const input=createReadStream(file,{encoding:'utf8'}),lines=createInterface({input,crlfDelay:Infinity});
    const models=new Set<string>(),efforts=new Set<string>();let matched=false;
    try{
     for await(const line of lines){
      let e:any;try{e=JSON.parse(line);}catch{continue;}
      const p=e?.payload;
      if(e?.type==='session_meta'){
       if(p?.id!==sessionId||typeof p.cwd!=='string'||!samePath(p.cwd,cwd))return empty();
       const ts=Date.parse(e.timestamp);if(!Number.isFinite(ts)||ts<startedAt-5000||ts>endedAt+5000)return empty();
       matched=true;
      }
      if(!matched||e?.type!=='turn_context'||typeof p?.cwd!=='string'||!samePath(p.cwd,cwd))continue;
      const ts=Date.parse(e.timestamp);if(!Number.isFinite(ts)||ts<startedAt-5000||ts>endedAt+5000)continue;
      const model=setting(p.model),effort=setting(p.effort??p.reasoning_effort);
      if(model)models.add(model);if(effort)efforts.add(effort);
     }
    }finally{lines.close();input.destroy();}
    if(matched)return {source:'session_jsonl',observedModels:[...models],observedEfforts:[...efforts],...(models.size===1?{model:[...models][0]}:{}),...(efforts.size===1?{effort:[...efforts][0]}:{})};
   }
  }
 }catch{/* Telemetry must never replace the provider result. */}
 return empty();
}

export function codexRuntimeMetadata(model:unknown,effort:unknown,session:CodexSessionEvidence){
 const cliModel=setting(model),cliEffort=setting(effort);
 return {model:cliModel??session.model??'unavailable',effort:cliEffort??session.effort??'unavailable',modelSource:cliModel?'cli_json':session.model?'session_jsonl':'unavailable',effortSource:cliEffort?'cli_json':session.effort?'session_jsonl':'unavailable',observedModels:[...new Set([...(cliModel?[cliModel]:[]),...session.observedModels])],observedEfforts:[...new Set([...(cliEffort?[cliEffort]:[]),...session.observedEfforts])]};
}
