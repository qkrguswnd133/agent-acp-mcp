import {spawn} from 'node:child_process';
import readline from 'node:readline';
import {commandInvocation,safeChildEnv,terminateProcess} from './process.js';

export async function readCodexRateLimits(executable:string):Promise<any>{return readCodexState(executable,false);}
export async function readCodexStatus(executable:string):Promise<any>{return readCodexState(executable,true);}
async function readCodexState(executable:string,includeAccount:boolean):Promise<any>{
  const invocation=commandInvocation(executable,['app-server']);
  const batch=process.platform==='win32'&&/\.(cmd|bat)$/i.test(executable);if(batch)invocation.args[3]='"'+invocation.args[3]+'"';
  const p=spawn(invocation.command,invocation.args,{env:safeChildEnv(),windowsHide:true,windowsVerbatimArguments:batch,stdio:['pipe','pipe','pipe']});
  p.stderr.on('data',()=>{}); // diagnostics may contain account details
  const rl=readline.createInterface({input:p.stdout});
  let id=0;const pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void}>();
  rl.on('line',line=>{try{const msg=JSON.parse(line);if(typeof msg.id==='number'&&pending.has(msg.id)){const item=pending.get(msg.id)!;pending.delete(msg.id);if(msg.error)item.reject(Error(String(msg.error.message??JSON.stringify(msg.error))));else item.resolve(msg.result);}}catch{}});
  const request=(method:string,params:any={})=>new Promise<any>((resolve,reject)=>{const requestId=++id;pending.set(requestId,{resolve,reject});p.stdin.write(JSON.stringify({method,id:requestId,params})+'\n');});
  const timer=setTimeout(()=>{for(const item of pending.values())item.reject(Error('Codex app-server request timed out'));pending.clear();void terminateProcess(p);},15000);
  try{
    await request('initialize',{clientInfo:{name:'agent-acp-mcp',title:'Agent ACP MCP',version:'2.0.0'},capabilities:{experimentalApi:true}});
    p.stdin.write(JSON.stringify({method:'initialized'})+'\n');
    if(!includeAccount)return await request('account/rateLimits/read',{});
    const [limits,account]=await Promise.allSettled([request('account/rateLimits/read',{}),request('account/read',{refreshToken:false})]);
    return {limits:limits.status==='fulfilled'?limits.value:null,account:account.status==='fulfilled'?account.value:null};
  }catch(e){throw Error(`Codex app-server request failed: ${(e as Error).message}`);}
  finally{clearTimeout(timer);rl.close();p.stdin.end();await terminateProcess(p);}
}
