import path from 'node:path';
import os from 'node:os';

/** Reuse the user's effective cache. Never create or remove task-specific Gradle homes. */
export interface GradleEnvironment {
 userHome:string;
 source:'environment'|'user_default';
 readOnlyDependencyCache?:string;
 env:NodeJS.ProcessEnv;
}
export function gradleEnvironment(cwd:string,options:{env?:NodeJS.ProcessEnv;home?:string;platform?:NodeJS.Platform}={}):GradleEnvironment {
 const env=options.env??process.env,platform=options.platform??process.platform,p=platform==='win32'?path.win32:path.posix;
 const home=options.home??(platform==='win32'?(env.USERPROFILE??env.HOME??os.homedir()):(env.HOME??os.homedir()));
 const configured=env.GRADLE_USER_HOME;
 const userHome=configured?p.resolve(cwd,configured):p.join(home,'.gradle');
 const readOnlyDependencyCache=env.GRADLE_RO_DEP_CACHE?p.resolve(cwd,env.GRADLE_RO_DEP_CACHE):undefined;
 return {userHome,source:configured?'environment':'user_default',...(readOnlyDependencyCache?{readOnlyDependencyCache}:{}),env:{GRADLE_USER_HOME:userHome,...(readOnlyDependencyCache?{GRADLE_RO_DEP_CACHE:readOnlyDependencyCache}:{})}};
}
interface CommandEvidence {command?:string;output?:string|null;source?:string;}
export interface DownloadObservation {target:string;event:'download_started'|'download_reported_complete';source:string;}
/** Only actual command output is evidence; assistant prose is deliberately not accepted. */
export function observedCommandDownloads(commands:CommandEvidence[]=[]){
 const targets:DownloadObservation[]=[],seen=new Set<string>();let evidenceCount=0;
 for(const command of commands){
  if(typeof command.output!=='string')continue;
  for(const line of command.output.split(/\r?\n/)){
   const match=/^(?:\s|\[[^\]\r\n]{1,40}\])*?(Downloading|Downloaded)(?:\s+from\s+[^:]+:)?\s+(https?:\/\/[^\s<>"']+)/i.exec(line);
   if(!match)continue;
   let target:string;try{const url=new URL(match[2].replace(/[),;]+$/,''));target=url.origin+url.pathname;}catch{continue;}
   const event=/^Downloaded$/i.test(match[1])?'download_reported_complete' as const:'download_started' as const;
   const key=event+':'+target;if(seen.has(key))continue;seen.add(key);evidenceCount++;
   if(targets.length<50)targets.push({target,event,source:command.source??'command_output'});
  }
 }
 return {status:targets.length?'observed' as const:'not_observed' as const,coverage:'available_command_output_only' as const,networkEnforced:false,targets,truncated:evidenceCount>targets.length,warning:targets.length?'Command output reported external download activity. Review the target list; no additional download was started by this telemetry.':'No download evidence was present in available command output. This does not establish that no network activity occurred.'};
}
export function gradleTelemetry(environment:GradleEnvironment,commands:CommandEvidence[]=[]){
 return {
  policy:'reuse_user_cache' as const,userHome:environment.userHome,source:environment.source,readOnlyDependencyCache:environment.readOnlyDependencyCache??null,createdByGateway:false,perJobHome:false,
  daemonPolicy:'request_no_daemon' as const,networkEnforced:false,
  cleanup:{status:'not_needed' as const,removedBytes:0,removedPaths:[] as string[],reason:'No per-job Gradle home was created. Shared user cache is never deleted by Gateway cleanup.'},
  legacyHomes:{automaticCleanup:false,note:'Previously created job Gradle homes are preserved; review ownership and running daemons before manual cleanup.'},
  downloads:observedCommandDownloads(commands),
  note:'Existing wrappers and dependencies are reused when available. Missing cache entries may still cause Gradle network access; --no-daemon does not enforce offline mode. Parent must authorize required downloads. Shared cache locks and an existing user daemon may still affect execution.',
 };
}
