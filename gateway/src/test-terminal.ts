import {spawn,type ChildProcess} from 'node:child_process';
import {commandInvocation,terminateProcess,safeChildEnv} from './process.js';

export interface ExecutionRecord {command:string;args:string[];cwd:string;source:'acp_terminal';status:string;exitCode:number|null;signal:string|null;output:string;truncated:boolean;startedAt:string;finishedAt?:string;}
/** Async ACP terminal with bounded output, real exit status and process-tree cancellation. */
export class TestTerminal {
 readonly record:ExecutionRecord;
 readonly done:Promise<void>;
 private child:ChildProcess;
 private stopReason:string|undefined;
 constructor(command:string,args:string[],cwd:string,deadline:number,signal:AbortSignal,activity:()=>void,env=safeChildEnv(),limit=1024*1024){
  this.record={command,args,cwd,source:'acp_terminal',status:'running',exitCode:null,signal:null,output:'',truncated:false,startedAt:new Date().toISOString()};
  const invocation=commandInvocation(command,args);
  // cmd /s removes the outer quotes; preserve quoted batch paths containing spaces.
  if(process.platform==='win32'&&/\.(cmd|bat)$/i.test(command))invocation.args[3]='"'+invocation.args[3]+'"';
  this.child=spawn(invocation.command,invocation.args,{cwd,env,windowsHide:true,windowsVerbatimArguments:process.platform==='win32'&&/\.(cmd|bat)$/i.test(command),stdio:['ignore','pipe','pipe']});
  const append=(chunk:Buffer)=>{this.record.output+=chunk.toString();if(this.record.output.length>limit){this.record.output=this.record.output.slice(-limit);this.record.truncated=true;}activity();};
  this.child.stdout?.on('data',append);this.child.stderr?.on('data',append);
  const abort=()=>{void this.stop('cancelled');};
  let timer:NodeJS.Timeout|undefined;
  this.done=new Promise<void>(resolve=>{
   const finish=(status:string)=>{this.record.status=status;this.record.finishedAt=new Date().toISOString();if(timer)clearTimeout(timer);signal.removeEventListener('abort',abort);activity();resolve();};
   this.child.once('error',error=>{append(Buffer.from(error.message));finish('spawn_failed');});
   this.child.once('close',(code,sig)=>{this.record.exitCode=code;this.record.signal=sig;if(this.record.status==='running')finish(this.stopReason??'completed');});
  });
  timer=setTimeout(()=>{void this.stop('deadline_exceeded');},Math.max(1,deadline-Date.now()));
  signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
 }
 async stop(reason='killed'){if(this.record.status!=='running')return;this.stopReason??=reason;await terminateProcess(this.child);await this.done;}
 exitStatus(){return {...(this.record.exitCode!==null?{exitCode:this.record.exitCode}:{}),...(this.record.signal?{signal:this.record.signal}:{})};}
 output(){return {output:this.record.output,truncated:this.record.truncated,...(this.record.status==='running'?{}:{exitStatus:this.exitStatus()})};}
}
