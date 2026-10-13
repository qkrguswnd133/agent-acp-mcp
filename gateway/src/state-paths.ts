import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface StatePathOptions {platform?:NodeJS.Platform;env?:NodeJS.ProcessEnv;home?:string;}
/** Native Linux and WSL deliberately share one layout. Windows keeps its legacy layout. */
export function userStateDirectory(options:StatePathOptions={}):string {
  const platform=options.platform??process.platform,env=options.env??process.env;
  const home=options.home??(platform==='win32'?(env.USERPROFILE??env.HOME??os.homedir()):(env.HOME??os.homedir()));
  const paths=platform==='win32'?path.win32:path.posix;
  if(env.AGENT_MCP_STATE_DIR){
    if(platform==='linux'&&!paths.isAbsolute(env.AGENT_MCP_STATE_DIR))throw Error('AGENT_MCP_STATE_DIR must be an absolute Linux path');
    return env.AGENT_MCP_STATE_DIR;
  }
  if(platform==='linux')return paths.join(env.XDG_STATE_HOME&&paths.isAbsolute(env.XDG_STATE_HOME)?env.XDG_STATE_HOME:paths.join(home,'.local','state'),'agent-acp-mcp');
  return paths.join(home,'.agent-acp-mcp');
}
export function installationStateDirectory(installRoot:string,options:StatePathOptions={}):string {
  const platform=options.platform??process.platform;
  if(platform!=='linux')return (platform==='win32'?path.win32:path).join(installRoot,'state');
  const env=options.env??process.env;
  if(env.AGENT_MCP_STATE_DIR)return userStateDirectory(options);
  try{
    const saved=JSON.parse(fs.readFileSync(path.join(installRoot,'agent-acp-installation.json'),'utf8'));
    if(saved?.schemaVersion!==1||typeof saved.stateRoot!=='string'||!path.posix.isAbsolute(saved.stateRoot))throw Error('Invalid Linux installation state location');
    return saved.stateRoot;
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  return userStateDirectory(options);
}

/** Never silently hide legacy job/session data on the first Linux upgrade. The
 * installer moves it into external state after an idle, backed-up migration. */
export function assertLinuxStateMigrated(installRoot:string,stateRoot:string,platform:NodeJS.Platform=process.platform):void {
  if(platform!=='linux')return;
  const legacy=path.join(installRoot,'state');
  if(path.resolve(legacy)===path.resolve(stateRoot))throw Error('Linux AGENT_MCP_STATE_DIR must be outside the Gateway installation; run the Linux installer to migrate state safely');
  const relative=path.relative(path.resolve(installRoot),path.resolve(stateRoot));
  if(relative!==''&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative))throw Error('Linux AGENT_MCP_STATE_DIR must be outside the Gateway installation');
  let entries:string[];
  try{entries=fs.readdirSync(legacy);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  if(entries.length)throw Error(`LEGACY_STATE_MIGRATION_REQUIRED: ${legacy} contains existing records. Run the Linux installer/update migration before starting this Gateway; preserve and migrate these records into ${stateRoot}.`);
}
