import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {within} from './policy.js';

export interface WorktreeLink {path:string;target:string;outsideWorktree:boolean}
export interface LinkInspection {
 links:WorktreeLink[];linkCount:number;outsideWorktreeLinkCount:number;linksTruncated:boolean;
 linksScanComplete:boolean;linksScanErrors:string[];entriesScanned:number;
}
export interface LinkInspectionOptions {verbose?:boolean;maxEntries?:number;timeoutMs?:number}
interface LinkIdentity extends WorktreeLink {dev:number;ino:number;mtimeMs:number;rawTarget:string}
interface FullInspection extends LinkInspection {identities:LinkIdentity[]}
const mutationLimits={verbose:true,maxEntries:1_000_000,timeoutMs:60_000};

async function outsideTarget(root:string,target:string):Promise<boolean>{
 for(let hops=0;hops<40;hops++){
  if(!within(root,target))return true;
  let ancestor=root,redirected=false;
  const parts=path.relative(root,target).split(path.sep).filter(Boolean);
  for(let i=0;i<parts.length;i++){
   ancestor=path.join(ancestor,parts[i]);
   const entry=await fs.lstat(ancestor).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return undefined;throw error;});
   if(!entry)return false;
   if(entry.isSymbolicLink()){
    // Resolve only readlink text; do not enumerate through the target.
    target=path.resolve(path.dirname(ancestor),await fs.readlink(ancestor),...parts.slice(i+1));redirected=true;break;
   }
  }
  if(!redirected)return false;
 }
 throw Error('Link target resolution cycle or depth limit');
}

/** Enumerate with lstat, never descend through a symlink or Windows junction.
 * Bounds affect completeness, never the safety decision: mutation fails closed. */
async function scan(root:string,options:LinkInspectionOptions={}):Promise<FullInspection>{
 root=path.resolve(root);
 const identities:LinkIdentity[]=[],errors:string[]=[];
 const deadline=Date.now()+(options.timeoutMs??2000),maximum=options.maxEntries??10000;
 let entriesScanned=0,complete=true;
 const pending=[root];
 // A caller may inspect after a provider has moved/replaced an enclosing
 // directory. Validate the lexical path before even lstat-ing the root.
 let parent=path.parse(root).root;
 for(const part of path.relative(parent,path.dirname(root)).split(path.sep).filter(Boolean)){
  parent=path.join(parent,part);
  try{if((await fs.lstat(parent)).isSymbolicLink())throw Error('Worktree path traverses a symlink or junction ancestor');}
  catch(error){complete=false;errors.push(parent+': '+(error instanceof Error?error.message:String(error)));pending.length=0;break;}
 }
 while(pending.length){
  if(entriesScanned>=maximum||Date.now()>deadline){complete=false;errors.push('Link scan limit reached; unvisited paths may contain links');break;}
  const current=pending.pop()!;
  try{
   const stat=await fs.lstat(current);entriesScanned++;
   if(stat.isSymbolicLink()){
    const rawTarget=await fs.readlink(current),target=path.resolve(path.dirname(current),rawTarget);
    let outsideWorktree=true;
    try{outsideWorktree=await outsideTarget(root,target);}catch(error){complete=false;if(errors.length<20)errors.push(current+': '+(error instanceof Error?error.message:String(error)));}
    identities.push({path:current,target,outsideWorktree,dev:stat.dev,ino:stat.ino,mtimeMs:stat.mtimeMs,rawTarget});
   }else if(stat.isDirectory()){
    const directory=await fs.opendir(current);
    for await(const entry of directory){
     if(pending.length+entriesScanned>=maximum||Date.now()>deadline){complete=false;if(errors.length<20)errors.push('Link scan limit reached in '+current);break;}
     pending.push(path.join(current,entry.name));
    }
   }
  }catch(error){complete=false;if(errors.length<20)errors.push(current+': '+(error instanceof Error?error.message:String(error)));}
 }
 identities.sort((a,b)=>a.path.localeCompare(b.path));
 const limit=options.verbose?identities.length:20;
 return {links:identities.slice(0,limit).map(({path,target,outsideWorktree})=>({path,target,outsideWorktree})),linkCount:identities.length,
  outsideWorktreeLinkCount:identities.filter(item=>item.outsideWorktree).length,linksTruncated:identities.length>limit,
  linksScanComplete:complete,linksScanErrors:errors,entriesScanned,identities};
}
export async function inspectWorktreeLinks(root:string,options:LinkInspectionOptions={}):Promise<LinkInspection>{
 const {identities:_,...result}=await scan(root,options);return result;
}
export function linkInspectionError(message:string,inspection:LinkInspection):Error&LinkInspection{
 const summary={...inspection,links:inspection.links.slice(0,20),linksTruncated:inspection.linksTruncated||inspection.links.length>20};
 const first=summary.links[0];
 return Object.assign(Error(message+(first?`; ${first.path} -> ${first.target} (outsideWorktree=${first.outsideWorktree})`:'')),summary);
}
export function linkErrorDetails(error:unknown):Partial<LinkInspection>&{unlinkedPaths?:string[]}{
 if(!error||typeof error!=='object')return {};
 const record=error as Partial<LinkInspection>&{unlinkedPaths?:string[]};
 return {...(typeof record.linksScanComplete==='boolean'?{links:record.links,linkCount:record.linkCount,outsideWorktreeLinkCount:record.outsideWorktreeLinkCount,linksTruncated:record.linksTruncated,linksScanComplete:record.linksScanComplete,linksScanErrors:record.linksScanErrors,entriesScanned:record.entriesScanned}:{}),...(record.unlinkedPaths?{unlinkedPaths:record.unlinkedPaths}:{})};
}
export async function inspectRemovalLinks(root:string,unlinkLinks=false):Promise<LinkInspection>{
 const {identities:_,...result}=await scan(root,mutationLimits);
 if(!result.linksScanComplete)throw linkInspectionError('Incomplete worktree link scan; worktree preserved',result);
 if(result.linkCount&&!unlinkLinks)throw linkInspectionError('Worktree contains symlink or junction links; preserved. Review links and explicitly opt in with unlink_links=true',result);
 return result;
}

/** Read target metadata directly, never traverse links within the target. The
 * signature verifies file counts and mtimes before/after unlinking a junction.
 * A redirected ancestor or an incomplete snapshot fails closed. */
async function targetSnapshot(target:string){
 let ancestor=path.parse(target).root;
 for(const part of path.relative(ancestor,target).split(path.sep).filter(Boolean)){
  ancestor=path.join(ancestor,part);
  const info=await fs.lstat(ancestor).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return undefined;throw error;});
  if(!info)return {signature:'absent',directory:false};
  if(info.isSymbolicLink())throw Error('Link target has a symlink or junction ancestor; cannot verify target safely: '+ancestor);
 }
 const hash=createHash('sha256'),pending=[target],deadline=Date.now()+60_000;
 let count=0,directory=false;
 while(pending.length){
  if(++count>1_000_000||Date.now()>deadline)throw Error('Link target metadata snapshot incomplete; preserved: '+target);
  const current=pending.pop()!,stat=await fs.lstat(current);
  if(current===target)directory=stat.isDirectory();
  hash.update(JSON.stringify([path.relative(target,current),stat.dev,stat.ino,stat.mode,stat.size,stat.mtimeMs,stat.isSymbolicLink()]));
  if(stat.isDirectory()&&!stat.isSymbolicLink())for(const name of (await fs.readdir(current)).sort().reverse())pending.push(path.join(current,name));
 }
 return {signature:count+':'+hash.digest('hex'),directory};
}
async function assertUnchangedLink(root:string,link:LinkIdentity){
 // Validate every ancestor again immediately before unlink. No recursive remove
 // operation is used, even for directories: rmdir only removes the junction.
 let parent=path.resolve(root);
 if(await fs.realpath(parent)!==parent)throw Error('Worktree root was redirected during link removal; preserved');
 const rootStat=await fs.lstat(parent);
 if(rootStat.isSymbolicLink()||!rootStat.isDirectory())throw Error('Worktree root changed during link removal; preserved');
 for(const part of path.relative(root,path.dirname(link.path)).split(path.sep).filter(Boolean)){
  parent=path.join(parent,part);const stat=await fs.lstat(parent);
  if(stat.isSymbolicLink()||!stat.isDirectory())throw Error('Link ancestor changed during cleanup; preserved: '+parent);
 }
 const stat=await fs.lstat(link.path);
 if(!stat.isSymbolicLink()||stat.dev!==link.dev||stat.ino!==link.ino||stat.mtimeMs!==link.mtimeMs||await fs.readlink(link.path)!==link.rawTarget)throw Error('Link changed during cleanup; preserved: '+link.path);
}
export async function prepareWorktreeRemoval(root:string,options:{unlinkLinks?:boolean;beforeMutation?:()=>Promise<void>}={}):Promise<{unlinkedPaths:string[];linkTargetIntegrityVerified:boolean}>{
 const inspection=await scan(root,mutationLimits),{identities,...summary}=inspection,unlinkedPaths:string[]=[];
 if(!summary.linksScanComplete)throw linkInspectionError('Incomplete worktree link scan; worktree preserved',summary);
 if(identities.length&&!options.unlinkLinks)throw linkInspectionError('Worktree contains symlink or junction links; preserved. Review links and explicitly opt in with unlink_links=true',summary);
 try{
  for(const link of identities){
   if(link.path===path.resolve(root)||within(link.target,link.path))throw Error('Cannot safely unlink worktree root or a link to its ancestor; preserved: '+link.path);
   await assertUnchangedLink(root,link);
   const before=await targetSnapshot(link.target);
   await options.beforeMutation?.();
   await assertUnchangedLink(root,link);
   if(process.platform==='win32'&&before.directory)await fs.rmdir(link.path);else await fs.unlink(link.path);
   unlinkedPaths.push(link.path);
   const after=await targetSnapshot(link.target);
   if(before.signature!==after.signature)throw Error('Link target metadata changed during unlink; worktree removal stopped: '+link.target);
  }
  // Git must never receive a path with a link, including one introduced after
  // the first scan. No retry auto-removes newly introduced links.
  await inspectRemovalLinks(root,false);
  return {unlinkedPaths,linkTargetIntegrityVerified:true};
 }catch(error){
  const latest=linkErrorDetails(error);
  const detail=linkInspectionError(error instanceof Error?error.message:String(error),typeof latest.linksScanComplete==='boolean'?latest as LinkInspection:summary);
  throw Object.assign(detail,{unlinkedPaths});
 }
}
