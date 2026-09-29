import path from 'node:path';

const readers=new Set(['agent_ask','agent_review','agent_investigate','grok_ask','grok_review','grok_investigate']);
export function isReadOnlyJob(kind:string){return readers.has(kind);}
export function workspaceConflict(a:{cwd:string;kind:string},b:{cwd:string;kind:string}){
 if(isReadOnlyJob(a.kind)&&isReadOnlyJob(b.kind))return false;
 const normalized=(cwd:string)=>process.platform==='win32'?path.resolve(cwd).toLowerCase():path.resolve(cwd);
 const left=normalized(a.cwd),right=normalized(b.cwd);
 return left===right||left.startsWith(right.endsWith(path.sep)?right:right+path.sep)||right.startsWith(left.endsWith(path.sep)?left:left+path.sep);
}
export function workspaceConflictMessage(job:{cwd:string;kind:string;job_id?:string;provider?:string}){
 return `An overlapping workspace already has an active agent job: ${JSON.stringify({job_id:job.job_id??'unavailable',kind:job.kind,provider:job.provider??'unavailable',cwd:job.cwd})}. Concurrent reads are allowed; overlapping work involving an implementation is blocked. Wait for this job to finish, or use a separate non-overlapping Git worktree for parallel implementation. Different allowed_paths do not bypass this lock.`;
}
