import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import path from 'node:path';
import {home} from './process.js';

export interface CodexSessionEvidence {model?:string;effort?:string;observedModels:string[];observedEfforts:string[];source:'session_jsonl'|'unavailable';completed?:boolean;completedAt?:string;text?:string;usage?:unknown;}
const empty=():CodexSessionEvidence=>({observedModels:[],observedEfforts:[],source:'unavailable'});
const setting=(v:unknown)=>typeof v==='string'&&v.trim()&&!['auto','unavailable','unknown'].includes(v.trim())?v.trim():undefined;
const samePath=(a:string,b:string)=>process.platform==='win32'?path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase():path.resolve(a)===path.resolve(b);
export interface CodexSessionScope {returnedThreadId?:string;}
function sessionDirectories(root:string,startedAt:number,endedAt:number,sessionId:string,existing:boolean){
 const directories=new Set<string>();
 const add=(from:number,to:number)=>{for(let day=from-86400000;day<=to+2*86400000;day+=86400000)directories.add(path.join(root,...new Date(day).toISOString().slice(0,10).split('-')));};
 add(startedAt,endedAt);
 // Official Codex thread IDs are UUIDv7: locate an explicitly returned older
 // thread by its creation day without enumerating unrelated conversation files.
 if(existing&&sessionId[14]==='7'){
  const created=parseInt(sessionId.replaceAll('-','').slice(0,12),16);
  if(Number.isFinite(created)&&created>=946684800000&&created<=endedAt+5000)add(created,created);
 }
 return directories;
}

/** Incremental, bounded live observation. Only an exact session ID + cwd +
 * launch-time metadata match is accepted. A read never scans other sessions.
 * Large gaps are tailed and explicitly marked incomplete instead of repeatedly
 * parsing an entire transcript while the provider is running. */
export class CodexSessionProgressReader {
 private file?:string;private offset=0;private pending='';private rejected=false;private skipFragment=false;
 private readonly budget=512*1024;
 constructor(private readonly cwd:string,private readonly sessionId:string,private readonly startedAt:number,
  private readonly root=path.join(process.env.CODEX_HOME??path.join(home,'.codex'),'sessions'),private readonly scope:CodexSessionScope={}){}
 async read(now=Date.now()):Promise<{events:any[];truncated:boolean;completed:boolean}>{
  const result={events:[] as any[],truncated:false,completed:false};
  if(this.rejected||!Number.isFinite(this.startedAt)||now<this.startedAt||now-this.startedAt>86400000||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(this.sessionId))return result;
  try{
   const existing=this.scope.returnedThreadId===this.sessionId,eventStart=existing?this.startedAt:this.startedAt-5000;
   if(!this.file){
    for(const directory of sessionDirectories(this.root,this.startedAt,now,this.sessionId,existing)){
     const entries=await fs.readdir(directory,{withFileTypes:true}).catch(()=>[]);
     const match=entries.find(entry=>entry.isFile()&&entry.name.startsWith('rollout-')&&entry.name.endsWith(`-${this.sessionId}.jsonl`));
     if(match){this.file=path.join(directory,match.name);break;}
    }
   }
   if(!this.file)return result;
   const handle=await fs.open(this.file,'r');
   try{
    const stat=await handle.stat();if(!stat.isFile()||stat.size<this.offset){this.rejected=true;return result;}
    // Revalidate metadata on every poll so replacement/truncation of a file
    // cannot attach an unrelated conversation to an established reader.
    const header=Buffer.alloc(Math.min(512*1024,stat.size));await handle.read(header,0,header.length,0);
    const end=header.indexOf(10);if(end<0)return result;
    let meta:any;try{meta=JSON.parse(header.subarray(0,end).toString('utf8'));}catch{this.rejected=true;return result;}
    const metaAt=Date.parse(meta.timestamp);
    if(meta.type!=='session_meta'||meta.payload?.id!==this.sessionId||typeof meta.payload?.cwd!=='string'||!samePath(meta.payload.cwd,this.cwd)||!Number.isFinite(metaAt)||!existing&&metaAt<this.startedAt-5000||metaAt>now+5000){this.rejected=true;return result;}
    if(stat.size-this.offset>this.budget){this.offset=stat.size-this.budget;this.pending='';this.skipFragment=true;result.truncated=true;}
    if(stat.size===this.offset)return result;
    const buffer=Buffer.alloc(Math.min(this.budget,stat.size-this.offset));const read=await handle.read(buffer,0,buffer.length,this.offset);this.offset+=read.bytesRead;
    // A complete UTF-8 line is decoded only after its newline is available.
    // Keep any split multibyte sequence as bytes via latin1 until then.
    const lines=(this.pending+buffer.subarray(0,read.bytesRead).toString('latin1')).split('\n');this.pending=lines.pop()??'';
    if(this.skipFragment){if(lines.length){lines.shift();this.skipFragment=false;}else if(this.pending.length>=this.budget)this.pending='';}
    for(const line of lines){
     let event:any;try{event=JSON.parse(Buffer.from(line,'latin1').toString('utf8'));}catch{continue;}
     const at=Date.parse(event.timestamp);if(!Number.isFinite(at)||at<eventStart||at>now+5000)continue;
     result.events.push(event);if(event.type==='event_msg'&&event.payload?.type==='task_complete')result.completed=true;
    }
    if(this.pending.length>=this.budget){this.pending='';this.skipFragment=true;result.truncated=true;}
    // Codex normally appends newlines. Accept a valid final task_complete from
    // a closed/tail-written fixture too without consuming a partial JSON row.
    if(this.pending&&!this.skipFragment){try{const event=JSON.parse(Buffer.from(this.pending,'latin1').toString('utf8'));const at=Date.parse(event.timestamp);if(event.type==='event_msg'&&event.payload?.type==='task_complete'&&Number.isFinite(at)&&at>=eventStart&&at<=now+5000){result.events.push(event);result.completed=true;this.pending='';}}catch{}}
   }finally{await handle.close();}
  }catch{/* Progress observation must not replace the provider result. */}
  return result;
 }
}

/** Reads only the returned thread ID, never the newest unrelated conversation.
 * Context is CLI-observed configuration, not proof of server-internal routing. */
export async function readCodexSessionTelemetry(cwd:string,sessionId:string|undefined,startedAt:number,endedAt=Date.now(),root=path.join(process.env.CODEX_HOME??path.join(home,'.codex'),'sessions'),scope:CodexSessionScope={}):Promise<CodexSessionEvidence>{
 if(!sessionId||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId)||!Number.isFinite(startedAt)||endedAt<startedAt||endedAt-startedAt>86400000)return empty();
 try{
  const existing=scope.returnedThreadId===sessionId,eventStart=existing?startedAt:startedAt-5000;
  // Date folders can follow local time; cover the adjacent UTC days as well.
  for(const directory of sessionDirectories(root,startedAt,endedAt,sessionId,existing)){
   const files=await fs.readdir(directory,{withFileTypes:true}).catch(()=>[]);
   for(const entry of files){
    if(!entry.isFile()||!entry.name.startsWith('rollout-')||!entry.name.endsWith(`-${sessionId}.jsonl`))continue;
    const file=path.join(directory,entry.name),stat=await fs.stat(file);
    if(stat.size>64*1024*1024)continue;
    const input=createReadStream(file,{encoding:'utf8'}),lines=createInterface({input,crlfDelay:Infinity});
    const models=new Set<string>(),efforts=new Set<string>();let matched=false,completedAt:string|undefined,text:string|undefined,usage:unknown;
    try{
     for await(const line of lines){
      let e:any;try{e=JSON.parse(line);}catch{continue;}
      const p=e?.payload;
      if(e?.type==='session_meta'){
       if(p?.id!==sessionId||typeof p.cwd!=='string'||!samePath(p.cwd,cwd))return empty();
       const ts=Date.parse(e.timestamp);if(!Number.isFinite(ts)||!existing&&ts<startedAt-5000||ts>endedAt+5000)return empty();
       matched=true;
      }
      if(!matched)continue;
      const ts=Date.parse(e.timestamp);if(!Number.isFinite(ts)||ts<eventStart||ts>endedAt+5000)continue;
      if(e?.type==='event_msg'&&p?.type==='task_complete'){
       completedAt=new Date(ts).toISOString();if(typeof p.last_agent_message==='string')text=p.last_agent_message;
      }
      if(e?.type==='event_msg'&&p?.type==='token_count'&&p?.info?.total_token_usage)usage=p.info.total_token_usage;
      if(e?.type!=='turn_context'||typeof p?.cwd!=='string'||!samePath(p.cwd,cwd))continue;
      const model=setting(p.model),effort=setting(p.effort??p.reasoning_effort);
      if(model)models.add(model);if(effort)efforts.add(effort);
     }
    }finally{lines.close();input.destroy();}
    if(matched)return {source:'session_jsonl',observedModels:[...models],observedEfforts:[...efforts],...(models.size===1?{model:[...models][0]}:{}),...(efforts.size===1?{effort:[...efforts][0]}:{}),...(completedAt?{completed:true,completedAt,text}:{}),...(usage?{usage}:{})};
   }
  }
 }catch{/* Telemetry must never replace the provider result. */}
 return empty();
}

export function codexRuntimeMetadata(model:unknown,effort:unknown,session:CodexSessionEvidence){
 const cliModel=setting(model),cliEffort=setting(effort);
 return {model:cliModel??session.model??'unavailable',effort:cliEffort??session.effort??'unavailable',modelSource:cliModel?'cli_json':session.model?'session_jsonl':'unavailable',effortSource:cliEffort?'cli_json':session.effort?'session_jsonl':'unavailable',observedModels:[...new Set([...(cliModel?[cliModel]:[]),...session.observedModels])],observedEfforts:[...new Set([...(cliEffort?[cliEffort]:[]),...session.observedEfforts])]};
}
