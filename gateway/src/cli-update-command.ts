import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import type {ProviderName} from './types.js';
import {installationStateDirectory,userStateDirectory} from './state-paths.js';
import {processIdentityAsync} from './process-identity.js';
import {loadCliEnvironment} from './cli-update-environment.js';
import {isDelegatedProcess} from './process.js';
import type {CliInspection} from './cli-update-providers.js';

const providers:ProviderName[]=['grok','claude','codex'];
const uuid=/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const usage='agent-acp cli list | update <grok|claude|codex|--all> | status [--json]';
type Phase=CliInspection['status']|'checking'|'updating'|'verifying'|'updated'|'blocked';
type Row=Omit<CliInspection,'status'> & {status:Phase;retryable?:boolean;previousVersion?:string|null;verifiedVersion?:string|null};
interface Snapshot {busy:boolean;operationId:string|null;rows:Row[];updatedAt?:string}
interface RecordFile extends Snapshot {pid:number;identity?:string;startedAt:string}
interface Options {command:string; targets:ProviderName[];operationId?:string;json:boolean;expected:{path?:string;currentVersion?:string;latestVersion?:string}}
interface Dependencies {
  inspect:(provider:ProviderName)=>Promise<CliInspection>;
  sameInstallation?:(previous:CliInspection,current:CliInspection)=>boolean;
  apply:(provider:ProviderName,item:CliInspection,verifying:()=>Promise<void>)=>Promise<CliInspection>;
  lock:<T>(provider:ProviderName,action:()=>Promise<T>,options:{targetPath?:string;processPaths?:string[]})=>Promise<T>;
  read?:<T>(provider:ProviderName,action:()=>Promise<T>)=>Promise<T>;
  journal:string;
}

export function parseCliArgs(argv:string[]):Options {
  const [command,...args]=argv;
  if(!['list','update','status'].includes(command))throw Error(usage);
  let targets:ProviderName[]=providers;
  if(command==='update'){
    const target=args.shift();
    if(target!=='--all'){
      if(!providers.includes(target as ProviderName))throw Error(usage);
      targets=[target as ProviderName];
    }
  }
  const options:Options={command,targets,json:false,expected:{}};
  while(args.length){
    const key=args.shift();
    if(key==='--json'){options.json=true;continue;}
    const value=args.shift();if(!value)throw Error(usage);
    if(key==='--operation-id'&&command!=='list'&&uuid.test(value)&&!options.operationId){options.operationId=value.toLowerCase();continue;}
    if(command==='update'&&targets.length===1){
      const expectedKey=key==='--expected-path'?'path':key==='--expected-version'?'currentVersion':key==='--expected-latest'?'latestVersion':null;
      if(expectedKey&&!options.expected[expectedKey]){options.expected[expectedKey]=value;continue;}
    }
    throw Error(usage);
  }
  return options;
}

const blank=(provider:ProviderName):Row=>({provider,path:null,currentVersion:null,latestVersion:null,method:'unknown',status:'checking'});
const empty=():Snapshot=>({busy:false,operationId:null,rows:[]});
const missing=(e:unknown)=>(e as NodeJS.ErrnoException).code==='ENOENT';
const failure=(error:unknown)=>String(error instanceof Error?error.message:'CLI update failed').split(/[\r\n]/,1)[0].slice(0,400);
async function atomic(file:string,value:unknown,initial=false){
  const temp=file+'.'+randomUUID()+'.tmp';
  await fs.writeFile(temp,JSON.stringify(value)+'\n',{mode:0o600,flag:'wx'});
  try{if(initial)await fs.link(temp,file);else await fs.rename(temp,file);}
  finally{await fs.rm(temp,{force:true});}
}
async function load(file:string):Promise<RecordFile|null>{
  try{
    const stat=await fs.lstat(file);
    if(!stat.isFile()||stat.size>128*1024)throw Error('Invalid CLI update journal');
    return JSON.parse(await fs.readFile(file,'utf8'));
  }catch(error){if(missing(error))return null;throw error;}
}
async function operationStatus(record:RecordFile):Promise<Snapshot>{
  let ended=false;
  if(record.busy){
    try{process.kill(record.pid,0);}catch(error){ended=(error as NodeJS.ErrnoException).code==='ESRCH';}
    if(!ended&&record.identity&&Date.now()-Date.parse(record.updatedAt??record.startedAt)>60_000){
      const current=await processIdentityAsync(record.pid);
      if(current&&current!==record.identity)ended=true;
    }
  }
  const rows=ended?record.rows.map(row=>['checking','updating','verifying'].includes(row.status)?{...row,status:'error' as const,message:'업데이트 실행이 중단됐습니다. 현재 버전을 다시 확인하세요.'}:row):record.rows;
  return {operationId:record.operationId,busy:record.busy&&!ended,updatedAt:record.updatedAt,rows};
}
async function getStatus(directory:string,id?:string):Promise<Snapshot>{
  let names:string[];
  if(id)names=[id+'.json'];
  else{
    try{names=(await fs.readdir(directory)).filter(f=>f.endsWith('.json')&&uuid.test(f.slice(0,-5)));}
    catch(error){if(missing(error))return empty();throw error;}
  }
  const records=(await Promise.all(names.map(file=>load(path.join(directory,file))))).filter((v):v is RecordFile=>v!==null);
  const newest=records.sort((a,b)=>b.startedAt.localeCompare(a.startedAt));
  const statuses=await Promise.all(newest.map(operationStatus));
  return statuses.find(value=>value.busy)??statuses[0]??empty();
}

export async function executeCli(options:Options,deps:Dependencies):Promise<Snapshot>{
  const {command,targets}=options;
  if(command==='status')return getStatus(deps.journal,options.operationId);
  const inspect=async(p:ProviderName):Promise<CliInspection>=>{
    try{return await deps.inspect(p);}
    catch(error){return {...blank(p),status:'error',message:failure(error)};}
  };
  const read=async(p:ProviderName):Promise<Row>=>{
    try{return deps.read?await deps.read(p,()=>inspect(p)):await inspect(p);}
    catch(error){return {...blank(p),status:(error as NodeJS.ErrnoException).code==='CLI_UPDATE_BUSY'?'blocked':'error',message:failure(error)};}
  };
  if(command==='list')return {...empty(),rows:await Promise.all(targets.map(read))};
  const id=options.operationId??randomUUID(),file=path.join(deps.journal,id+'.json');
  await fs.mkdir(deps.journal,{recursive:true,mode:0o700});
  const record:RecordFile={operationId:id,busy:true,pid:process.pid,startedAt:new Date().toISOString(),rows:targets.map(blank)};
  try{await atomic(file,record,true);}catch(error){
    if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
    return getStatus(deps.journal,id); // Same request after a lost acknowledgement.
  }
  const save=async()=>{record.updatedAt=new Date().toISOString();await atomic(file,record);};
  record.identity=await processIdentityAsync(process.pid);
  const change=async(index:number,row:Row)=>{record.rows[index]=row;await save();};
  try{
    for(const [index,provider] of targets.entries()){
      const item=await read(provider);
      if(item.status==='blocked'||item.status==='error'){await change(index,item);continue;}
      if(Object.entries(options.expected).some(([key,value])=>item[key as keyof typeof options.expected]!==value)){
        await change(index,{...item,status:'blocked',message:'표시한 설치 경로 또는 버전이 변경됐습니다. 다시 확인하세요.'});continue;
      }
      if(item.status!=='available'){await change(index,item);continue;}
      try{
        await deps.lock(provider,async()=>{
          const current=await inspect(provider);
          const expected={path:item.path,currentVersion:item.currentVersion,latestVersion:item.latestVersion,...options.expected};
          if(current.status!=='available'||(deps.sameInstallation&&!deps.sameInstallation(item as CliInspection,current))||current.path!==expected.path||current.currentVersion!==expected.currentVersion||current.latestVersion!==expected.latestVersion){
            await change(index,{...current,status:'blocked',message:'설치 경로 또는 버전이 달라졌습니다. 다시 확인하세요.'});return;
          }
          const previousVersion=current.currentVersion;
          await change(index,{...current,previousVersion,status:'updating'});
          const next=await deps.apply(provider,current,()=>change(index,{...current,previousVersion,status:'verifying'}));
          await change(index,{...next,previousVersion,verifiedVersion:next.currentVersion,status:next.status==='current'?'updated':next.status});
        },{targetPath:item.path??undefined,processPaths:item.processPaths});
      }catch(error){
        const busy=(error as NodeJS.ErrnoException).code==='CLI_UPDATE_BUSY';
        await change(index,{...item,status:busy?'blocked':'error',retryable:busy,message:failure(error)});
      }
    }
  }finally{record.busy=false;await save();}
  return operationStatus(record);
}
export async function runCliMain(argv:string[]){
  const json=argv.includes('--json');
  try{
    const options=parseCliArgs(argv);
    if(options.command==='update'&&isDelegatedProcess())throw Error('NESTED_DELEGATION_BLOCKED: delegated provider sessions cannot update CLIs');
    const installRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
    const state=installationStateDirectory(installRoot);
    const journal=path.join(process.platform==='linux'?state:userStateDirectory(),'updates','cli-operations');
    let snapshot:Snapshot;
    if(options.command==='status')snapshot=await getStatus(journal,options.operationId);
    else{
      const conflicts=await loadCliEnvironment(installRoot,state);
      const {inspectCli,applyCli,sameCliInstallation}=await import('./cli-update-providers.js');
      const {withCliUpdateLock,withProviderCliUse}=await import('./cli-update-lock.js');
      snapshot=await executeCli(options,{journal,sameInstallation:sameCliInstallation,apply:applyCli,lock:withCliUpdateLock,read:withProviderCliUse,inspect:async p=>conflicts.has(p)?{...blank(p),status:'manual',message:'Gateway 호스트별 CLI 경로가 다릅니다. 해당 호스트에서 확인하세요.'}:inspectCli(p)});
    }
    const line=(row:Row)=>[row.provider,row.status,[row.previousVersion??row.currentVersion??'?',row.verifiedVersion??row.latestVersion??'?'].join(' → '),row.path,row.message].filter(Boolean).join('  ');
    console.log(json?JSON.stringify(snapshot):snapshot.rows.length?snapshot.rows.map(line).join('\n'):'No CLI update operation recorded.');
    return snapshot;
  }catch(error){
    const message=failure(error);
    if(json)console.log(JSON.stringify({...empty(),error:message}));else console.error(message);
    process.exitCode=1;
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await runCliMain(process.argv.slice(2));
