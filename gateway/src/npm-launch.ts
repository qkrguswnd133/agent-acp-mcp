import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {isBatchCommand,safeChildEnv,type LaunchCommand} from './process.js';

/** An official npm package whose global batch shim may be bypassed. */
export interface OfficialNpmPackage {
  /** Scoped npm package name, e.g. @openai/codex. */
  name:string;
  /** Shim basenames (without .cmd/.bat) that npm creates for this package. */
  binNames:string[];
  /** Provider label for error messages. */
  label:string;
  /** Node major used when engines.node has no parseable lower bound. */
  defaultMinimumNode:number;
}

export interface NodeRuntime {execPath:string;versions:NodeJS.ProcessVersions|Record<string,string|undefined>;}
export interface NpmLaunchOptions {
  platform?:NodeJS.Platform;
  /** Extra genuine Node candidates checked after the npm prefix. */
  nodeCandidates?:string[];
  /** Current runtime; Electron (even with ELECTRON_RUN_AS_NODE) is never used as Node. Null disables it. */
  currentRuntime?:NodeRuntime|null;
  /** Search PATH for node; disabled only by tests. */
  searchPath?:boolean;
}

/** An official npm batch shim is replaced by the package's own bin so no
 * cmd.exe is involved; any other launcher is returned unchanged. */
export async function resolveNpmLaunch(selected:string,pkg:OfficialNpmPackage,options:NpmLaunchOptions={}):Promise<LaunchCommand>{
  if(!isBatchCommand(selected,options.platform??process.platform))return selected;
  return await officialNpmLaunch(selected,pkg,options)??selected;
}

function inside(root:string,target:string){const relative=path.relative(root,target);return relative!==''&&!relative.startsWith('..')&&!path.isAbsolute(relative);}

/** npm bins such as @xai-official/grok's bin/grok are extensionless scripts
 * that npm itself runs through node because of their shebang. */
async function hasNodeShebang(file:string){
  let handle:fs.FileHandle|undefined;
  try{
    handle=await fs.open(file,'r');const buffer=Buffer.alloc(128);const {bytesRead}=await handle.read(buffer,0,buffer.length,0);
    const first=buffer.subarray(0,bytesRead).toString('utf8').split(/\r?\n/)[0];
    return /^#!\s*(?:\/usr\/bin\/env\s+(?:-S\s+)?)?(?:\S*\/)?node(?:\s|$)/.test(first);
  }catch{return false;}finally{await handle?.close();}
}

/** Returns undefined when the shim is not beside the official package. */
export async function officialNpmLaunch(shim:string,pkg:OfficialNpmPackage,options:NpmLaunchOptions={}):Promise<LaunchCommand|undefined>{
  const platform=options.platform??process.platform;
  const shimDirectory=path.dirname(shim),binName=path.basename(shim).replace(/\.(cmd|bat)$/i,'');
  // A custom wrapper beside npm's global node_modules is still user-selected;
  // do not substitute a different command just because the package is installed.
  if(!pkg.binNames.includes(binName))return undefined;
  const packageRoot=path.join(shimDirectory,'node_modules',...pkg.name.split('/'));
  let manifest:any;
  try{manifest=JSON.parse(await fs.readFile(path.join(packageRoot,'package.json'),'utf8'));}catch{return undefined;}
  if(manifest?.name!==pkg.name)return undefined;
  const refuse=(reason:string)=>Error(`Official ${pkg.label} npm package at ${packageRoot} has an unusable bin entry: ${reason}.`);
  // npm names a string bin after the unscoped package name.
  const bin=typeof manifest.bin==='string'&&binName===pkg.name.split('/').pop()?manifest.bin:manifest.bin&&typeof manifest.bin==='object'?manifest.bin[binName]:undefined;
  if(typeof bin!=='string'||!bin.trim())throw refuse(`no "${binName}" bin`);
  if(path.isAbsolute(bin)||path.win32.isAbsolute(bin)||path.posix.isAbsolute(bin))throw refuse('absolute path');
  const target=path.resolve(packageRoot,bin);
  if(!inside(packageRoot,target))throw refuse('path escapes the package');
  let realRoot:string,realTarget:string;
  try{realRoot=await fs.realpath(packageRoot);realTarget=await fs.realpath(target);}catch{throw refuse('bin file is missing');}
  if(!inside(realRoot,realTarget))throw refuse('resolved path escapes the package');
  if(!(await fs.stat(realTarget)).isFile())throw refuse('bin is not a file');
  const extension=path.extname(realTarget).toLowerCase();
  if(extension==='.exe'&&platform==='win32')return {command:realTarget,argsPrefix:[],source:'official_npm_native'};
  if(extension==='.js'||extension==='.mjs'||extension==='.cjs'||(extension===''&&await hasNodeShebang(realTarget))){
    const minimum=minimumNode(manifest?.engines?.node,pkg.defaultMinimumNode);
    const node=await findNodeRuntime(minimum,shimDirectory,options);
    if(!node)throw Error(`Official ${pkg.label} npm package bin ${realTarget} requires Node.js >= ${minimum.join('.')}, but no supported non-Electron Node.js runtime was found.`);
    return {command:node,argsPrefix:[realTarget],source:'official_npm_node'};
  }
  throw refuse(`unsupported bin type ${extension||'(none)'}`);
}

function parseVersion(value:unknown):number[]|undefined{
  const match=/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(value??'').trim());
  return match?[Number(match[1]),Number(match[2]??0),Number(match[3]??0)]:undefined;
}
/** Only the lower bound matters here: an unparseable range uses the package default. */
function minimumNode(range:unknown,fallback:number):number[]{
  const match=/>=?\s*v?(\d+(?:\.\d+){0,2})/.exec(String(range??''));
  return (match&&parseVersion(match[1]))??[fallback,0,0];
}
function atLeast(version:number[],minimum:number[]){for(let i=0;i<3;i++){if(version[i]!==minimum[i])return version[i]>minimum[i];}return true;}
function isNodeName(file:string,platform:NodeJS.Platform){return platform==='win32'?/^node\.exe$/i.test(path.basename(file)):path.basename(file)==='node';}

async function nodeVersion(file:string):Promise<number[]|undefined>{
  try{
    if(!(await fs.stat(file)).isFile())return undefined;
    // safeChildEnv drops ELECTRON_RUN_AS_NODE, so an Electron binary cannot pose as Node here.
    const out=await new Promise<string>((resolve,reject)=>execFile(file,['-p','process.versions.electron?"electron":process.versions.node'],{windowsHide:true,timeout:5000,env:safeChildEnv()},(e,stdout)=>e?reject(e):resolve(stdout)));
    return parseVersion(out);
  }catch{return undefined;}
}

export async function findNodeRuntime(minimum:number[],npmPrefix:string|undefined,options:NpmLaunchOptions={}):Promise<string|undefined>{
  const platform=options.platform??process.platform;
  const current=options.currentRuntime===undefined?{execPath:process.execPath,versions:process.versions}:options.currentRuntime;
  const seen=new Set<string>();
  const accept=async(file:string,known?:number[])=>{
    const key=path.resolve(file).toLowerCase();if(seen.has(key)||!isNodeName(file,platform))return false;seen.add(key);
    const version=known??await nodeVersion(file);return !!version&&atLeast(version,minimum);
  };
  const ordered=[...(npmPrefix?[path.join(npmPrefix,platform==='win32'?'node.exe':'node')]:[]),...(options.nodeCandidates??[])];
  for(const file of ordered)if(await accept(file))return file;
  if(current&&!current.versions.electron){const version=parseVersion(current.versions.node);if(version&&await accept(current.execPath,version))return current.execPath;}
  if(options.searchPath!==false){
    try{
      const listing=await new Promise<string>((resolve,reject)=>execFile(platform==='win32'?'where.exe':'which',platform==='win32'?['node']:['-a','node'],{windowsHide:true,timeout:5000},(e,stdout)=>e?reject(e):resolve(stdout)));
      for(const file of listing.split(/\r?\n/).map(x=>x.trim()).filter(Boolean))if(await accept(file))return file;
    }catch{}
  }
  return undefined;
}
