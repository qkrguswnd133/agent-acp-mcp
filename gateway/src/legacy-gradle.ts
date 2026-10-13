import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {presentJobPayload} from './job-payload.js';
import {processOwnershipSnapshot,assertInterruptedOwnershipAbsent,type ProcessSnapshotEntry} from './interrupted-ownership.js';
import {classifyProcessCleanup,verifyTrackedProcessesAbsent} from './process-cleanup.js';
import {readProcessInventory,type ProcessInventory} from './process-inventory.js';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const terminal=new Set(['completed','failed','cancelled','interrupted']);
export interface LegacyGradleOptions {
 jobsDirectory:string;
 roots:string[];
 sharedUserHomes?:string[];
 snapshot?:()=>Promise<ProcessSnapshotEntry[]>;
 trackedProcessesAbsent?:(job:any)=>Promise<unknown>;
 identitySnapshot?:()=>Promise<ProcessInventory>;
 platform?:NodeJS.Platform;
 currentPid?:number;
 limit?:number;
 /** Parent holds its job-start maintenance gate while this callback verifies idle state. */
 assertIdle?:()=>void|Promise<void>;
}
export interface LegacyGradleHome {
 path:string;cacheId:string;bytes:number|null;fileCount:number|null;directoryCount:number|null;jobIds:string[];statuses:string[];eligible:boolean;blockingReasons:string[];
}
interface Entry {path:string;relative:string;directory:boolean;size:number;ino:number;dev:number;mtimeMs:number;ctimeMs:number;nlink:number;}
const exists=async(file:string)=>fs.lstat(file).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
const normalized=(value:string,platform:NodeJS.Platform)=>{const result=path.resolve(value);return platform==='win32'?result.toLowerCase():result;};
const inside=(root:string,target:string,platform:NodeJS.Platform)=>{const a=normalized(root,platform),b=normalized(target,platform);return b===a||b.startsWith(a+path.sep);};
export function defaultLegacyGradleRoots(stateRoot:string,env:NodeJS.ProcessEnv=process.env,home=process.platform==='win32'?(env.USERPROFILE??env.HOME??os.homedir()):(env.HOME??os.homedir())){
 return [...new Set([path.join(home,'.agent-acp-mcp','gradle'),path.join(stateRoot,'gradle'),...(env.AGENT_MCP_STATE_DIR&&path.isAbsolute(env.AGENT_MCP_STATE_DIR)?[path.join(env.AGENT_MCP_STATE_DIR,'gradle')]:[])])];
}
async function noLinks(file:string){
 const resolved=path.resolve(file);let cursor=path.parse(resolved).root;
 for(const part of resolved.slice(cursor.length).split(path.sep).filter(Boolean)){cursor=path.join(cursor,part);try{const stat=await fs.lstat(cursor);if(stat.isSymbolicLink())throw Error(`Path traverses a link: ${cursor}`);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
 return resolved;
}
function sharedHomes(options:LegacyGradleOptions){
 const home=process.platform==='win32'?(process.env.USERPROFILE??process.env.HOME??os.homedir()):(process.env.HOME??os.homedir());
 return [path.join(home,'.gradle'),process.env.GRADLE_USER_HOME,process.env.GRADLE_RO_DEP_CACHE,...(options.sharedUserHomes??[])].filter((value):value is string=>!!value).map(value=>path.resolve(value));
}
async function guardedCache(cache:string,options:LegacyGradleOptions){
 if(!path.isAbsolute(cache))throw Error('Legacy Gradle cache path must be absolute');
 const target=path.resolve(cache),platform=options.platform??process.platform;
 if(!uuid.test(path.basename(target)))throw Error('Only UUID-named direct legacy cache directories can be inspected');
 const root=options.roots.map(root=>path.resolve(root)).find(root=>normalized(path.dirname(target),platform)===normalized(root,platform));
 if(!root)throw Error('Cache is outside the allowlisted legacy Gradle roots');
 for(const shared of sharedHomes(options)){
  const aliases=[shared];try{aliases.push(await fs.realpath(shared));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw Error('Shared Gradle cache location is unreadable; preserved');}
  if(aliases.some(alias=>inside(alias,target,platform)||inside(target,alias,platform)))throw Error('Shared user Gradle cache must never be removed');
 }
 await noLinks(root);await noLinks(target);const stat=await fs.lstat(target);if(!stat.isDirectory())throw Error('Legacy Gradle cache is not a directory');return {root,target};
}
async function inventory(cache:string):Promise<Entry[]>{
 const entries:Entry[]=[];
 async function walk(file:string,relative:string){
  const s=await fs.lstat(file);if(s.isSymbolicLink()||(!s.isDirectory()&&!s.isFile())||s.isFile()&&s.nlink!==1)throw Error(`Legacy cache contains a link, hardlink or special file: ${relative||'.'}`);
  entries.push({path:file,relative,directory:s.isDirectory(),size:s.isFile()?s.size:0,ino:s.ino,dev:s.dev,mtimeMs:s.mtimeMs,ctimeMs:s.ctimeMs,nlink:s.nlink});if(entries.length>100000)throw Error('Legacy cache inventory exceeds the safe scan limit');
  if(s.isDirectory())for(const name of (await fs.readdir(file)).sort())await walk(path.join(file,name),relative?relative+'/'+name:name);
 }
 await walk(cache,'');return entries;
}
async function jobs(options:LegacyGradleOptions){
 const directory=await noLinks(options.jobsDirectory),records:any[]=[],errors:string[]=[];
 let names:string[];try{names=await fs.readdir(directory);}catch(error){return {records,errors:[`Job inventory unavailable: ${(error as NodeJS.ErrnoException).code??'unknown'}`]};}
 for(const name of names){if(!/\.json$/i.test(name))continue;const id=name.slice(0,-5);if(!uuid.test(id)){errors.push('Job inventory contains an unknown JSON record');continue;}
  try{const file=path.join(directory,name),stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>128*1024*1024)throw Error('unsafe job record');const stored=JSON.parse(await fs.readFile(file,'utf8'));if(stored.job_id!==id||!terminal.has(stored.status)&&!['queued','running','cancelling'].includes(stored.status))throw Error('unknown job identity/status');const full=await presentJobPayload(stored,{verbose:true,jobsDirectory:directory});if(full.payload?.truncated||full.payload?.diagnostics?.some((item:any)=>item.operation==='hydration'))throw Error('full job payload unavailable');records.push(full);}catch{errors.push(`Authoritative job record unavailable: ${id}`);}
 }
 return {records,errors};
}
function hasCache(value:any,cache:string,platform:NodeJS.Platform):boolean {
 if(!value||typeof value!=='object')return false;
 if(typeof value.gradleUserHome==='string'&&path.isAbsolute(value.gradleUserHome)&&normalized(value.gradleUserHome,platform)===normalized(cache,platform))return true;
 return Array.isArray(value.results)&&value.results.some((item:any)=>hasCache(item,cache,platform));
}
async function processGate(cache:string,matched:any[],options:LegacyGradleOptions,rows:ProcessSnapshotEntry[]){
 const platform=options.platform??process.platform;
 const target=normalized(cache,platform).replace(/\\/g,'/');
 for(const item of rows){
  // Do not exempt a live owner Gateway if its cwd/arguments actually reference this cache.
  const references=(value:string)=>{const text=(platform==='win32'?value.toLowerCase():value).replace(/\\/g,'/');let at=text.indexOf(target);while(at!==-1){const next=text[at+target.length];if(next===undefined||/[\s/'"\x00]/.test(next))return true;at=text.indexOf(target,at+1);}return false;};
  if(item.cwd&&references(item.cwd)||item.commandLine&&references(item.commandLine))throw Error(`Process ${item.pid} still references this legacy Gradle cache; preserved`);
 }
 for(const job of matched){
  if(!Number.isSafeInteger(job.ownerPid)||job.ownerPid<1)throw Error(`Job ${job.job_id} owner identity is unknown`);
  assertInterruptedOwnershipAbsent({ownerPid:job.ownerPid,workspacePaths:[cache]},rows,platform,options.currentPid??process.pid,job.status!=='interrupted');
  const cleanup=classifyProcessCleanup(job.result);if(cleanup.invalidPids)throw Error(`Job ${job.job_id} contains invalid tracked process identities`);
  if(cleanup.trackedPids.length){
   if(options.trackedProcessesAbsent)await options.trackedProcessesAbsent(job);
   else await verifyTrackedProcessesAbsent(cleanup.trackedPids,{startedAt:job.startedAt,finishedAt:job.finishedAt,cleanupAt:cleanup.cleanupAt,trackedProcesses:cleanup.trackedProcesses,rootPids:[...cleanup.rootPids,job.ownerPid],rootProcesses:cleanup.rootProcesses,rootAnchorSource:'job_owner_and_observed_provider_roots',snapshot:options.identitySnapshot});
  }
 }
}
async function inspect(cache:string,options:LegacyGradleOptions,jobInventory:Awaited<ReturnType<typeof jobs>>,rows:ProcessSnapshotEntry[]|undefined,processError?:string){
 const result:LegacyGradleHome={path:path.resolve(cache),cacheId:path.basename(cache),bytes:null,fileCount:null,directoryCount:null,jobIds:[],statuses:[],eligible:false,blockingReasons:[]};let files:Entry[]=[];
 try{await guardedCache(cache,options);files=await inventory(cache);result.bytes=files.reduce((sum,item)=>sum+item.size,0);result.fileCount=files.filter(item=>!item.directory).length;result.directoryCount=files.filter(item=>item.directory).length;}catch(error){result.blockingReasons.push((error as Error).message);return {result,files};}
 const platform=options.platform??process.platform,matched=jobInventory.records.filter(job=>hasCache(job.result,cache,platform));result.jobIds=matched.map(job=>job.job_id);result.statuses=matched.map(job=>job.status);
 result.blockingReasons.push(...jobInventory.errors);
 if(!matched.length)result.blockingReasons.push('No authoritative job result records this exact Gradle cache path; UUID name alone does not prove ownership');
 if(jobInventory.records.some(job=>!terminal.has(job.status)))result.blockingReasons.push('Jobs are still queued, running or cancelling; legacy cache cleanup requires no ongoing jobs');
 if(rows&&jobInventory.records.some(job=>job.status==='interrupted'&&rows.some(row=>row.pid===job.ownerPid)))result.blockingReasons.push('An interrupted job still has a live owner; ongoing work cannot be excluded');
 if(matched.some(job=>!terminal.has(job.status)))result.blockingReasons.push('The matched job is not terminal');
 if(processError||!rows)result.blockingReasons.push(processError??'Process inventory is unavailable');
 if(!result.blockingReasons.length)try{await processGate(cache,matched,options,rows!);}catch(error){result.blockingReasons.push((error as Error).message);}
 result.eligible=result.blockingReasons.length===0;return {result,files};
}
async function freshProcesses(options:LegacyGradleOptions){try{const rows=await(options.snapshot??processOwnershipSnapshot)();if(!Array.isArray(rows)||!rows.length)throw Error('empty inventory');return {rows};}catch{return {rows:undefined,error:'Process inventory is unavailable or incomplete; cache preserved'};}}
function batchIdentities(options:LegacyGradleOptions):LegacyGradleOptions {let snapshot:Promise<ProcessInventory>|undefined;return {...options,identitySnapshot:()=>snapshot??=(options.identitySnapshot??readProcessInventory)()};}
export async function listLegacyGradleHomes(options:LegacyGradleOptions){
 options=batchIdentities(options);
 const roots=[...new Set(options.roots.map(root=>path.resolve(root)))],caches:LegacyGradleHome[]=[],errors:string[]=[];
 const jobInventory=await jobs(options),processes=await freshProcesses(options);const limit=Math.min(Math.max(options.limit??100,1),500);let truncated=false;
 for(const root of roots){try{await noLinks(root);if(!await exists(root))continue;for(const name of (await fs.readdir(root)).sort()){if(!uuid.test(name))continue;if(caches.length>=limit){truncated=true;break;}caches.push((await inspect(path.join(root,name),options,jobInventory,processes.rows,processes.error)).result);}}catch(error){errors.push(`${root}: ${(error as Error).message}`);}}
 return {roots,caches,errors,truncated,checkedAt:new Date().toISOString(),note:'Only authoritative job-owned legacy homes are eligible; shared user caches and job records are preserved.'};
}
export async function cleanupLegacyGradleHome(options:LegacyGradleOptions&{path:string;dryRun?:boolean}){
 const dryRun=options.dryRun!==false,guard=await guardedCache(options.path,options);
 await options.assertIdle?.();
 const blocked=(value:LegacyGradleHome)=>({...value,status:'blocked' as const,dryRun,removedBytes:0,removedPaths:[] as string[],checkedAt:new Date().toISOString()});
 const firstProcesses=await freshProcesses(options),first=await inspect(guard.target,batchIdentities(options),await jobs(options),firstProcesses.rows,firstProcesses.error);
 if(!first.result.eligible)return blocked(first.result);
 if(dryRun)return {...first.result,status:'dry_run' as const,dryRun,removedBytes:0,removedPaths:[] as string[],wouldRemoveBytes:first.result.bytes,wouldRemovePaths:first.files.filter(item=>!item.directory).map(item=>item.path),checkedAt:new Date().toISOString()};
 const lock=path.join(guard.root,'.legacy-gradle-cleanup.lock');await noLinks(lock);const operationId=randomUUID();let handle:Awaited<ReturnType<typeof fs.open>>|undefined;
 const removedPaths:string[]=[];let removedBytes=0;
 try{
  handle=await fs.open(lock,'wx',0o600);await handle.writeFile(JSON.stringify({operationId,pid:process.pid,startedAt:new Date().toISOString(),path:guard.target}));
  await guardedCache(guard.target,options);const currentProcesses=await freshProcesses(options),current=await inspect(guard.target,batchIdentities(options),await jobs(options),currentProcesses.rows,currentProcesses.error);
  if(!current.result.eligible)return blocked(current.result);
  if(JSON.stringify(first.files)!==JSON.stringify(current.files))throw Error('Legacy cache changed while acquiring the cleanup lock; preserved');
  // Recheck every entry before unlinking any data; rmdir is non-recursive and
  // therefore refuses unexpected new contents rather than force-removing them.
  const validated=await inventory(guard.target);if(JSON.stringify(current.files)!==JSON.stringify(validated))throw Error('Legacy cache changed during validation; preserved');
  // A large filesystem walk can outlive a process snapshot. Take one final
  // batched ownership check after it, not one CIM invocation per file/PID.
  const finalJobs=await jobs(options),finalProcesses=await freshProcesses(options);
  if(finalJobs.errors.length||finalJobs.records.some(job=>!terminal.has(job.status)))throw Error('Job inventory changed or ongoing jobs were found before cleanup; preserved');
  if(!finalProcesses.rows)throw Error(finalProcesses.error);
  const finalMatched=finalJobs.records.filter(job=>hasCache(job.result,guard.target,options.platform??process.platform));
  if(!finalMatched.length||JSON.stringify(finalMatched.map(job=>job.job_id).sort())!==JSON.stringify(current.result.jobIds.slice().sort()))throw Error('Recorded cache ownership changed before cleanup; preserved');
  if(finalJobs.records.some(job=>job.status==='interrupted'&&finalProcesses.rows!.some(row=>row.pid===job.ownerPid)))throw Error('An interrupted job owner is still alive; preserved');
  await processGate(guard.target,finalMatched,batchIdentities(options),finalProcesses.rows);
  await guardedCache(guard.target,options);
  await options.assertIdle?.();
  for(const entry of current.files.filter(item=>!item.directory)){
   await noLinks(entry.path);const s=await fs.lstat(entry.path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.ino!==entry.ino||s.dev!==entry.dev||s.size!==entry.size||s.mtimeMs!==entry.mtimeMs||s.ctimeMs!==entry.ctimeMs)throw Error('Legacy cache file changed during cleanup; remaining files preserved');
   await fs.unlink(entry.path);removedPaths.push(entry.path);removedBytes+=entry.size;
  }
  for(const entry of current.files.filter(item=>item.directory).sort((a,b)=>b.path.length-a.path.length)){await noLinks(entry.path);const s=await fs.lstat(entry.path);if(!s.isDirectory()||s.ino!==entry.ino||s.dev!==entry.dev)throw Error('Legacy cache directory identity changed; remaining paths preserved');await fs.rmdir(entry.path);}
  return {...current.result,status:'removed' as const,dryRun,removedBytes,removedPaths,checkedAt:new Date().toISOString()};
 }catch(error){return {...first.result,eligible:false,status:'blocked' as const,dryRun,partial:removedPaths.length>0,removedBytes,removedPaths,blockingReasons:[(error as NodeJS.ErrnoException).code==='EEXIST'?'Another legacy Gradle cleanup holds the lock; cache preserved':(error as Error).message],checkedAt:new Date().toISOString()};}
 finally{if(handle){await handle.close();try{const value=JSON.parse(await fs.readFile(lock,'utf8'));if(value.operationId===operationId)await fs.unlink(lock);}catch{}}}
}
