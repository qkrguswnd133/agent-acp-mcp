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
const legacyStorage=path.join(os.tmpdir(),'agent-acp-worktrees');
export function managedWorktreeStorageRoot(){
 const configured=process.env.AGENT_MCP_WORKTREE_DIR;
 if(process.platform==='win32')return validateStorageRoot(configured??path.join(process.env.USERPROFILE??os.homedir(),'.agent-acp','worktrees'));
 const data=process.platform==='darwin'?path.join(os.homedir(),'Library','Application Support'):(process.env.XDG_DATA_HOME??path.join(os.homedir(),'.local','share'));
 return validateStorageRoot(configured??path.join(data,'Agent ACP MCP','worktrees'));
}
/** MSIX may redirect the first mkdir although its previously absent path looked
 * canonical. Check both before and after creation; never adopt that hidden root. */
async function assertWorktreeStoragePath(storage:string){
 const actual=await canonical(storage);
 if(actual!==storage)throw Error(`WORKTREE_STORAGE_REDIRECTED: Worktree storage must not traverse symlinks or package virtualization. Requested: ${storage}; resolved: ${actual}. Set AGENT_MCP_WORKTREE_DIR to an ordinary directory outside AppData, such as a worktrees folder under USERPROFILE.`);
}
function validateStorageRoot(root:string){
 if(!root.trim()||!path.isAbsolute(root)||root.includes('\0')||path.resolve(root)===path.parse(path.resolve(root)).root)throw Error('Managed worktree storage root must be an absolute non-root directory');
 return path.resolve(root);
}
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function repositoryLeaf(repository:string){
 const leaf=path.basename(repository);
 if(!leaf||leaf==='.'||leaf==='..'||/[<>:"/\\|?*\x00-\x1f]/.test(leaf)||/[. ]$/.test(leaf))throw Error('Repository name cannot be used as a managed worktree directory');
 return leaf;
}
export interface ManagedWorktree {
 originalCwd:string; repository:string; path:string; branch:string; baseCommit:string;
 sourceHadChanges:boolean; state:'preserved'|'removed'; integrationCommit?:string; integrationMethod?:'ancestor'|'patch-equivalent'; verificationSummary?:string; createdAt?:string; storageRoot?:string; recoveryBranchPreserved?:boolean;
}
async function git(cwd:string,args:string[]){
 const env=safeChildEnv({GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0'});
 const result=await execute(await resolveGitExecutable(),['-c','core.hooksPath='+path.join(os.tmpdir(),'agent-acp-disabled-hooks'),...args],{cwd,env,windowsHide:true,timeout:60000,maxBuffer:4*1024*1024});
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
 const storage=managedWorktreeStorageRoot();
 await assertWorktreeStoragePath(storage);
 if(within(repository,storage)||within(storage,repository))throw Error('Managed worktree storage must be separate from the original repository');
 await fs.mkdir(storage,{recursive:true});
 await assertWorktreeStoragePath(storage);
 const container=path.join(storage,id),target=path.join(container,leaf),branch='agent-acp/'+id;
 await fs.mkdir(container);
 await assertWorktreeStoragePath(container);
 await git(repository,['worktree','add','-b',branch,target,baseCommit]);
 const effectiveCwd=path.join(target,path.relative(repository,originalCwd));
 const worktree:ManagedWorktree={originalCwd,repository,path:target,branch,baseCommit,sourceHadChanges,state:'preserved',createdAt:new Date().toISOString(),storageRoot:await fs.realpath(storage)};
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
 const root=validateStorageRoot(value.storageRoot??legacyStorage);
 const parent=await canonical(root),target=await canonical(value.path);
 const repository=await fs.realpath(value.repository),leaf=repositoryLeaf(repository);
 const container=path.join(parent,id);
 const legacy=!value.storageRoot&&target===container;
 const current=target===path.join(container,leaf);
 if(!path.isAbsolute(value.path)||root!==parent||path.resolve(value.path)!==target||(!legacy&&!current)||within(repository,parent)||within(parent,repository))throw Error('Managed worktree ownership check failed');
 const originalCwd=await fs.realpath(value.originalCwd);
 if(!within(repository,originalCwd)||await fs.realpath(await git(originalCwd,['rev-parse','--show-toplevel']))!==repository)throw Error('Managed worktree original repository check failed');
 return {target,repository,container,current};
}
async function verifyRegistration(value:ManagedWorktree,target:string,repository:string){
 const repo=await fs.realpath(await git(target,['rev-parse','--show-toplevel']).catch(()=>{throw Error('Managed worktree ownership check failed');}));
 if(repo!==target)throw Error('Managed worktree ownership check failed');
 const common=async(cwd:string)=>fs.realpath(path.resolve(cwd,await git(cwd,['rev-parse','--git-common-dir'])));
 const [targetCommon,repositoryCommon]=await Promise.all([common(target),common(repository)]);
 if(targetCommon!==repositoryCommon)throw Error('Managed worktree Git repository changed; preserved');
 const registered=await git(repository,['worktree','list','--porcelain','-z']);
 const blocks=registered.split('\0\0');
 const matches=blocks.some(block=>{const lines=block.split('\0');return lines.some(line=>line.startsWith('worktree ')&&path.resolve(line.slice(9))===target)&&lines.includes('branch refs/heads/'+value.branch);});
 if(!matches)throw Error('Worktree registration or branch changed; preserved');
 if(await git(target,['symbolic-ref','HEAD'])!=='refs/heads/'+value.branch)throw Error('Worktree branch changed; preserved');
}
async function checkoutHealth(target:string){
 // Git's indexed/deleted listings avoid a recursive disk scan and thousands of
 // separate filesystem calls when a repository has a large tracked tree.
 const [indexed,deleted,committed]=await Promise.all([git(target,['ls-files','--cached','-z']),git(target,['ls-files','--deleted','-z']),git(target,['ls-tree','--name-only','-r','-z','HEAD'])]);
 const tracked=new Set(indexed.split('\0').filter(Boolean));
 const missing=new Set(deleted.split('\0').filter(Boolean));
 for(const name of committed.split('\0').filter(Boolean)){
  if(!tracked.has(name)&&!await fs.lstat(path.join(target,name)).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT'||error.code==='ENOTDIR')return undefined;throw error;}))missing.add(name);
  tracked.add(name);
 }
 const entries=await fs.readdir(target);
 const metadataOnly=tracked.size>0&&entries.length===1&&entries[0]==='.git';
 const missingTrackedFileCount=metadataOnly?tracked.size:missing.size;
 const checkoutState=metadataOnly?'git-metadata-only':missingTrackedFileCount===0?'complete':'partial';
 return {checkoutState,missingTrackedFileCount,trackedFileCount:tracked.size} as const;
}
export interface InspectOptions {includeDiskSize?:boolean}
export async function inspectManagedWorktree(value:ManagedWorktree,options:InspectOptions={}){
 if(value.state==='removed')return {...value};
 const {target,repository}=await ownership(value);
 if(!await fs.lstat(target).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return undefined;throw error;}))return {...value,exists:false,checkoutState:'missing' as const,nextAction:'Worktree path is missing. Registration and branch are preserved for manual inspection.'};
 await verifyRegistration(value,target,repository);
 const [head,originalHead,changes,health,changedFiles,changedNames,statusText]=await Promise.all([
  git(target,['rev-parse','HEAD']),git(repository,['rev-parse','HEAD']),git(target,['status','--porcelain','--untracked-files=all','--ignored']),checkoutHealth(target),
  git(target,['diff','--name-status',value.baseCommit,'--']),git(target,['diff','--name-only','-z',value.baseCommit,'--']),git(target,['status','--porcelain','-z','--untracked-files=all','--ignored'])
 ]);
 const names=new Set(changedNames.split('\0').filter(Boolean));
 const status=statusText.split('\0');
 for(let i=0;i<status.length;i++){const item=status[i];if(item){names.add(item.slice(3));if(/[RC]/.test(item.slice(0,2)))i++;}}
 const integratedIntoOriginalHead=await git(repository,['merge-base','--is-ancestor',head,originalHead]).then(()=>true,()=>false);
 const preview=(text:string)=>text.length<=12000?text:text.slice(0,8000)+'\n... [truncated] ...\n'+text.slice(-4000);
 return {...value,exists:true,head,tipCommit:head,originalHead,changes:preview(changes),changedFiles:preview(changedFiles),changesTruncated:changes.length>12000,changedFilesTruncated:changedFiles.length>12000,changedFileCount:names.size,
  commitCount:Number(await git(target,['rev-list','--count',value.baseCommit+'..'+head])),empty:head===value.baseCommit,commitEmpty:head===value.baseCommit,cleanEmpty:head===value.baseCommit&&!changes&&health.checkoutState==='complete',integratedIntoOriginalHead,...health,...(options.includeDiskSize?await diskUsage(target):{}),
  nextAction:health.checkoutState!=='complete'?'Tracked files are missing. Ordinary cleanup and migration are blocked; inspect the preserved branch and use explicit recovery only for a metadata-only checkout.':head===value.baseCommit&&!changes?'Clean empty worktree can be removed once the job is idle.':'Parent must review, commit, integrate, test, then call agent_worktree_cleanup. No automatic merge or deletion.'};
}
export interface CleanupOptions {dryRun?:boolean;emptyOnly?:boolean;allowPatchEquivalent?:boolean}
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
 if((await checkoutHealth(target)).checkoutState!=='complete')throw Error('Worktree checkout is damaged or partial (tracked files missing); ordinary cleanup refused, branch preserved');
 if(await git(target,['status','--porcelain','--untracked-files=all','--ignored']))throw Error('Worktree has modified, untracked or ignored files; preserved. Review/commit changes and remove generated artifacts before cleanup.');
 const tip=await git(target,['rev-parse','HEAD']);
 const empty=tip===value.baseCommit;
 if(options.emptyOnly&&!empty)throw Error('Only empty worktrees (tip equals base commit) can be cleaned for this job; preserved');
 let integrated:string|undefined,integrationMethod:ManagedWorktree['integrationMethod'];
 if(!empty){
  if(!integrationRef.trim()||(!options.dryRun&&!verificationSummary.trim()))throw Error('Nonempty worktree cleanup requires integration_ref and a verification summary');
  integrated=await git(repository,['rev-parse','--verify','--end-of-options',integrationRef+'^{commit}']);
  const originalHead=await git(repository,['rev-parse','HEAD']);
  if(integrated!==originalHead)throw Error('integration_ref must identify the currently checked-out original HEAD that parent verified');
  try{await git(repository,['merge-base','--is-ancestor',tip,integrated]);integrationMethod='ancestor';}catch{
   if(!options.allowPatchEquivalent)throw Error('Worktree commits are not merged into the verified original HEAD; preserved. Cherry-picked changes require opt-in patch equivalence verification.');
   if(!verificationSummary.trim())throw Error('Patch-equivalent cleanup requires a parent verification summary, including dry-run');
   await verifyPatchEquivalent(repository,value.baseCommit,tip,integrated);
   integrationMethod='patch-equivalent';
  }
 }
 if(options.dryRun)return {...value,dryRun:true,eligible:true,empty,tipCommit:tip,...(integrated?{integrationCommit:integrated,integrationMethod}:{})};
 // Minimize the external-Git race between eligibility and removal. Parent locking
 // serializes gateway jobs; these checks also catch manual ref/checkout changes.
 if(await git(target,['symbolic-ref','HEAD'])!=='refs/heads/'+value.branch||await git(target,['rev-parse','HEAD'])!==tip)throw Error('Worktree branch or tip changed during cleanup; preserved');
 if(integrated&&await git(repository,['rev-parse','HEAD'])!==integrated)throw Error('Original HEAD changed during cleanup; preserved');
 // Git refuses dirty worktrees; never use force or recursive filesystem deletion.
 await git(repository,['worktree','remove',target]);
 // Delete exactly the verified reference; do not delete a branch changed concurrently.
 try{await git(repository,['update-ref','-d','refs/heads/'+value.branch,tip]);}catch{throw Error(`Worktree removed but branch ${value.branch} changed or could not be removed; branch preserved.`);}
 if(current&&!(await fs.readdir(container)).length)await fs.rmdir(container).catch(()=>{});
 return {...value,state:'removed' as const,...(integrated?{integrationCommit:integrated,integrationMethod,verificationSummary}:{})};
}

async function verifyPatchEquivalent(repository:string,base:string,tip:string,integrated:string){
 const refused='Patch equivalence could not be established against current original HEAD; preserved';
 await git(repository,['merge-base','--is-ancestor',base,tip]).catch(()=>{throw Error(refused+': base is not an ancestor');});
 const commits=(await git(repository,['rev-list','--parents',base+'..'+tip])).split('\n').filter(Boolean);
 if(!commits.length||commits.some(line=>line.split(' ').length!==2))throw Error(refused+': merge or root commits require manual review');
 const covered=new Set<string>();
 for(const line of (await git(repository,['cherry',integrated,tip,base])).split('\n').filter(Boolean)){
  if(!line.startsWith('- '))throw Error(refused+': one or more commits have no equivalent patch');
  covered.add(line.slice(2));
 }
 for(const line of commits){
  const commit=line.split(' ')[0];
  if(!covered.has(commit)&&!await git(repository,['merge-base','--is-ancestor',commit,integrated]).then(()=>true,()=>false))throw Error(refused+': incomplete commit coverage');
 }
 // Historical git-cherry matches alone are insufficient: a later revert or edit
 // could have removed the integrated change. Compare the current trees for every
 // path touched by any source commit, including paths subsequently reverted.
 const changed=new Set<string>();
 for(const line of commits)for(const name of (await git(repository,['diff-tree','--no-commit-id','--name-only','--no-renames','-r','-z',line.split(' ')[0],'--'])).split('\0').filter(Boolean))changed.add(name);
 if(!changed.size)throw Error(refused+': no changed paths');
 for(const name of changed){
  const read=(ref:string)=>git(repository,['ls-tree','-z',ref,'--',':(literal)'+name]);
  if(await read(tip)!==await read(integrated))throw Error(refused+': current tree differs on a changed path');
 }
}

export interface MigrateOptions {dryRun?:boolean;targetRoot?:string}
export interface MigrateResult extends ManagedWorktree {dryRun?:boolean;eligible?:boolean;reason?:string;sourcePath:string;destinationPath?:string;restartRequired?:boolean}
export async function migrateManagedWorktree(value:ManagedWorktree,options:MigrateOptions={}):Promise<MigrateResult>{
 let destinationPath:string|undefined;
 try{
  if(value.state==='removed')throw Error('Removed worktree cannot be migrated');
  const {target,repository,container,current}=await ownership(value);
  if(!await fs.lstat(target).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return undefined;throw error;}))throw Error('Worktree path is missing; migration refused');
  await verifyRegistration(value,target,repository);
  if((await checkoutHealth(target)).checkoutState!=='complete')throw Error('Worktree checkout is damaged or partial; migration refused');
  const storageRoot=validateStorageRoot(options.targetRoot??managedWorktreeStorageRoot());
  await assertWorktreeStoragePath(storageRoot);
  if(within(repository,storageRoot)||within(storageRoot,repository)||within(target,storageRoot))throw Error('Unsafe migration storage root');
  const destinationContainer=path.join(storageRoot,value.branch.slice('agent-acp/'.length));
  destinationPath=path.join(destinationContainer,repositoryLeaf(repository));
  if(destinationPath===target)throw Error('Worktree is already at the requested storage root');
  if(await fs.lstat(destinationContainer).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return undefined;throw error;}))throw Error('Migration destination already exists; refusing collision');
  if(options.dryRun)return {...value,dryRun:true,eligible:true,sourcePath:target,destinationPath,restartRequired:true};
  const head=await git(target,['rev-parse','HEAD']);
  await fs.mkdir(storageRoot,{recursive:true});
  await assertWorktreeStoragePath(storageRoot);
  await fs.mkdir(destinationContainer);
  await assertWorktreeStoragePath(destinationContainer);
  try{
   await verifyRegistration(value,target,repository);
   if(await git(target,['rev-parse','HEAD'])!==head||(await checkoutHealth(target)).checkoutState!=='complete')throw Error('Worktree changed during migration; preserved');
   await git(repository,['worktree','move',target,destinationPath]);
  }catch(error){if(!(await fs.readdir(destinationContainer)).length)await fs.rmdir(destinationContainer).catch(()=>{});throw error;}
  const result={...value,path:destinationPath,storageRoot,sourcePath:target,destinationPath,restartRequired:true};
  try{await verifyRegistration(result,destinationPath,repository);}catch(error){throw Error(`Worktree moved to ${destinationPath}, but post-migration verification failed. Preserve and reconcile metadata using storageRoot ${storageRoot}; source was ${target}. ${error instanceof Error?error.message:String(error)}`);}
  if(current&&!(await fs.readdir(container)).length)await fs.rmdir(container).catch(()=>{});
  return result;
 }catch(error){
  if(options.dryRun)return {...value,dryRun:true,eligible:false,reason:error instanceof Error?error.message:String(error),sourcePath:value.path,...(destinationPath?{destinationPath}:{})};
  throw error;
 }
}

/** Roll back a completed move when the caller cannot persist the new job path. */
export async function rollbackManagedWorktreeMigration(original:ManagedWorktree,moved:ManagedWorktree):Promise<ManagedWorktree>{
 if(original.state!=='preserved'||moved.state!=='preserved'||original.branch!==moved.branch||original.repository!==moved.repository||original.baseCommit!==moved.baseCommit||original.originalCwd!==moved.originalCwd)throw Error('Migration rollback metadata does not identify the same worktree');
 const source=await ownership(moved),destination=await ownership(original);
 if(source.target===destination.target)throw Error('Migration rollback source and destination are identical');
 await verifyRegistration(moved,source.target,source.repository);
 if((await checkoutHealth(source.target)).checkoutState!=='complete')throw Error('Migration rollback refuses a partial checkout; reconcile metadata manually');
 if(await fs.lstat(destination.target).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return undefined;throw error;}))throw Error('Migration rollback destination already exists; preserved');
 const tip=await git(source.target,['rev-parse','HEAD']);
 await fs.mkdir(path.dirname(destination.target),{recursive:true});
 if(await canonical(destination.target)!==destination.target)throw Error('Migration rollback destination changed; preserved');
 await verifyRegistration(moved,source.target,source.repository);
 if(await git(source.target,['rev-parse','HEAD'])!==tip)throw Error('Worktree changed during migration rollback; preserved');
 await git(source.repository,['worktree','move',source.target,destination.target]);
 await verifyRegistration(original,destination.target,destination.repository);
 if(source.current&&!(await fs.readdir(source.container)).length)await fs.rmdir(source.container).catch(()=>{});
 return {...original};
}

export interface RecoveryOptions {dryRun?:boolean;action?:'restore'|'remove'}
export interface RecoveryResult extends ManagedWorktree {dryRun?:boolean;eligible?:boolean;reason?:string;recoveryAction:'restore'|'remove';recoveryBranchPreserved:true}
export async function recoverManagedWorktree(value:ManagedWorktree,verificationSummary:string,options:RecoveryOptions={}):Promise<RecoveryResult>{
 const recoveryAction=options.action??'restore';
 try{
  if(value.state==='removed')throw Error('Removed worktree cannot be recovered');
  const {target,repository,container,current}=await ownership(value);
  await verifyRegistration(value,target,repository);
  const head=await git(target,['rev-parse','HEAD']);
  const check=async()=>{
   if(await git(target,['config','--bool','core.sparseCheckout']).catch(()=>'' )==='true'||(await git(target,['ls-files','-t','-z'])).split('\0').some(line=>line.startsWith('S ')))throw Error('Recovery refuses sparse checkout or skip-worktree entries; preserved');
   const health=await checkoutHealth(target);
   if(health.checkoutState!=='git-metadata-only'||!health.trackedFileCount||health.missingTrackedFileCount!==health.trackedFileCount)throw Error('Recovery requires a metadata-only checkout with every tracked file missing; partial or unknown trees are preserved');
   if(await git(target,['diff','--cached','--name-only','HEAD','--']))throw Error('Recovery refuses staged changes; index preserved');
   if(await git(target,['rev-parse','HEAD'])!==head)throw Error('Worktree HEAD changed during recovery; preserved');
  };
  await check();
  if(options.dryRun)return {...value,dryRun:true,eligible:true,recoveryAction,recoveryBranchPreserved:true};
  if(!verificationSummary.trim())throw Error('Recovery requires a parent verification summary acknowledging missing files');
  await verifyRegistration(value,target,repository);
  await check();
  // The index has already been proven equal to HEAD. Restore its stat/checkout
  // metadata too: worktree-only restore can leave false modifications after EOL
  // conversion when GIT_OPTIONAL_LOCKS=0 prevents a later status refresh.
  // Never reset an index containing staged changes, or delete the branch here.
  await git(target,['restore','--source='+head,'--staged','--worktree','--','.']);
  await verifyRegistration(value,target,repository);
  if(await git(target,['rev-parse','HEAD'])!==head)throw Error('Worktree HEAD changed during recovery; inspect preserved checkout');
  if((await checkoutHealth(target)).checkoutState!=='complete'||await git(target,['status','--porcelain','--untracked-files=all','--ignored']))throw Error('Restored checkout needs inspection; branch and worktree preserved');
  if(recoveryAction==='remove'){
   if(await git(target,['rev-parse','HEAD'])!==head)throw Error('Worktree HEAD changed during recovery; preserved');
   await git(repository,['worktree','remove',target]);
   if(current&&!(await fs.readdir(container)).length)await fs.rmdir(container).catch(()=>{});
  }
  return {...value,state:recoveryAction==='remove'?'removed':'preserved',verificationSummary,recoveryAction,recoveryBranchPreserved:true};
 }catch(error){
  if(options.dryRun)return {...value,dryRun:true,eligible:false,reason:error instanceof Error?error.message:String(error),recoveryAction,recoveryBranchPreserved:true};
  throw error;
 }
}
