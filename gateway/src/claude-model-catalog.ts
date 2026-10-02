import {spawn} from 'node:child_process';
import readline from 'node:readline';
import {randomUUID} from 'node:crypto';
import {providerChildEnv,spawnPlan,terminateProcess,type LaunchCommand} from './process.js';
/** Official SDK control handshake only. Never sends a user message or model prompt. */
export async function readClaudeModels(executable:LaunchCommand):Promise<any>{
 const args=['--print','--input-format','stream-json','--output-format','stream-json','--verbose','--no-session-persistence','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--tools','','--settings','{"disableAllHooks":true}'];
 const invocation=spawnPlan(executable,args);
 const p=spawn(invocation.command,invocation.args,{env:providerChildEnv({DISABLE_AUTOUPDATER:'1'}),windowsHide:true,windowsVerbatimArguments:invocation.windowsVerbatimArguments,shell:false,stdio:['pipe','pipe','pipe']});
 p.stderr.on('data',()=>{});const lines=readline.createInterface({input:p.stdout});const id=randomUUID();
 let timer:NodeJS.Timeout|undefined;
 try{return await new Promise((resolve,reject)=>{
  timer=setTimeout(()=>reject(Error('Claude control initialize timed out')),15000);
  p.on('error',reject);p.on('exit',()=>reject(Error('Claude exited before control initialize response')));p.stdin.on('error',reject);
  lines.on('line',line=>{try{const event=JSON.parse(line);if(event.type==='control_response'&&event.response?.request_id===id){if(event.response.subtype==='error')reject(Error(String(event.response.error??'Claude initialize rejected')));else resolve(event.response.response);}}catch{}});
  p.stdin.write(JSON.stringify({type:'control_request',request_id:id,request:{subtype:'initialize',hooks:{}}})+'\n');
 });}finally{if(timer)clearTimeout(timer);lines.close();p.stdin.end();await terminateProcess(p);}
}
