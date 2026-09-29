import {createHash} from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {home,runCommand,safeChildEnv,type LaunchCommand} from './process.js';

/** Scope rotated-token telemetry to the account AND organization reported by the CLI. */
export function claudeUsageAccountKey(auth:unknown):string|undefined {
  if(!auth||typeof auth!=='object')return undefined;
  const value=auth as Record<string,unknown>;
  if(value.loggedIn!==true&&value.authenticated!==true)return undefined;
  if(typeof value.email!=='string'||!value.email.trim()||typeof value.orgId!=='string'||!value.orgId.trim())return undefined;
  const directory=path.resolve(process.env.CLAUDE_CONFIG_DIR??path.join(home,'.claude'));
  return createHash('sha256').update(JSON.stringify([directory,value.email.trim().toLowerCase(),value.orgId.trim()])).digest('hex');
}

/** Best-effort official CLI initialization; never send a user/model prompt.
 * The CLI owns refresh-token rotation and its credential lock. Initialization
 * is NOT proof of renewal: ClaudeUsageReader rereads credentials and queries usage.
 */
export async function refreshClaudeCredentials(command:LaunchCommand,expectedAccountKey?:string,run:typeof runCommand=runCommand):Promise<void> {
  const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'agent-claude-auth-'));
  const env=safeChildEnv({DISABLE_AUTOUPDATER:'1',CLAUDE_CODE_SAFE_MODE:'1'});
  try {
    const requestId='usage-auth-initialize';
    const result=await run(command,['-p','--input-format','stream-json','--output-format','stream-json','--verbose',
      '--no-session-persistence','--safe-mode','--setting-sources=','--tools=',
      '--strict-mcp-config','--mcp-config','{"mcpServers":{}}'],{
      cwd,env,timeoutMs:25_000,
      stdin:JSON.stringify({type:'control_request',request_id:requestId,request:{subtype:'initialize',hooks:{}}})+'\n'
    });
    const initialized=result.stdout.split(/\r?\n/).some(line=>{
      try{const value=JSON.parse(line);return value.type==='control_response'&&value.response?.request_id===requestId&&value.response?.subtype==='success';}catch{return false;}
    });
    if(result.code!==0||result.timedOut||!initialized)throw Error('Official Claude authentication initialization did not complete.');
    if(expectedAccountKey){
      const status=await run(command,['auth','status','--json'],{cwd,env,timeoutMs:10_000});
      let account:unknown;try{account=JSON.parse(status.stdout);}catch{}
      if(status.code!==0||status.timedOut||claudeUsageAccountKey(account)!==expectedAccountKey)
        throw Error('Claude authentication account could not be confirmed after initialization.');
    }
  }finally{await fs.rm(cwd,{recursive:true,force:true}).catch(()=>undefined);}
}
