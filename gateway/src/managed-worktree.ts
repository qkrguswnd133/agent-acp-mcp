import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolveGitExecutable} from './git-read-policy.js';
import {safeChildEnv} from './process.js';
import {canonical,within} from './policy.js';
import type {RunInput} from './types.js';

const execute=promisify(execFile);
const storage=path.join(os.tmpdir(),'agent-acp-worktrees');
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function repositoryLeaf(repository:string){
 const leaf=path.basename(repository);
 if(!leaf||leaf==='.'||leaf==='..'||/[<>:"/\\|?*\x00-\x1f]/.test(leaf)||/[. ]$/.test(leaf))throw Error('Repository name cannot be used as a managed worktree directory');
 return leaf;
}
export interface ManagedWorktree {
 originalCwd:string; repository:string; path:string; branch:string; baseCommit:string;
 sourceHadChanges:boolean; state:'preserved'|'removed'; integrationCommit?:string; verificationSummary?:string; createdAt?:string;
}
async function git(cwd:string,args:string[]){
 const env=safeChildEnv({GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0'});
 const result=await execute(await resolveGitExecutable(),['-c','core.hooksPath='+path.join(storage,'disabled-hooks'),...args],{cwd,env,windowsHide:true,timeout:60000,maxBuffer:4*1024*1024});
 return args.includes('-z')?result.stdout:result.stdout.trim();
}
export async function createManagedWorktree(input:RunInput,id:string):Promise<{worktree:ManagedWorktree;input:RunInput}>{
 if(!uuidPattern.test(id))throw Error('Invalid managed worktree UUID');
 if(input.session_id)throw Error('Cannot relocate a continuing session into a new worktree');
 const originalCwd=await fs.realpath(input.cwd);
 const repository=await fs.realpath(await git(originalCwd,['rev-parse','--show-toplevel']));
 const leaf=repositoryLeaf(repository);
 const sourceHadChanges=!!await git(repository,['status','--porcelain','--untracked-files=all']);
 if(sourceHadChanges&&!input.base_ref)throw Error('WORKTREE_BASE_REQUIRED: original workspace has uncommitted changes. Supply base_ref for a committed starting point (changes will NOT be copied), or finish/commit the original work first.');
 const baseCommit=await git(repository,['rev-parse','--verify','--end-of-options',(input.base_ref??'HEAD')+'^{commit}']);
 const subdirectory=path.relative(repository,originalCwd).split(path.sep).join('/');
 if(subdirectory){const type=await git(repository,['cat-file','-t',baseCommit+':'+subdirectory]);if(type!=='tree')throw Error('Requested cwd is not a directory at base_ref');}
 const allowed=await Promise.all((input.allowed_paths??[originalCwd]).map(async value=>{
  const target=await canonical(path.resolve(originalCwd,value));
  if(!within(originalCwd,target))throw Error('allowed_paths must stay inside original cwd');
  return path.relative(repository,target);
 }));
 await fs.mkdir(storage,{recursive:true});
 const container=path.join(await fs.realpath(storage),id),target=path.join(container,leaf),branch='agent-acp/'+id;
 await fs.mkdir(container);
 await git(repository,['worktree','add','-b',branch,target,baseCommit]);
 const effectiveCwd=path.join(target,path.relative(repository,originalCwd));
 const worktree:ManagedWorktree={originalCwd,repository,path:target,branch,baseCommit,sourceHadChanges,state:'preserved',createdAt:new Date().toISOString()};
 // Retain the new worktree if subsequent preparation fails; never discard changes.
 try{await fs.access(effectiveCwd);}catch{throw Error(`Worktree created at ${target}, branch ${branch}, but requested subdirectory does not exist at ${baseCommit}. Preserved for parent inspection.`);}
 return {worktree,input:{...input,cwd:effectiveCwd,allowed_paths:allowed.map(relative=>path.join(target,relative)),context:[input.context,
  `Managed isolated worktree: ${target}. Original workspace: ${originalCwd}. Base commit: ${baseCommit}. Original uncommitted changes are NOT included. Work only inside the isolated cwd and allowed paths. Do not merge, remove the worktree, or edit the original workspace. Report changes and verification to the parent.`].filter(Boolean).join('\n\n')}};
}
async function diskUsage(root:string){
 let diskBytes=0,entries=0,diskBytesComplete=true;
 const deadline=Date.now()+2000;
 async function visit(target:string,depth:number):Promise<void>{
  if(entries++>=10000||depth>64||Date.now()>deadline){diskBytesComplete=false;return;}
  try{
   const stat=await fs.lstat(target);
   // lstat and an explicit link check prevent following directory junctions/symlinks.
   if(stat.isSymbolicLink()||!stat.isDirectory()){diskBytes+=stat.size;return;}
   const directory=await fs.opendir(target);
   for await(const entry of directory){
    if(entries>=10000||Date.now()>deadline){diskBytesComplete=false;break;}
    await visit(path.join(target,entry.name),depth+1);
   }
  }catch{diskBytesComplete=false;}
 }
 await visit(root,0);
 return {diskBytes,diskBytesComplete};
}
async function ownership(value:ManagedWorktree){
 const id=value.branch.startsWith('agent-acp/')?value.branch.slice('agent-acp/'.length):'';
 if(!uuidPattern.test(id))throw Error('Managed worktree ownership check failed');
 const parent=await canonical(storage),target=await canonical(value.path);
 const repository=await fs.realpath(value.repository),leaf=repositoryLeaf(repository);
 const container=path.join(parent,id);
 const legacy=target===container;
 const current=target===path.join(container,leaf);
 if(path.resolve(value.path)!==target||(!legacy&&!current))throw Error('Managed worktree ownership check failed');
 const originalCwd=await fs.realpath(value.originalCwd);
 if(!within(repository,originalCwd)||await fs.realpath(await git(originalCwd,['rev-parse','--show-toplevel']))!==repository)throw Error('Managed worktree original repository check failed');
 return {target,repository,container,current};
}
async function verifyRegistration(value:ManagedWorktree,target:string,repository:string){
 const repo=await fs.realpath(await git(target,['rev-parse','--show-toplevel']).catch(()=>{throw Error('Managed worktree ownership check failed');}));
 if(repo!==target)throw Error('Managed worktree ownership check failed');
 const common=async(cwd:string)=>fs.realpath(path.resolve(cwd,await git(cwd,['rev-parse','--git-common-dir'])));
 if(await common(target)!==await common(repository))throw Error('Managed worktree Git repository changed; preserved');
 const registered=await git(repository,['worktree','list','--porcelain','-z']);
 const blocks=registered.split('\0\0');
 const matches=blocks.some(block=>{const lines=block.split('\0');return lines.some(line=>line.startsWith('worktree ')&&path.resolve(line.slice(9))===target)&&lines.includes('branch refs/heads/'+value.branch);});
 if(!matches)throw Error('Worktree registration or branch changed; preserved');
 if(await git(target,['symbolic-ref','HEAD'])!=='refs/heads/'+value.branch)throw Error('Worktree branch changed; preserved');
}
export async function inspectManagedWorktree(value:ManagedWorktree){
 if(value.state==='removed')return {...value};
 const {target,repository}=await ownership(value);
 if(!await fs.lstat(target).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return undefined;throw error;}))return {...value,exists:false,nextAction:'Worktree path is missing. Registration and branch are preserved for manual inspection.'};
 await verifyRegistration(value,target,repository);
 const head=await git(target,['rev-parse','HEAD']);
 const originalHead=await git(repository,['rev-parse','HEAD']);
 const changes=await git(target,['status','--porcelain','--untracked-files=all','--ignored']);
 const changedFiles=await git(target,['diff','--name-status',value.baseCommit,'--']);
 const names=new Set((await git(target,['diff','--name-only','-z',value.baseCommit,'--'])).split('\0').filter(Boolean));
 const status=(await git(target,['status','--porcelain','-z','--untracked-files=all','--ignored'])).split('\0');
 for(let i=0;i<status.length;i++){const item=status[i];if(item){names.add(item.slice(3));if(/[RC]/.test(item.slice(0,2)))i++;}}
 const integratedIntoOriginalHead=await git(repository,['merge-base','--is-ancestor',head,originalHead]).then(()=>true,()=>false);
 const preview=(text:string)=>text.length<=12000?text:text.slice(0,8000)+'\n... [truncated] ...\n'+text.slice(-4000);
 return {...value,exists:true,head,tipCommit:head,originalHead,changes:preview(changes),changedFiles:preview(changedFiles),changesTruncated:changes.length>12000,changedFilesTruncated:changedFiles.length>12000,changedFileCount:names.size,
  commitCount:Number(await git(target,['rev-list','--count',value.baseCommit+'..'+head])),empty:head===value.baseCommit,integratedIntoOriginalHead,...await diskUsage(target),
  nextAction:head===value.baseCommit&&!changes?'Clean empty worktree can be removed once the job is idle.':'Parent must review, commit, integrate, test, then call agent_worktree_cleanup. No automatic merge or deletion.'};
}
export interface CleanupOptions {dryRun?:boolean;emptyOnly?:boolean}
export interface CleanupResult extends ManagedWorktree {dryRun?:boolean;eligible?:boolean;reason?:string;empty?:boolean;tipCommit?:string}
export async function cleanupManagedWorktree(value:ManagedWorktree,integrationRef:string,verificationSummary:string,options:CleanupOptions={}):Promise<CleanupResult>{
 if(value.state==='removed')return {...value,...(options.dryRun?{dryRun:true,eligible:true}:{})};
 try{return await cleanupChecked(value,integrationRef,verificationSummary,options);}
 catch(error){if(options.dryRun)return {...value,dryRun:true,eligible:false,reason:error instanceof Error?error.message:String(error)};throw error;}
}
async function cleanupChecked(value:ManagedWorktree,integrationRef:string,verificationSummary:string,options:CleanupOptions):Promise<CleanupResult>{
 const {target,repository,container,current}=await ownership(value);
 if(!await fs.lstat(target).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return undefined;throw error;}))throw Error('Worktree path is missing; branch and registration preserved for manual inspection');
 await verifyRegistration(value,target,repository);
 if(await git(target,['status','--porcelain','--untracked-files=all','--ignored']))throw Error('Worktree has modified, untracked or ignored files; preserved. Review/commit changes and remove generated artifacts before cleanup.');
 const tip=await git(target,['rev-parse','HEAD']);
 const empty=tip===value.baseCommit;
 if(options.emptyOnly&&!empty)throw Error('Only empty worktrees (tip equals base commit) can be cleaned for this job; preserved');
 let integrated:string|undefined;
 if(!empty){
  if(!integrationRef.trim()||(!options.dryRun&&!verificationSummary.trim()))throw Error('Nonempty worktree cleanup requires integration_ref and a verification summary');
  integrated=await git(repository,['rev-parse','--verify','--end-of-options',integrationRef+'^{commit}']);
  const originalHead=await git(repository,['rev-parse','HEAD']);
  if(integrated!==originalHead)throw Error('integration_ref must identify the currently checked-out original HEAD that parent verified');
  try{await git(repository,['merge-base','--is-ancestor',tip,integrated]);}catch{throw Error('Worktree commits are not merged into the verified original HEAD; preserved. Cherry-picked/squashed changes require manual equivalence review and cleanup.');}
 }
 if(options.dryRun)return {...value,dryRun:true,eligible:true,empty,tipCommit:tip,...(integrated?{integrationCommit:integrated}:{})};
 // Minimize the external-Git race between eligibility and removal. Parent locking
 // serializes gateway jobs; these checks also catch manual ref/checkout changes.
 if(await git(target,['symbolic-ref','HEAD'])!=='refs/heads/'+value.branch||await git(target,['rev-parse','HEAD'])!==tip)throw Error('Worktree branch or tip changed during cleanup; preserved');
 if(integrated&&await git(repository,['rev-parse','HEAD'])!==integrated)throw Error('Original HEAD changed during cleanup; preserved');
 // Git refuses dirty worktrees; never use force or recursive filesystem deletion.
 await git(repository,['worktree','remove',target]);
 // Delete exactly the verified reference; do not delete a branch changed concurrently.
 try{await git(repository,['update-ref','-d','refs/heads/'+value.branch,tip]);}catch{throw Error(`Worktree removed but branch ${value.branch} changed or could not be removed; branch preserved.`);}
 if(current&&!(await fs.readdir(container)).length)await fs.rmdir(container).catch(()=>{});
 return {...value,state:'removed' as const,...(integrated?{integrationCommit:integrated,verificationSummary}:{})};
}
