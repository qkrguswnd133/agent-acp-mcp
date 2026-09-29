import path from 'node:path';
import {home,resolveExecutable,type LaunchCommand} from './process.js';
import {officialNpmLaunch as officialPackageLaunch,resolveNpmLaunch,type NpmLaunchOptions,type OfficialNpmPackage} from './npm-launch.js';
export {findNodeRuntime,type NodeRuntime} from './npm-launch.js';

export const officialClaudePackage='@anthropic-ai/claude-code';
export const claudeNpmPackage:OfficialNpmPackage={name:officialClaudePackage,binNames:['claude','claude-code'],label:'Claude',defaultMinimumNode:22};

export interface ClaudeLaunchOptions extends NpmLaunchOptions {
  explicit?:string;
  candidates?:string[];
  names?:string[];
}

export function defaultClaudeCandidates(platform:NodeJS.Platform=process.platform){
  return [
    path.join(home,'.local','bin',platform==='win32'?'claude.exe':'claude'),
    path.join(home,'AppData','Local','Programs','Claude','claude.exe')
  ];
}

/** Explicit CLAUDE_CLI, then native installs, then PATH. An official npm
 * batch shim is replaced by the package's own bin so no cmd.exe is involved;
 * any other launcher is returned unchanged. */
export async function resolveClaudeLaunch(options:ClaudeLaunchOptions={}):Promise<LaunchCommand|undefined>{
  const platform=options.platform??process.platform;
  const selected=await resolveExecutable(options.explicit,options.names??['claude'],options.candidates??defaultClaudeCandidates(platform));
  return selected&&await resolveNpmLaunch(selected,claudeNpmPackage,options);
}

/** Returns undefined when the shim is not beside the official package. */
export async function officialNpmLaunch(shim:string,options:NpmLaunchOptions={}):Promise<LaunchCommand|undefined>{
  return officialPackageLaunch(shim,claudeNpmPackage,options);
}
