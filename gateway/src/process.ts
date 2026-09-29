import {spawn,execFile,type ChildProcess} from 'node:child_process';
import {homedir} from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';

export const home=process.env.USERPROFILE??process.env.HOME??homedir();
export const delegationKey='AGENT_ACP_MCP_DELEGATED';
export function isDelegatedProcess(){return process.env[delegationKey]==='1';}
export function providerChildEnv(extra:NodeJS.ProcessEnv={}):NodeJS.ProcessEnv{return {...safeChildEnv(extra),[delegationKey]:'1'};}

const safeKeys=/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|USERPROFILE|HOME|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|TEMP|TMP|LANG|LC_ALL|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|CODEX_HOME|CLAUDE_CONFIG_DIR)$/i;
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

export interface CommandResult {code:number|null;signal:NodeJS.Signals|null;stdout:string;stderr:string;timedOut:boolean;}
export function commandInvocation(command:string,args:string[]):{command:string;args:string[]}{
  if(process.platform==='win32'&&/\.(cmd|bat)$/i.test(command)){
    return {command:process.env.ComSpec??'C:/Windows/System32/cmd.exe',args:['/d','/s','/c',windowsCmdLine([command,...args])]};
  }
  return {command,args};
}

export async function runCommand(command:string,args:string[],options:{cwd?:string;env?:NodeJS.ProcessEnv;stdin?:string;timeoutMs?:number;signal?:AbortSignal;onSpawn?:(p:ChildProcess)=>void;onActivity?:(event:Record<string,unknown>)=>void}={}):Promise<CommandResult>{
  const invocation=commandInvocation(command,args);
  const batch=process.platform==='win32'&&/\.(cmd|bat)$/i.test(command);
  if(batch)invocation.args[3]='"'+invocation.args[3]+'"';
  const p=spawn(invocation.command,invocation.args,{cwd:options.cwd,env:options.env??safeChildEnv(),windowsHide:true,windowsVerbatimArguments:batch,stdio:['pipe','pipe','pipe']});
  options.onSpawn?.(p);
  let stdout='',stderr='',timedOut=false;
  p.stdout?.on('data',d=>{stdout+=String(d);options.onActivity?.({type:'stdout',at:new Date().toISOString()});});
  p.stderr?.on('data',d=>{stderr+=String(d);options.onActivity?.({type:'stderr',at:new Date().toISOString()});});
  if(options.stdin!==undefined){p.stdin?.end(options.stdin);}else p.stdin?.end();
  let timer:NodeJS.Timeout|undefined;
  const stop=()=>{void terminateProcess(p);};
  if(options.signal){if(options.signal.aborted)stop();else options.signal.addEventListener('abort',stop,{once:true});}
  if(options.timeoutMs)timer=setTimeout(()=>{timedOut=true;stop();},options.timeoutMs);
  const result=await new Promise<CommandResult>((resolve,reject)=>{
    p.once('error',reject);
    p.once('close',(code,signal)=>resolve({code,signal,stdout,stderr,timedOut}));
  }).finally(()=>{if(timer)clearTimeout(timer);options.signal?.removeEventListener('abort',stop);});
  return result;
}
