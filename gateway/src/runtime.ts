import type {ChildProcess} from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {home,isBatchCommand,providerChildEnv,terminateProcess,type LaunchCommand} from './process.js';
import {resolveNpmLaunch,type NpmLaunchOptions,type OfficialNpmPackage} from './npm-launch.js';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export const executable = process.env.GROK_CLI || path.join(home,'.grok','bin',process.platform==='win32'?'grok.exe':'grok');
/** @xai-official/grok's bin/grok is an extensionless node script that runs ~/.grok/bin/grok. */
export const grokNpmPackage:OfficialNpmPackage={name:'@xai-official/grok',binNames:['grok'],label:'Grok',defaultMinimumNode:20};
/** A native GROK_CLI (or the default) is used directly; an official npm
 * shim is replaced by its package bin; any other batch launcher is kept and
 * refused later for UNC working directories. */
export async function resolveGrokLaunch(configured=executable,options:NpmLaunchOptions={}):Promise<LaunchCommand>{return resolveNpmLaunch(configured,grokNpmPackage,options);}
let cachedLaunch:Promise<LaunchCommand>|undefined;
// ACP runs, health, billing, usage and update share one resolved launcher.
export function grokLaunch():Promise<LaunchCommand>{
  const pending=cachedLaunch??=resolveGrokLaunch();
  pending.catch(()=>{if(cachedLaunch===pending)cachedLaunch=undefined;});
  return pending;
}
export function resetGrokLaunch(){cachedLaunch=undefined;}
/** npm can update its package or the canonical binary without touching the shim. */
export async function grokLaunchFingerprint(configured=executable,canonical=path.join(home,'.grok','bin',process.platform==='win32'?'grok.exe':'grok')):Promise<string>{
  const configuredStat=await fs.stat(configured);
  const entries=[`${configured}:${configuredStat.size}:${configuredStat.mtimeMs}`];
  if(isBatchCommand(configured)){
    const packageRoot=path.join(path.dirname(configured),'node_modules','@xai-official','grok');
    for(const file of [path.join(packageRoot,'package.json'),path.join(packageRoot,'bin','grok'),path.join(packageRoot,'bin','grok-bootstrap.js'),canonical]){
      try{const stat=await fs.stat(file);entries.push(`${file}:${stat.size}:${stat.mtimeMs}`);}catch{entries.push(`${file}:missing`);}
    }
  }
  return JSON.stringify(entries);
}
export const childEnv:NodeJS.ProcessEnv = providerChildEnv({GROK_DISABLE_AUTOUPDATER:'1',GROK_SUBAGENTS:'0'});
export const acpArgs = ['agent','--no-leader','--model','grok-4.6','--effort','xhigh'];
export const active = new Set<ChildProcess>();
export const terminate=terminateProcess;
export let shuttingDown=false;
export async function shutdown() { shuttingDown=true;await Promise.all([...active].map(terminate)); }
