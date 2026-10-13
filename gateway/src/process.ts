import {spawn,execFile,type ChildProcess} from 'node:child_process';
import {homedir} from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import {trackProcessTree,type ProcessCleanup} from './process-tree.js';
import {withRootExitEvidence} from './process-cleanup.js';

export function processHome(platform:NodeJS.Platform=process.platform,env:NodeJS.ProcessEnv=process.env){return platform==='win32'?(env.USERPROFILE??env.HOME??homedir()):(env.HOME??homedir());}
export const home=processHome();
export const delegationKey='AGENT_ACP_MCP_DELEGATED';
export function isDelegatedProcess(){return process.env[delegationKey]==='1';}
export function providerChildEnv(extra:NodeJS.ProcessEnv={}):NodeJS.ProcessEnv{return {...safeChildEnv(extra),[delegationKey]:'1'};}

const safeKeys=/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|USERPROFILE|HOME|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|TEMP|TMP|LANG|LC_ALL|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|CODEX_HOME|CODEX_POWERSHELL_PATH|CLAUDE_CONFIG_DIR)$/i;
const secretKey=/(API[_-]?KEY|TOKEN|SECRET|PASSWORD|BEARER|CREDENTIAL)/i;

export function safeChildEnv(extra:NodeJS.ProcessEnv={}):NodeJS.ProcessEnv {
  const env:NodeJS.ProcessEnv={};
  for(const [key,value] of Object.entries(process.env))if(value!==undefined&&safeKeys.test(key)&&!secretKey.test(key))env[key]=value;
  for(const [key,value] of Object.entries(extra))if(value!==undefined&&!secretKey.test(key))env[key]=value;
  delete env.ANTHROPIC_API_KEY;delete env.OPENAI_API_KEY;delete env.XAI_API_KEY;
  if(isDelegatedProcess())env[delegationKey]='1';
  return env;
}

export async function terminateProcess(p:ChildProcess):Promise<boolean>{
  if(p.exitCode!==null||p.signalCode!==null||!p.pid)return true;
  const closed=new Promise<boolean>(resolve=>{
    const t=setTimeout(()=>resolve(p.exitCode!==null||p.signalCode!==null),5000);
    p.once('close',()=>{clearTimeout(t);resolve(true);});
  });
  if(process.platform==='win32'){
    await new Promise<void>(resolve=>execFile(path.join(process.env.SystemRoot??'C:/Windows','System32/taskkill.exe'),['/PID',String(p.pid),'/T','/F'],{windowsHide:true,timeout:4000},()=>resolve()));
  }else{
    let descendants:number[]=[];
    try{
      const ps=await new Promise<string>((resolve,reject)=>execFile('ps',['-eo','pid=,ppid='],{timeout:3000},(e,stdout)=>e?reject(e):resolve(stdout)));
      const byParent=new Map<number,number[]>();
      for(const line of ps.split(/\r?\n/)){const [pidText,ppidText]=line.trim().split(/\s+/);const pid=Number(pidText),ppid=Number(ppidText);if(Number.isFinite(pid)&&Number.isFinite(ppid)){const list=byParent.get(ppid)??[];list.push(pid);byParent.set(ppid,list);}}
      const visit=(pid:number)=>{for(const child of byParent.get(pid)??[]){visit(child);descendants.push(child);}};visit(p.pid);
    }catch{}
    for(const pid of descendants)try{process.kill(pid,'SIGTERM');}catch{}
    try{p.kill('SIGTERM');}catch{}
    await new Promise(r=>setTimeout(r,250));
    for(const pid of descendants)try{process.kill(pid,'SIGKILL');}catch{}
    if(p.exitCode===null&&p.signalCode===null)try{p.kill('SIGKILL');}catch{}
    const deadline=Date.now()+4500;
    while(Date.now()<deadline){let alive=false;for(const pid of descendants)try{process.kill(pid,0);alive=true;}catch{}if(!alive)break;await new Promise(r=>setTimeout(r,50));}
  }
  return closed;
}

function splitLines(value:string){return value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);}

export async function resolveExecutable(explicit:string|undefined,names:string[],candidates:string[]=[]):Promise<string|undefined>{
  if(explicit){try{if((await fs.stat(explicit)).isFile())return explicit;}catch{} }
  for(const candidate of candidates){try{if((await fs.stat(candidate)).isFile())return candidate;}catch{} }
  const finder=process.platform==='win32'?'where.exe':'which';
  for(const name of names){
    try{
      const result=await new Promise<string>((resolve,reject)=>execFile(finder,[name],{windowsHide:true,timeout:5000},(e,stdout)=>e?reject(e):resolve(stdout)));
      // npm installs extensionless POSIX shims beside .cmd launchers. Windows
      // cannot spawn those shims, even when where.exe lists them first.
      const first=splitLines(result).find(file=>process.platform!=='win32'||/\.(exe|com|cmd|bat)$/i.test(file));if(first)return first;
    }catch{}
  }
  return undefined;
}

function windowsCmdLine(parts:string[]):string{
  return parts.map(value=>{
    if(!/[\s"&|<>^]/.test(value))return value;
    return `"${value.replace(/(\\*)"/g,'$1$1\\"').replace(/(\\+)$/,'$1$1')}"`;
  }).join(' ');
}


export async function findExecutableInChildDirs(base:string,filename:string):Promise<string|undefined>{
  try{
    const entries=await fs.readdir(base,{withFileTypes:true});
    const candidates: {path:string;mtime:number}[]=[];
    for(const entry of entries){
      if(!entry.isDirectory())continue;
      const candidate=path.join(base,entry.name,filename);
      try{const stat=await fs.stat(candidate);if(stat.isFile())candidates.push({path:candidate,mtime:stat.mtimeMs});}catch{}
    }
    candidates.sort((a,b)=>b.mtime-a.mtime);return candidates[0]?.path;
  }catch{return undefined;}
}

export interface CommandResult {code:number|null;signal:NodeJS.Signals|null;stdout:string;stderr:string;timedOut:boolean;stopReason?:'completed'|'cancelled'|'deadline_exceeded';processCleanup?:ProcessCleanup;}
export function commandInvocation(command:string,args:string[],cwd?:string):{command:string;args:string[]}{
  assertBatchCwdSupported(command,cwd);
  if(process.platform==='win32'&&/\.(cmd|bat)$/i.test(command)){
    return {command:process.env.ComSpec??'C:/Windows/System32/cmd.exe',args:['/d','/s','/c',windowsCmdLine([command,...args])]};
  }
  return {command,args};
}

/** A launcher that is either an executable path or an executable plus fixed
 * leading arguments, e.g. a genuine Node runtime and a package's JS entry. */
export interface LaunchDescriptor {command:string;argsPrefix?:readonly string[];source?:string;}
export type LaunchCommand=string|LaunchDescriptor;
export function launchInvocation(launch:LaunchCommand,args:readonly string[]):{command:string;args:string[]}{
  return typeof launch==='string'?{command:launch,args:[...args]}:{command:launch.command,args:[...(launch.argsPrefix??[]),...args]};
}
export function isBatchCommand(command:string,platform:NodeJS.Platform=process.platform){return platform==='win32'&&/\.(cmd|bat)$/i.test(command);}
/** UNC shares (\\server\share, \\wsl.localhost, \\wsl$), device paths and their forward-slash forms. */
export function isUncPath(value:string){return /^[\\/]{2}[^\\/]/.test(value);}
/** cmd.exe cannot use a UNC current directory: it silently falls back to
 * C:\Windows, so a batch launcher would run somewhere the caller never chose. */
export function assertBatchCwdSupported(command:string,cwd:string|undefined,platform:NodeJS.Platform=process.platform){
  const effective=cwd??process.cwd();
  if(isBatchCommand(command,platform)&&isUncPath(effective))
    throw Error(`Refusing to run Windows batch launcher ${command} with UNC working directory ${effective}: cmd.exe does not support UNC current directories. Configure a native executable instead.`);
}

/** Spawn-ready argv for a launcher. Every direct spawn of a provider CLI goes
 * through here so a batch launcher with a UNC cwd is refused before spawn. */
export function spawnPlan(launch:LaunchCommand,args:readonly string[],cwd?:string):{command:string;args:string[];windowsVerbatimArguments:boolean}{
  const resolved=launchInvocation(launch,args);
  const invocation=commandInvocation(resolved.command,resolved.args,cwd);
  const batch=isBatchCommand(resolved.command);
  // cmd /s removes the outer quotes; preserve quoted batch paths containing spaces.
  if(batch)invocation.args[3]='"'+invocation.args[3]+'"';
  return {...invocation,windowsVerbatimArguments:batch};
}

export interface CommandOptions {cwd?:string;env?:NodeJS.ProcessEnv;stdin?:string;timeoutMs?:number;signal?:AbortSignal;onSpawn?:(p:ChildProcess)=>void;onActivity?:(event:Record<string,unknown>)=>void;onStdoutChunk?:(chunk:string)=>void;onStdoutLine?:(line:string)=>void;completion?:()=>boolean|Promise<boolean>;completionGraceMs?:number;trackDescendants?:boolean;}
export async function runCommand(launch:LaunchCommand,args:string[],options:CommandOptions={}):Promise<CommandResult>{
  if(options.signal?.aborted)return {code:null,signal:null,stdout:'',stderr:'',timedOut:false,stopReason:'cancelled'};
  const invocation=spawnPlan(launch,args,options.cwd);
  const p=spawn(invocation.command,invocation.args,{cwd:options.cwd,env:options.env??safeChildEnv(),windowsHide:true,windowsVerbatimArguments:invocation.windowsVerbatimArguments,shell:false,stdio:['pipe','pipe','pipe']});
  options.onSpawn?.(p);
  options.onActivity?.({type:'process_spawn',pid:p.pid??null,at:new Date().toISOString()});
  const tree=options.trackDescendants&&p.pid?trackProcessTree(p.pid,()=>p.exitCode===null&&p.signalCode===null):undefined;
  let stdout='',stderr='',lineBuffer='',timedOut=false,stopReason:CommandResult['stopReason'];
  // StringDecoder in the stream preserves multi-byte text split across chunks.
  p.stdout?.setEncoding('utf8');p.stderr?.setEncoding('utf8');
  p.stdout?.on('data',d=>{stdout+=String(d);options.onStdoutChunk?.(String(d));lineBuffer+=String(d);const lines=lineBuffer.split(/\r?\n/);lineBuffer=lines.pop()??'';for(const line of lines)options.onStdoutLine?.(line);options.onActivity?.({type:'stdout',at:new Date().toISOString()});});
  p.stderr?.on('data',d=>{stderr+=String(d);options.onActivity?.({type:'stderr',at:new Date().toISOString()});});
  p.stdin?.on('error',()=>{/* EPIPE after a terminal event must not crash the host. */});
  if(options.stdin!==undefined){p.stdin?.end(options.stdin);}else p.stdin?.end();
  let timer:NodeJS.Timeout|undefined,watch:NodeJS.Timeout|undefined,grace:NodeJS.Timeout|undefined,hardStop:NodeJS.Timeout|undefined,finishing=false,probing=false;
  let settle!:(code:number|null,signal:NodeJS.Signals|null)=>void;
  const stop=(reason:NonNullable<CommandResult['stopReason']>)=>{
    if(stopReason)return;stopReason=reason;
    // Never depend on close: inherited pipes and broken native teardown can
    // leave it pending even after taskkill or the root's exit event.
    hardStop=setTimeout(()=>settle(p.exitCode,p.signalCode),7000);
    void terminateProcess(p).catch(()=>false).finally(()=>settle(p.exitCode,p.signalCode));
  };
  const abort=()=>stop('cancelled');
  return new Promise<CommandResult>((resolve,reject)=>{
    settle=(code,signal)=>{
      if(finishing)return;finishing=true;
      if(timer)clearTimeout(timer);if(watch)clearInterval(watch);if(grace)clearTimeout(grace);if(hardStop)clearTimeout(hardStop);options.signal?.removeEventListener('abort',abort);
      if(lineBuffer){options.onStdoutLine?.(lineBuffer);lineBuffer='';}
      void (async()=>{
        let cleanup:ProcessCleanup|undefined;
        if(tree){let bound:NodeJS.Timeout|undefined;cleanup=await Promise.race([tree.cleanup(),new Promise<ProcessCleanup>(done=>{bound=setTimeout(()=>{tree.cancelCleanup();done({trackedPids:tree.knownPids(),trackedProcesses:tree.knownProcesses?.(),rootPid:p.pid,rootProcess:tree.rootProcess?.(),observedAt:new Date().toISOString(),remainingPids:[],unverifiedPids:tree.knownPids(),verified:false,note:'Process cleanup deadline reached; listed PIDs have not been rechecked, ownership/exit verification is incomplete.'});},7000);})]);if(bound)clearTimeout(bound);}
        if(cleanup&&p.pid&&p.exitCode===null&&p.signalCode===null)cleanup=withRootExitEvidence(cleanup,p.pid);
        if(cleanup)options.onActivity?.({type:'process_cleanup',...cleanup,at:new Date().toISOString()});
        // Release inherited pipe handles even if a child did not close them.
        p.stdout?.destroy();p.stderr?.destroy();p.stdin?.destroy();p.unref();
        resolve({code,signal,stdout,stderr,timedOut,...(stopReason?{stopReason}:{}),...(cleanup?{processCleanup:cleanup}:{})});
      })().catch(reject);
    };
    p.once('error',error=>{stderr+=error.message;settle(p.exitCode,p.signalCode);});
    p.once('close',(code,signal)=>settle(code,signal));
    // exit is sufficient to start a short pipe-drain grace, then finalize.
    p.once('exit',(code,signal)=>{if(!hardStop)hardStop=setTimeout(()=>settle(code,signal),250);});
    options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
    if(options.timeoutMs)timer=setTimeout(()=>{timedOut=true;stop('deadline_exceeded');},options.timeoutMs);
    if(options.completion)watch=setInterval(()=>{if(probing||finishing||stopReason||grace)return;probing=true;void Promise.resolve(options.completion!()).then(completed=>{if(completed&&!finishing&&!stopReason&&!grace)grace=setTimeout(()=>stop('completed'),options.completionGraceMs??1500);}).catch(()=>{/* Session telemetry is optional. */}).finally(()=>{probing=false;});},250);
  });
}
