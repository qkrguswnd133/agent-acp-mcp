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
 sourceHadChanges:boolean; state:'preserved'|'removed'; integrationCommit?:string; verificationSummary?:string;
}
async function git(cwd:string,args:string[]){
 const env=safeChildEnv({GIT_TERMINAL_PROMPT:'0'});
 const result=await execute(await resolveGitExecutable(),['-c','core.hooksPath='+path.join(storage,'disabled-hooks'),...args],{cwd,env,windowsHide:true,timeout:60000,maxBuffer:4*1024*1024});
 return result.stdout.trim();
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
 const worktree:ManagedWorktree={originalCwd,repository,path:target,branch,baseCommit,sourceHadChanges,state:'preserved'};
 // Retain the new worktree if subsequent preparation fails; never discard changes.
 try{await fs.access(effectiveCwd);}catch{throw Error(`Worktree created at ${target}, branch ${branch}, but requested subdirectory does not exist at ${baseCommit}. Preserved for parent inspection.`);}
 return {worktree,input:{...input,cwd:effectiveCwd,allowed_paths:allowed.map(relative=>path.join(target,relative)),context:[input.context,
  `Managed isolated worktree: ${target}. Original workspace: ${originalCwd}. Base commit: ${baseCommit}. Original uncommitted changes are NOT included. Work only inside the isolated cwd and allowed paths. Do not merge, remove the worktree, or edit the original workspace. Report changes and verification to the parent.`].filter(Boolean).join('\n\n')}};
}
export async function inspectManagedWorktree(value:ManagedWorktree){
 if(value.state==='removed')return {...value};
 return {...value,head:await git(value.path,['rev-parse','HEAD']),changes:await git(value.path,['status','--porcelain','--untracked-files=all','--ignored']),
  changedFiles:await git(value.path,['diff','--name-status',value.baseCommit]),nextAction:'Parent must review, commit, integrate, test, then call agent_worktree_cleanup. No automatic merge or deletion.'};
}
export async function cleanupManagedWorktree(value:ManagedWorktree,integrationRef:string,verificationSummary:string){
 if(value.state==='removed')return value;
 const id=value.branch.startsWith('agent-acp/')?value.branch.slice('agent-acp/'.length):'';
 if(!uuidPattern.test(id))throw Error('Managed worktree ownership check failed');
 const parent=await fs.realpath(storage),target=await fs.realpath(value.path);
 const repository=await fs.realpath(value.repository),leaf=repositoryLeaf(repository);
 const container=path.join(parent,id);
 const legacy=target===container;
 const current=target===path.join(container,leaf);
 if(path.resolve(value.path)!==target||(!legacy&&!current))throw Error('Managed worktree ownership check failed');
 const originalCwd=await fs.realpath(value.originalCwd);
 if(!within(repository,originalCwd)||await fs.realpath(await git(originalCwd,['rev-parse','--show-toplevel']))!==repository)throw Error('Managed worktree original repository check failed');
 const repo=await fs.realpath(await git(target,['rev-parse','--show-toplevel']).catch(()=>{throw Error('Managed worktree ownership check failed');}));
 if(repo!==target)throw Error('Managed worktree ownership check failed');
 const registered=await git(repository,['worktree','list','--porcelain']);
 const blocks=registered.split(/\r?\n\r?\n/);
 const matches=blocks.some(block=>{const lines=block.split(/\r?\n/);return lines.some(line=>line.startsWith('worktree ')&&path.resolve(line.slice(9))===target)&&lines.includes('branch refs/heads/'+value.branch);});
 if(!matches)throw Error('Worktree registration or branch changed; preserved');
 if(await git(target,['status','--porcelain','--untracked-files=all','--ignored']))throw Error('Worktree has modified, untracked or ignored files; preserved. Review/commit changes and remove generated artifacts before cleanup.');
 if(await git(repository,['status','--porcelain','--untracked-files=all']))throw Error('Original workspace has uncommitted changes; finish integration and verification before cleanup');
 const tip=await git(target,['rev-parse','HEAD']);
 const integrated=await git(repository,['rev-parse','--verify','--end-of-options',integrationRef+'^{commit}']);
 const originalHead=await git(repository,['rev-parse','HEAD']);
 if(integrated!==originalHead)throw Error('integration_ref must identify the currently checked-out original HEAD that parent verified');
 try{await git(repository,['merge-base','--is-ancestor',tip,integrated]);}catch{throw Error('Worktree commits are not merged into the verified original HEAD; preserved. Cherry-picked/squashed changes require manual equivalence review and cleanup.');}
 // Git refuses dirty worktrees; never use force or recursive filesystem deletion.
 await git(repository,['worktree','remove',target]);
 // Delete exactly the verified reference; do not delete a branch changed concurrently.
 try{await git(repository,['update-ref','-d','refs/heads/'+value.branch,tip]);}catch{throw Error(`Worktree removed but branch ${value.branch} changed or could not be removed; branch preserved.`);}
 if(current&&!(await fs.readdir(container)).length)await fs.rmdir(container).catch(()=>{});
 return {...value,state:'removed' as const,integrationCommit:integrated,verificationSummary};
}
