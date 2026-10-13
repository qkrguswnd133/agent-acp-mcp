import {spawn,type ChildProcess} from 'node:child_process';
import {commandInvocation,terminateProcess,safeChildEnv} from './process.js';
import {trackProcessTree,type ProcessCleanup} from './process-tree.js';

export interface ExecutionRecord {command:string;args:string[];cwd:string;source:'acp_terminal';status:string;exitCode:number|null;signal:string|null;output:string;truncated:boolean;startedAt:string;finishedAt?:string;processCleanup?:ProcessCleanup;childCleanedUp?:boolean;}
/** Async ACP terminal with bounded output, real exit status and process-tree cancellation. */
export class TestTerminal {
 readonly record:ExecutionRecord;
 readonly done:Promise<void>;
 private child:ChildProcess;
 private stopReason:string|undefined;
 private finish!:(status:string)=>void;
 private stopping:Promise<void>|undefined;
 constructor(command:string,args:string[],cwd:string,deadline:number,signal:AbortSignal,activity:()=>void,env=safeChildEnv(),limit=1024*1024){
  this.record={command,args,cwd,source:'acp_terminal',status:'running',exitCode:null,signal:null,output:'',truncated:false,startedAt:new Date().toISOString()};
  const invocation=commandInvocation(command,args,cwd);
  // cmd /s removes the outer quotes; preserve quoted batch paths containing spaces.
  if(process.platform==='win32'&&/\.(cmd|bat)$/i.test(command))invocation.args[3]='"'+invocation.args[3]+'"';
  this.child=spawn(invocation.command,invocation.args,{cwd,env,windowsHide:true,windowsVerbatimArguments:process.platform==='win32'&&/\.(cmd|bat)$/i.test(command),stdio:['ignore','pipe','pipe']});
  const tree=this.child.pid?trackProcessTree(this.child.pid,()=>this.child.exitCode===null&&this.child.signalCode===null):undefined;
  this.child.stdout?.setEncoding('utf8');this.child.stderr?.setEncoding('utf8');
  const append=(chunk:Buffer|string)=>{this.record.output+=chunk.toString();if(this.record.output.length>limit){this.record.output=this.record.output.slice(-limit);this.record.truncated=true;}activity();};
  this.child.stdout?.on('data',append);this.child.stderr?.on('data',append);
  const abort=()=>{void this.stop('cancelled');};
  let timer:NodeJS.Timeout|undefined,drainTimer:NodeJS.Timeout|undefined,finishing=false;
  this.done=new Promise<void>(resolve=>{
   this.finish=(status:string)=>{
    if(finishing)return;finishing=true;if(timer)clearTimeout(timer);if(drainTimer)clearTimeout(drainTimer);signal.removeEventListener('abort',abort);
    void (async()=>{
     if(tree){let bound:NodeJS.Timeout|undefined;try{
      this.record.processCleanup=await Promise.race([tree.cleanup(),new Promise<ProcessCleanup>(done=>{bound=setTimeout(()=>{tree.cancelCleanup();done({trackedPids:tree.knownPids(),remainingPids:tree.knownPids(),verified:false,note:'Terminal cleanup deadline reached; ownership or exit remains unconfirmed.'});},7000);})]);
     }catch{this.record.processCleanup={trackedPids:tree.knownPids(),remainingPids:tree.knownPids(),verified:false,note:'Terminal process inventory failed.'};}finally{if(bound)clearTimeout(bound);}}
     const rootStopped=!this.child.pid||this.child.exitCode!==null||this.child.signalCode!==null;
     if(!rootStopped&&this.child.pid)this.record.processCleanup={trackedPids:this.record.processCleanup?.trackedPids??[],remainingPids:[...new Set([...(this.record.processCleanup?.remainingPids??[]),this.child.pid])],verified:false,note:'Terminal root exit is unconfirmed.'};
     this.record.childCleanedUp=rootStopped&&(this.record.processCleanup?.remainingPids.length??0)===0;
     this.record.status=status;this.record.finishedAt=new Date().toISOString();this.child.stdout?.destroy();this.child.stderr?.destroy();this.child.unref();activity();resolve();
    })();
   };
   this.child.once('error',error=>{append(error.message);this.finish('spawn_failed');});
   this.child.once('close',(code,sig)=>{this.record.exitCode=code;this.record.signal=sig;this.finish(this.stopReason??'completed');});
   this.child.once('exit',(code,sig)=>{this.record.exitCode=code;this.record.signal=sig;drainTimer=setTimeout(()=>this.finish(this.stopReason??'completed'),250);});
  });
  timer=setTimeout(()=>{void this.stop('deadline_exceeded');},Math.max(1,deadline-Date.now()));
  signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
 }
 async stop(reason='killed'){
  if(this.stopping)return this.stopping;if(this.record.status!=='running')return;this.stopReason??=reason;
  this.stopping=(async()=>{let bound:NodeJS.Timeout|undefined;try{await Promise.race([terminateProcess(this.child).catch(()=>false),new Promise<void>(resolve=>{bound=setTimeout(resolve,7000);})]);}finally{if(bound)clearTimeout(bound);this.record.exitCode=this.child.exitCode;this.record.signal=this.child.signalCode;this.finish(this.stopReason!);}await this.done;})();return this.stopping;
 }
 exitStatus(){return {...(this.record.exitCode!==null?{exitCode:this.record.exitCode}:{}),...(this.record.signal?{signal:this.record.signal}:{})};}
 output(){return {output:this.record.output,truncated:this.record.truncated,...(this.record.status==='running'?{}:{exitStatus:this.exitStatus()})};}
}
