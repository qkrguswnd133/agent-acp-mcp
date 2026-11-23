import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {root, stateRoot} from './runtime.js';
import {processIdentity} from './process-identity.js';
import {readProcessInventory, type ProcessInventory, type RecordedProcessIdentity} from './process-inventory.js';
import type {ProviderAdapter, ProviderName} from './types.js';

type Options = {
 targetPath?:string | null;
 processPaths?:readonly string[];
 leaseDir?:string;
 installRoot?:string;
 stateDirectory?:string;
 inventory?:()=>Promise<ProcessInventory>;
};
const defaultDir=()=>path.join(os.homedir(),'.agent-acp-mcp','cli-leases');
const absent=(error:unknown)=>(error as NodeJS.ErrnoException).code==='ENOENT';
const busy=(message:string)=>Object.assign(new Error(message),{code:'CLI_UPDATE_BUSY'});
const validProviders=new Set(['grok','claude','codex']);
const generations=new Map<string,string>();

async function ensureDirectory(directory:string){
 await fs.mkdir(directory,{recursive:true,mode:0o700});
 const stat=await fs.lstat(directory);
 if(!stat.isDirectory()||stat.isSymbolicLink())throw busy('CLI maintenance directory must be a regular directory.');
}
async function names(directory:string){
 try{return await fs.readdir(directory);}
 catch(error){if(absent(error))return [];throw error;}
}
function livePid(pid:number){
 if(!Number.isSafeInteger(pid)||pid<1)return true;
 try{process.kill(pid,0);return true;}
 catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH';}
}

// Publish first, then inspect incompatible claims. Two concurrent contenders
// cannot both pass: each scan occurs strictly after its own atomic creation.
// Unique names make deleting our own claim safe even after another PID starts.
async function withClaim<T>(directory:string, prefix:string, action:(ours:string)=>Promise<T>,identity=''){
 await ensureDirectory(directory);
 const name=prefix+'-'+process.pid+'-'+randomUUID();
 const file=path.join(directory,name);
 await fs.writeFile(file,identity,{flag:'wx',mode:0o600});
 try{return await action(name);}finally{await fs.unlink(file).catch(error=>{if(!absent(error))throw error;});}
}
async function checkClaims(directory:string,scope:string,writing:boolean,ours:string){
 let inventory:ProcessInventory|undefined;
 for(const name of await names(directory)){
  if(name===ours)continue;
  const match=/^(grok|claude|codex|npm-[a-f0-9]{64})-(read|write)-(\d+)-([\da-f-]{36})$/i.exec(name);
  if(!match||match[1]!==scope||(!writing&&match[2]==='read'))continue;
  const pid=Number(match[3]),file=path.join(directory,name);
  if(livePid(pid)){
   let claimedAt:number;
   try{claimedAt=(await fs.stat(file)).mtimeMs;}catch(error){if(absent(error))continue;throw error;}
   // Fresh claims are almost always legitimate. For old claims, check whether
   // a reused process number started AFTER the immutable UUID file existed.
   let reused=false;
   if(pid!==process.pid&&Date.now()-claimedAt>60_000){
    try{inventory??=await readProcessInventory();const current=inventory.processes.find(p=>p.pid===pid);reused=!!current?.createdAt&&Date.parse(current.createdAt)>claimedAt+2000;}catch{/* unknown ownership blocks */}
   }
   if(!reused)throw busy((scope.startsWith('npm-')?'Shared npm installation':scope+' CLI')+' is in use (PID '+match[3]+'). Finish the task and retry.');
  }
  // UUID claim names are never recycled. An exited owner cannot reacquire this file.
  await fs.unlink(file).catch(error=>{if(!absent(error))throw error;});
 }
}
async function versionGeneration(directory:string,provider:ProviderName){
 try{return await fs.readFile(path.join(directory,provider+'.generation'),'utf8');}
 catch(error){if(absent(error))return '';throw error;}
}
export async function withProviderCliUse<T>(provider:ProviderName,action:()=>Promise<T>,invalidate?:()=>void,options:Options={}){
 const directory=options.leaseDir??defaultDir();
 return withClaim(directory,provider+'-read',async ours=>{
  await checkClaims(directory,provider,false,ours);
  if(invalidate){
   const generation=await versionGeneration(directory,provider);
   if(generations.get(provider)!==generation){invalidate();generations.set(provider,generation);}
  }
  return action();
 });
}

function normalized(value:string,platform:NodeJS.Platform){
 return platform==='win32'?path.win32.normalize(value).toLowerCase():path.posix.normalize(value);
}
export function processUsesCli(row:RecordedProcessIdentity,provider:ProviderName,paths:readonly string[],platform:NodeJS.Platform=process.platform){
 const target=paths.map(p=>normalized(p,platform));
 const separator=platform==='win32'?'\\':'/';
 const filesystem=platform==='win32'?path.win32:path.posix;
 const matches=(value?:string|null,relativeToCwd=false)=>{
  if(!value)return false;
  const candidate=normalized(relativeToCwd&&!filesystem.isAbsolute(value)&&row.cwd?filesystem.resolve(row.cwd,value):value,platform);
  return target.some(p=>candidate===p||candidate.startsWith(p+separator));
 };
 if(matches(row.executablePath))return true;
 const args=row.argv??(row.commandLine?.match(/"[^"]*"|[^\s"]+/g)??[]).map(arg=>arg.replace(/^"|"$/g,''));
 if(matches(args[0]))return true;
 const image=(row.imageName??'').toLowerCase().replace(/\.exe$/,'');
 // Linux /proc/<pid>/stat reports the thread name ("MainThread" with
 // recent Node versions); /proc/<pid>/exe identifies the actual runtime.
 const executableName=filesystem.basename(row.executablePath??'').toLowerCase().replace(/\.exe$/,'');
 if([image,executableName].some(name=>['node','nodejs','bun','deno'].includes(name))){
  // Only a script entrypoint can establish package ownership. Arguments such
  // as a user's prompt containing a CLI path do not identify an active CLI.
  let entry:string|undefined;
  for(let i=1;i<args.length;i++){
   const option=args[i];
   if(['-e','--eval','-p','--print'].includes(option))break;
   if(['-r','--require','--import','--loader','--experimental-loader','--env-file','--conditions','-C'].includes(option)){i++;continue;}
   if(!option.startsWith('-')){entry=option;break;}
  }
  if(matches(entry,true))return true;
  if(!paths.length&&entry?.replaceAll('\\','/').includes('/'+({'codex':'@openai/codex','grok':'@xai-official/grok','claude':'@anthropic-ai/claude-code'}[provider])+'/'))return true;
 }
 if(image!==provider)return false;
 // A process title can replace argv[0] (e.g. Node-based Claude). A visible
 // Node executable is not enough to distinguish installations in that case.
 if(row.executablePath&&['node','node.exe','bun','bun.exe'].includes(filesystem.basename(row.executablePath).toLowerCase()))return true;
 // A same-name process with no readable executable path is ambiguous.
 return !target.length||(!row.executablePath&&(!args[0]||!(platform==='win32'?path.win32:path.posix).isAbsolute(args[0])));
}
async function assertIdleJobs(directory:string,provider:ProviderName,inventory:ProcessInventory){
 for(const name of await names(directory)){
  if(!/^[\da-f-]{36}\.json$/i.test(name))continue;
  let job;
  try{job=JSON.parse(await fs.readFile(path.join(directory,name),'utf8'));}
  catch(error){if(absent(error))continue;throw busy('Cannot verify Gateway job '+name);}
  if(!['queued','running','cancelling'].includes(job.status))continue;
  const spec=typeof job.provider==='string'?job.provider.split(',').map((v:string)=>v.trim()):['auto'];
  if(!spec.includes('auto')&&!spec.includes(provider))continue;
  const owner=inventory.processes.find(p=>p.pid===job.ownerPid);
  if(Number.isSafeInteger(job.ownerPid)&&!owner)continue;
  if(owner?.createdAt&&Date.parse(owner.createdAt)>Date.parse(job.startedAt))continue;
  throw busy('Gateway job '+name.slice(0,-5)+' is '+job.status+'. Finish the task and retry.');
 }
}

async function assertAppIdle(install:string,state:string){
 // Native Windows updater holds this sibling file with FileShare.None.
 // Linux atomically creates and retains the state lock through rollback.
 const file=process.platform==='win32'?install+'.update.lock':path.join(state,'update.lock');
 try{
  if(process.platform==='win32'){const handle=await fs.open(file,'r');await handle.close();}
  else{await fs.access(file);throw busy('Gateway update in progress.');}
 }catch(error){if(!absent(error))throw busy('Gateway update in progress or its lock cannot be inspected.');}
}
function withPackageManager<T>(directory:string,paths:readonly string[],action:()=>Promise<T>){
 // npm installs for distinct agents can rewrite the same global node_modules.
 const npm=/^(.*[\\/]node_modules)[\\/]@(?:openai[\\/]codex|anthropic-ai[\\/]claude-code|xai-official[\\/]grok)$/i;
 const modules=paths.map(p=>npm.exec(normalized(p,process.platform))?.[1]).find(Boolean);
 if(!modules)return action();
 const scope='npm-'+createHash('sha256').update(modules).digest('hex');
 return withClaim(directory,scope+'-write',async ours=>{
  await checkClaims(directory,scope,true,ours);
  return action();
 });
}
export async function withCliUpdateLock<T>(provider:ProviderName,action:()=>Promise<T>,options:Options={}):Promise<T>{
 if(!validProviders.has(provider))throw Error('Unknown CLI provider');
 const directory=options.leaseDir??defaultDir(),install=options.installRoot??root,state=options.stateDirectory??stateRoot;
 return withClaim(install+'.cli-operations','update',async()=>{
  await assertAppIdle(install,state);
  return withClaim(directory,provider+'-write',async ours=>{
   await checkClaims(directory,provider,true,ours);
   let inventory:ProcessInventory;
   try{inventory=await (options.inventory?.()??readProcessInventory({includeExecutable:true}));}
   catch{throw busy('Cannot inspect active CLI processes. Retry when process inventory is available.');}
   if(!inventory.complete)throw busy('Cannot verify all CLI processes.');
   await assertIdleJobs(path.join(state,'jobs'),provider,inventory);
   const paths=[...(options.processPaths??[])];
   if(options.targetPath)paths.push(options.targetPath);
   const active=inventory.processes.filter(row=>row.pid!==process.pid&&processUsesCli(row,provider,paths));
   if(active.length)throw busy(provider+' CLI is running (PID '+active.map(row=>row.pid).join(', ')+'). Finish the session and retry.');
   // Invalidate before mutation, including partial install or worker failure.
   // Readers cannot observe this generation until the writer releases its claim.
   return withPackageManager(directory,paths,async()=>{
    const generation=path.join(directory,provider+'.generation'),temp=generation+'.'+randomUUID();
    await fs.writeFile(temp,randomUUID(),{flag:'wx',mode:0o600});
    try{await fs.rename(temp,generation);}finally{await fs.rm(temp,{force:true});}
    return action();
   });
  });
 },process.platform==='linux'?processIdentity(process.pid):undefined);
}

export function guardProviderCli(adapter:ProviderAdapter):ProviderAdapter{
 const read=<T>(action:()=>Promise<T>)=>withProviderCliUse(adapter.name,action,()=>adapter.invalidateCliCaches?.());
 return {
  name:adapter.name,
  status:force=>read(()=>adapter.status(force)),
  run:(kind,input,signal,hooks)=>read(()=>adapter.run(kind,input,signal,hooks)),
  cliStatus:()=>read(()=>adapter.cliStatus()),
  update:()=>withCliUpdateLock(adapter.name,()=>adapter.update()),
  ...(adapter.models?{models:(force?:boolean)=>read(()=>adapter.models!(force))}:{})
 };
}

