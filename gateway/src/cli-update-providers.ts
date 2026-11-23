import path from 'node:path';
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {home, resolveExecutable, safeChildEnv, launchInvocation, type LaunchCommand} from './process.js';
import {findNodeRuntime, resolveNpmLaunch} from './npm-launch.js';
import {resolveClaudeExecutable, claudeNpmPackage} from './claude-launch.js';
import {resolveCodexExecutable, codexNpmPackage} from './providers/codex.js';
import {grokNpmPackage, executable as grokExecutable} from './runtime.js';
import type {ProviderName} from './types.js';

const packages={claude:claudeNpmPackage,codex:codexNpmPackage,grok:grokNpmPackage};
const execute=promisify(execFile);
const windows=process.platform==='win32';
const binary=(name:string)=>windows?name+'.exe':name;
const canonicalGrok=path.join(home,'.grok','bin',binary('grok'));
const versionPattern=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9a-z-]+(?:\.[0-9a-z-]+)*))?$/i;
const version=(value:unknown)=>typeof value==='string'&&value.length<=100&&versionPattern.test(value)?value:null;
const same=(lhs:string,rhs:string)=>path.relative(lhs,rhs)==='';
const contained=(file:string,dir:string)=>{const rel=path.relative(dir,file);return rel!==''&&!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel);};

type Method='npm'|'native'|'desktop'|'unknown';
export interface CliInspection{
 provider:ProviderName;currentVersion:string|null;latestVersion:string|null;path:string|null;method:Method;
 status:'available'|'current'|'manual'|'missing'|'error';message?:string;processPaths?:string[];
}
interface Target{
 path:string;real:string;launch:LaunchCommand;method:Method;processPaths:string[];
 prefix?:string;packageVersion?:string;npm?:LaunchCommand;packageRoot?:string;
}
type Runner=(launch:LaunchCommand,args:string[],install?:boolean)=>Promise<string>;
interface Dependencies{
 resolve:(provider:ProviderName)=>Promise<Target|null>;
 run:Runner;
 metadata:(url:string)=>Promise<string>;
}
async function command(launch:LaunchCommand,args:string[],install=false){
 const call=launchInvocation(launch,args);
 // Only executables (or Node + a verified package entry) may be launched.
 if(windows&&!/\.exe$/i.test(call.command))throw Error('실행 가능한 공식 CLI 경로를 확인할 수 없습니다.');
 const env=safeChildEnv(install?{CI:'1',CODEX_NON_INTERACTIVE:'true'}:{CI:'1',DISABLE_AUTOUPDATER:'1',GROK_DISABLE_AUTOUPDATER:'1'});
 const child=execute(call.command,call.args,{cwd:home,env,windowsHide:true,timeout:install?300000:15000,maxBuffer:1024*1024,encoding:'utf8'});
 child.child.stdin?.end();
 return (await child).stdout.trim();
}
async function fileJson(file:string){return JSON.parse(await fs.readFile(file,'utf8'));}
async function present(file:string){try{return (await fs.stat(file)).isFile();}catch{return false;}}
async function npmLaunch(prefix:string):Promise<LaunchCommand|undefined>{
 const found=await resolveExecutable(undefined,['npm']);
 if(!found)return;
 const entries=windows?[path.join(path.dirname(found),'node_modules','npm','bin','npm-cli.js'),
   path.join(path.dirname(process.execPath),'node_modules','npm','bin','npm-cli.js')]:[await fs.realpath(found)];
 for(const entry of entries){
   const manifest=await fileJson(path.join(path.dirname(entry),'..','package.json')).catch(()=>null);
   if(path.basename(entry)!=='npm-cli.js'||manifest?.name!=='npm'||!await present(entry))continue;
   const node=await findNodeRuntime([18,0,0],windows?prefix:path.join(prefix,'bin'));
   if(node)return {command:node,argsPrefix:[entry]};
 }
}
async function npmTarget(provider:ProviderName,selected:string,real:string,launch:LaunchCommand):Promise<Target|null>{
 const pkg=packages[provider],binName=path.basename(selected).replace(/\.(cmd|bat)$/i,'');
 if(!pkg.binNames.includes(binName))return null;
 const binDir=path.dirname(selected);
 if(!windows&&path.basename(binDir)!=='bin')return null;
 const prefix=windows?binDir:path.dirname(binDir),root=path.join(prefix,windows?'':'lib','node_modules',pkg.name);
 const manifest=await fileJson(path.join(root,'package.json')).catch(()=>null);
 const bin=typeof manifest?.bin==='string'?manifest.bin:manifest?.bin?.[binName];
 if(manifest?.name!==pkg.name||!version(manifest.version)||typeof bin!=='string')return null;
 const entry=path.resolve(root,bin);
 if(!contained(entry,root)||!await present(entry))return null;
 const realEntry=await fs.realpath(entry);
 const realRoot=await fs.realpath(root);
 // Refuse linked development checkouts and wrappers copied next to a global package.
 if(!same(realRoot,path.join(await fs.realpath(prefix),windows?'':'lib','node_modules',pkg.name)))return null;
 // Platform-specific packages may provide a native bin through a symlink.
 // An arbitrary external symlink is not evidence of package ownership.
 if(!contained(realEntry,realRoot)){
   const modules=path.dirname(path.dirname(realRoot));
   const platformPackage=path.join(modules,packages[provider].name+'-'+process.platform+'-'+process.arch);
   if(!contained(realEntry,platformPackage)&&!(provider==='grok'&&(same(realEntry,canonicalGrok)||contained(realEntry,path.dirname(canonicalGrok)))))return null;
 }
 const invocation=launchInvocation(launch,[]);
 const actual=windows?(invocation.args[0]??invocation.command):real;
 if(!same(await fs.realpath(actual),realEntry))return null;
 const processPaths=[selected,real,realRoot,realEntry];
 if(provider==='grok')processPaths.push(canonicalGrok,path.dirname(canonicalGrok));
 if(provider==='codex'){
   for(const base of [path.join(root,'node_modules','@openai'),path.resolve(root,'..')]){
     for(const name of await fs.readdir(base).catch(()=>[] as string[]))if(/^codex-(?:win32|linux)-/.test(name))processPaths.push(path.join(base,name));
   }
 }
 return {path:selected,real,launch,method:'npm',prefix,packageVersion:manifest.version,packageRoot:realRoot,npm:await npmLaunch(prefix),processPaths};
}
async function resolveTarget(provider:ProviderName):Promise<Target|null>{
 const selected=provider==='codex'?await resolveCodexExecutable():provider==='claude'?await resolveClaudeExecutable({explicit:process.env.CLAUDE_CLI}):grokExecutable;
 if(!selected||!await present(selected))return null;
 const chosen=path.resolve(selected),real=await fs.realpath(chosen),launch=await resolveNpmLaunch(chosen,packages[provider]);
 const base={path:chosen,real,launch,processPaths:[chosen,real]};
 if(windows&&[chosen,real].some(p=>p.toLowerCase().includes('\\windowsapps\\')))return {...base,method:'desktop'};
 const npm=await npmTarget(provider,chosen,real,launch);
 if(npm)return npm;
 if(provider==='codex'){
   const root=path.join(process.env.CODEX_HOME||path.join(home,'.codex'),'packages','standalone');
   const entry=path.join(root,'current','bin',binary('codex'));
   const manifest=await fileJson(path.join(root,'current','codex-package.json')).catch(()=>null);
   if(manifest?.variant==='codex'&&version(manifest.version)&&same(await fs.realpath(entry).catch(()=>entry),real)&&!contained(chosen,path.join(root,'releases'))){
     // A surviving exec-server or code-mode-host can keep this release in use.
     return {...base,method:'native',processPaths:[...base.processPaths,path.dirname(real)]};
   }
 }else if(provider==='claude'){
   const canonical=path.join(home,'.local','bin',binary('claude'));
   if(same(chosen,canonical)&&(same(chosen,real)||contained(real,path.join(home,'.local','share','claude','versions'))))return {...base,method:'native'};
 }else if(same(chosen,canonicalGrok)&&(same(chosen,real)||contained(real,path.dirname(canonicalGrok)))){
   return {...base,method:'native',processPaths:[...base.processPaths,path.dirname(canonicalGrok)]};
 }
 return {...base,method:'unknown'};
}
// The Grok npm launcher starts the canonical ~/.grok/bin/grok. The Gateway
// can point straight to that binary. Only adopt a package when exactly one
// installed npm prefix on PATH accounts for that same version and target.
async function canonicalGrokPackage(target:Target,current:string):Promise<Target|null>{
 if(!same(target.path,canonicalGrok))return null;
 const directories=(process.env.PATH??'').split(path.delimiter).filter(dir=>path.isAbsolute(dir));
 const owners=new Map<string,Target>();
 for(const dir of directories){
   const selected=path.join(dir,windows?'grok.cmd':'grok');
   if(!await present(selected))continue;
   const launch=await resolveNpmLaunch(selected,grokNpmPackage);
   const npm=await npmTarget('grok',selected,await fs.realpath(selected),launch);
   if(npm?.prefix)owners.set(npm.prefix,npm);
 }
 const [owner]=owners.values();
 if(owners.size!==1||owner.packageVersion!==current)return null;
 return {...owner,path:target.path,real:target.real,launch:target.launch,processPaths:[...owner.processPaths,...target.processPaths]};
}
async function metadata(url:string){
 const r=await fetch(url,{signal:AbortSignal.timeout(10000),redirect:'error'});
 if(!r.ok)throw Error('공식 배포 정보를 조회할 수 없습니다.');
 return r.text();
}
async function claudeChannel():Promise<string>{
 const settings=path.join(process.env.CLAUDE_CONFIG_DIR||path.join(home,'.claude'),'settings.json');
 const managed=windows?path.join(process.env.ProgramFiles??'C:/Program Files','ClaudeCode','managed-settings.json'):'/etc/claude-code/managed-settings.json';
 const read=async(file:string)=>{try{return (await fileJson(file))?.autoUpdatesChannel;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}};
 return await read(managed)??await read(settings)??'latest';
}
function fromOutput(provider:ProviderName,output:string){
 const prefix={codex:'codex-cli\\s+',claude:'(?:Claude Code\\s+)?',grok:'(?:grok(?:-build)?\\s+)?'}[provider];
 const match=new RegExp('^'+prefix+'v?([0-9][0-9a-z.-]*)(?:\\s|$)','i').exec(output.trim());
 return version(match?.[1]);
}
function compare(a:string,b:string):number{
 const left=a.split('-',1)[0].split('.'),right=b.split('-',1)[0].split('.');
 const numeric=(x:string,y:string)=>BigInt(x)>BigInt(y)?1:BigInt(x)<BigInt(y)?-1:0;
 for(let i=0;i<3;i++){const d=numeric(left[i],right[i]);if(d)return d;}
 const pre=(v:string)=>v.includes('-')?v.slice(v.indexOf('-')+1).split('.'):null;
 const x=pre(a),y=pre(b);
 if(!x||!y)return x?-1:y?1:0;
 for(let i=0;i<Math.min(x.length,y.length);i++){
   if(x[i]===y[i])continue;
   const n=/^\d+$/.test(x[i]),m=/^\d+$/.test(y[i]);
   if(n&&m){const d=numeric(x[i],y[i]);if(d)return d;continue;}
   return n?-1:m?1:x[i]<y[i]?-1:1;
 }
 return x.length-y.length;
}
function parseCheck(json:string){
 const raw=JSON.parse(json);
 const current=version(raw?.currentVersion);
 const latest=raw?.updateAvailable===false&&raw?.latestVersion==null&&!raw?.error?current:version(raw?.latestVersion);
 return {channel:raw?.channel,installer:raw?.installer,current,latest,error:!!raw?.error};
}
export function sameCliInstallation(a:CliInspection,b:CliInspection){
 if(a.path!==b.path||a.method!==b.method)return false;
 const paths=(item:CliInspection)=>[...new Set(item.processPaths??[])].sort();
 const previous=paths(a),next=paths(b);
 return previous.length===next.length&&previous.every((p,i)=>p===next[i]);
}
async function writable(dir:string){return fs.access(dir,constants.W_OK).then(()=>true,()=>false);}
async function wouldBootstrapGrok(target:Target){
 if(target.method!=='npm'||await present(canonicalGrok))return false;
 if(typeof target.launch!=='string')return target.launch.source==='official_npm_node';
 // POSIX npm bins can be an executable Node script or a native symlink.
 const handle=await fs.open(target.real,'r');
 try{
   const header=Buffer.alloc(128);
   const {bytesRead}=await handle.read(header,0,header.length,0);
   return /^#![^\n]*\bnode\b/.test(header.toString('utf8',0,bytesRead));
 }finally{await handle.close();}
}
const defaults:Dependencies={resolve:resolveTarget,run:command,metadata};
export function createCliProviderUpdates(deps:Dependencies=defaults){
 async function prepare(provider:ProviderName){
   const row:CliInspection={provider,path:null,method:'unknown',currentVersion:null,latestVersion:null,status:'missing'};
   let target:Target|null=null,update:LaunchCommand|null=null,args:string[]=[];
   try{
     target=await deps.resolve(provider);
     if(!target)return {row,target,update,args};
     Object.assign(row,{path:target.path,method:target.method,processPaths:[...new Set(target.processPaths)]});
     const manual=(message:string)=>{row.status='manual';row.message=message;return {row,target,update:null,args:[] as string[]};};
     if(target.method==='unknown')return manual('이 설치 경로의 소유자를 확인할 수 없습니다. 설치에 사용한 도구로 업데이트하세요.');
     if(provider==='grok'&&await wouldBootstrapGrok(target)){
       return manual('Grok npm 실행기가 초기 설정을 완료하지 않았습니다. 터미널에서 Grok을 한 번 실행하세요.');
     }
     if(target.method==='desktop'){
       row.currentVersion=fromOutput(provider,await deps.run(target.launch,['--version']).catch(()=>''));
       return manual('Codex Desktop에서 앱을 업데이트하세요.');
     }
     row.currentVersion=fromOutput(provider,await deps.run(target.launch,['--version']));
     if(!row.currentVersion)return manual('CLI 버전을 확인할 수 없습니다. 설치에 사용한 도구로 업데이트하세요.');
     let channel=provider==='claude'?await claudeChannel():'latest',grokCheck:ReturnType<typeof parseCheck>|undefined;
     if(provider==='grok'){
       // Older CLI parsers could ignore unknown update flags. Check the read-only help first.
       const help=await deps.run(target.launch,['update','--help']);
       if(!help.includes('--check')||!help.includes('--json'))return manual('Grok 버전에서 읽기 전용 업데이트 조회를 지원하지 않습니다.');
       grokCheck=parseCheck(await deps.run(target.launch,['update','--check','--json']));
       if(grokCheck.current!==row.currentVersion||!['stable','alpha'].includes(grokCheck.channel))return manual('Grok 설치 채널을 확인할 수 없습니다.');
       channel=grokCheck.channel==='stable'?'latest':'alpha';
       if(target.method==='native'&&grokCheck.installer==='npm'){
         const owner=await canonicalGrokPackage(target,row.currentVersion);
         if(!owner)return manual('Grok npm 설치 위치를 특정할 수 없습니다. 설치한 npm prefix에서 업데이트하세요.');
         target=owner;row.method=owner.method;row.processPaths=[...new Set(owner.processPaths)];
       }
     }else if(row.currentVersion.includes('-'))return manual('시험판을 설치한 채널에서 직접 업데이트하세요.');
     if(!['stable','latest','alpha'].includes(channel))return manual('설치한 릴리스 채널을 확인할 수 없습니다.');
     if(target.method==='npm'){
       if(!target.prefix||!target.packageRoot||!target.npm||target.packageVersion!==row.currentVersion)return manual('npm 설치 정보와 실행 버전을 확인한 뒤 같은 prefix에서 업데이트하세요.');
       if(!await writable(target.packageRoot)||!await writable(path.dirname(target.packageRoot)))return manual('npm 설치 폴더에 쓰기 권한이 필요합니다. 설치 관리자에서 업데이트하세요.');
       const pkg=packages[provider].name,registry='https://registry.npmjs.org/';
       const tags=JSON.parse(await deps.metadata(registry+'-/package/'+encodeURIComponent(pkg)+'/dist-tags'));
       row.latestVersion=version(tags[channel]);
       update=target.npm;
       args=['install','--global','--prefix',target.prefix,'--registry',registry,'--'+pkg.split('/')[0]+':registry='+registry,'--no-audit','--no-fund',pkg+'@'+row.latestVersion];
     }else{
       if(!await writable(path.dirname(target.path)))return manual('CLI 설치 경로에 쓰기 권한이 필요합니다. 설치 관리자에서 업데이트하세요.');
       update=target.launch;
       if(provider==='grok'){
         if(!grokCheck||!['internal','native','standalone','script','binary'].includes(grokCheck.installer))return manual('Grok이 보고한 설치 관리자를 사용해 업데이트하세요.');
         if(grokCheck.error)throw Error();
         row.latestVersion=grokCheck.latest;
         args=['update','--version',row.latestVersion??''];
       }else{
         const help=await deps.run(target.launch,['--help']);
         if(!/^\s*update(?:\|upgrade)?\s+/mi.test(help))return manual('현재 CLI가 비대화형 update 명령을 제공하지 않습니다.');
         if(provider==='claude'){
           row.latestVersion=version((await deps.metadata('https://downloads.claude.ai/claude-code-releases/'+channel)).trim());
         }else{
           const tag=JSON.parse(await deps.metadata('https://releases.openai.com/codex/channels/latest')).tag_name;
           row.latestVersion=typeof tag==='string'?version(tag.replace(/^rust-v/,'')):null;
         }
         args=['update'];
       }
     }
     if(!row.latestVersion||channel!=='alpha'&&row.latestVersion.includes('-'))throw Error();
     row.status=compare(row.latestVersion,row.currentVersion)>0?'available':'current';
   }catch{row.status='error';row.message='버전 또는 공식 배포 정보를 확인할 수 없습니다. 다시 확인하세요.';}
   return {row,target,update,args};
 }
 async function inspectCli(provider:ProviderName):Promise<CliInspection>{return (await prepare(provider)).row;}
 async function applyCli(provider:ProviderName,inspected:CliInspection,onVerifying?:()=>Promise<void>):Promise<CliInspection>{
   const {row,target,update,args}=await prepare(provider);
   if(row.status==='current'&&inspected.status==='available')return {...row,status:'error',message:'설치 직전 대상 버전이 변경되었습니다. 다시 확인하세요.'};
   if(row.status!=='available'||!target||!update)return row;
   if(inspected.provider!==provider||inspected.status!=='available'||!sameCliInstallation(inspected,row)||inspected.currentVersion!==row.currentVersion||inspected.latestVersion!==row.latestVersion)
     return {...row,status:'error',message:'버전 또는 실행 경로가 변경되었습니다. 다시 확인하세요.'};
   try{
     await deps.run(update,args,true);
     await onVerifying?.();
     let after=await deps.resolve(provider);
     if(after&&provider==='grok'&&target.method==='npm'&&after.method==='native')after=await canonicalGrokPackage(after,row.latestVersion!);
     if(!after||!same(after.path,target.path)||after.method!==target.method||after.prefix!==target.prefix)
       return {...row,status:'error',message:'업데이트 후 Gateway 실행 경로가 변경되었습니다. 설치 경로를 확인하세요.'};
     const actual=fromOutput(provider,await deps.run(after.launch,['--version']));
     if(actual!==row.latestVersion)return {...row,currentVersion:actual,status:'error',message:'Gateway 실행 파일의 버전이 업데이트 대상과 일치하지 않습니다.'};
     return {...row,currentVersion:actual,status:'current',message:'업데이트 후 Gateway 실행 버전을 확인했습니다.'};
   }catch(error){
     const raw=error as {code?:string;stderr?:string};
     const needsTerminal=['EACCES','EPERM'].includes(raw?.code??'')||/\b(EACCES|EPERM|sudo|requires? (?:an? )?(?:tty|terminal)|interactive terminal|not a terminal|permission denied)\b/i.test(String(raw?.stderr??''));
     return {...row,currentVersion:null,status:needsTerminal?'manual':'error',message:needsTerminal?'설치 관리자 권한 또는 대화형 터미널에서 이 CLI를 업데이트하세요.':'CLI 업데이트 결과를 확인할 수 없습니다. 다시 확인하세요.'};
   }
 }
 return {inspectCli,applyCli};
}
export const {inspectCli,applyCli}=createCliProviderUpdates();
