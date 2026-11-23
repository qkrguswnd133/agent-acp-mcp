import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {processIdentityAsync} from './process-identity.js';
import type {ProviderName} from './types.js';

// The registry intentionally captures only executable selection, never arbitrary MCP env.
const pathKeys = ['PATH','GROK_CLI','CLAUDE_CLI','CODEX_CLI','CODEX_CLI_PATH'] as const;
type Paths = Partial<Record<typeof pathKeys[number], string>>;
export function cliHostPaths(env: NodeJS.ProcessEnv): Paths {
  return Object.fromEntries(pathKeys.flatMap(key => typeof env[key]==='string' ? [[key,env[key]]] : []));
}
const providers: ProviderName[] = ['grok','claude','codex'];
const equivalent = (value: string) => process.platform==='win32' ? value.toLowerCase() : value;

async function optionalFile(file:string):Promise<string|undefined> {
  try{return await fs.readFile(file,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
}
export async function savedCliConfiguration(env=process.env,platform=process.platform):Promise<Paths[]> {
  const home=(platform==='win32'?env.USERPROFILE:env.HOME)||os.homedir(), settings:Paths[]=[];
  const toml=await optionalFile(path.join(env.CODEX_HOME||path.join(home,'.codex'),'config.toml'));
  if(toml){
    let inside=false,registered=false;const values:Paths={};
    for(const line of toml.split(/\r?\n/)){
      if(/^\s*\[/.test(line)){
        inside=/^\s*\[mcp_servers\.(?:agent|"agent")\.env\]\s*(?:#.*)?$/.test(line);
        registered||=inside||/^\s*\[mcp_servers\.(?:agent|"agent")\]\s*(?:#.*)?$/.test(line);continue;
      }
      if(!inside)continue;
      const key=line.match(/^\s*(GROK_CLI|CLAUDE_CLI|CODEX_CLI|CODEX_CLI_PATH|PATH)\s*=\s*(.*)$/);
      if(key){
        const quoted=key[2].match(/^("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/);
        if(!quoted)throw Error('Unsupported MCP path setting. Reconnect the Gateway to read its active configuration.');
        values[key[1] as keyof Paths]=quoted[1][0]==='"'?JSON.parse(quoted[1]):quoted[1].slice(1,-1);
      }
    }
    if(registered)settings.push(values);
  }
  const files=[path.join(home,'.claude.json')];
  if(platform==='win32'){
    if(env.APPDATA)files.push(path.join(env.APPDATA,'Claude','claude_desktop_config.json'));
    if(env.LOCALAPPDATA){
      const packages=path.join(env.LOCALAPPDATA,'Packages');
      let names:string[]=[];
      try{names=await fs.readdir(packages);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      for(const n of names.filter(n=>/^Claude_[a-z\d]+$/i.test(n)))files.push(path.join(packages,n,'LocalCache','Roaming','Claude','claude_desktop_config.json'));
    }
  }
  for(const file of files){
    const claude=await optionalFile(file);
    if(!claude)continue;
    const config=JSON.parse(claude);
    for(const scope of [config,...Object.values(config.projects??{})] as {mcpServers?:{agent?:{env?:NodeJS.ProcessEnv}}}[]){
      if(scope?.mcpServers?.agent)settings.push(cliHostPaths(scope.mcpServers.agent.env??{}));
    }
  }
  return settings;
}

/** Resolve one context for this short-lived updater process before loading any
 * Gateway modules that memoize their configured executable. Incompatible live
 * host choices are returned as manual rows, never resolved by choosing first. */
export async function loadCliEnvironment(installRoot:string,stateRoot:string):Promise<Set<ProviderName>> {
  const folder=path.join(stateRoot,'gateways');let names:string[]=[];
  try{names=await fs.readdir(folder);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const live=await Promise.all(names.filter(n=>/^\d+\.json$/.test(n)).map(async n=>{
    const raw=await optionalFile(path.join(folder,n));if(!raw)return null;
    const record=JSON.parse(raw);
    if(record.installRoot!==installRoot||record.pid!==Number.parseInt(n,10))return null;
    let alive=true;
    try{process.kill(record.pid,0);}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')alive=false;else throw e;}
    if(!alive)return null;
    const identity=await processIdentityAsync(record.pid);
    if(!identity||!record.startIdentity)throw Error('Cannot verify the active Gateway installation. Reconnect MCP and retry.');
    if(identity!==record.startIdentity)return null;
    if(!record.cliPaths||typeof record.cliPaths!=='object'||Array.isArray(record.cliPaths)||typeof record.cliPaths.PATH!=='string'||pathKeys.some(key=>key in record.cliPaths&&typeof record.cliPaths[key]!=='string'))throw Error('Reconnect MCP to register CLI paths with the updated Gateway.');
    return cliHostPaths(record.cliPaths);
  }));
  const hosts=live.filter((v):v is Paths=>!!v);
  const offline=hosts.length===0;
  const current=cliHostPaths(process.env);
  if(offline){
    for(const configured of await savedCliConfiguration())hosts.push({...current,...configured});
  }
  if(!hosts.length)return new Set();
  const conflicts=new Set<ProviderName>();
  for(const provider of providers){
    const key=(provider.toUpperCase()+'_CLI') as keyof Paths;
    const contexts=hosts.map(env=>({executable:env[key]??(provider==='codex'?env.CODEX_CLI_PATH:undefined),path:env.PATH??(offline?current.PATH:undefined)}));
    const target=contexts[0];
    if(contexts.some(c=>equivalent(c.executable??'')!==equivalent(target.executable??'')||(!target.executable&&equivalent(c.path??'')!==equivalent(target.path??'')))||
       (target.executable&&!path.isAbsolute(target.executable))){
      conflicts.add(provider);continue;
    }
    if(target.executable!==undefined)process.env[key]=target.executable;else delete process.env[key];
    if(provider==='codex')delete process.env.CODEX_CLI_PATH;
    if(target.path!==undefined)process.env.PATH=target.path;
  }
  return conflicts;
}
