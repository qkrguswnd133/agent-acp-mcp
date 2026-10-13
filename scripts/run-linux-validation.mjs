#!/usr/bin/env node
// Run on native Linux or through wsl.exe. Never uses an installed Gateway or user credentials.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';

if(process.platform!=='linux')throw Error('Run this validation with Linux Node 24, directly or via wsl.exe --exec.');
if(Number(process.versions.node.split('.')[0])<24)throw Error('Linux validation requires Node.js 24+.');
let source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),suite='all',keep=false,report;
for(let i=2;i<process.argv.length;i++){
  const arg=process.argv[i];
  if(arg==='--source')source=path.resolve(process.argv[++i]??'');
  else if(arg==='--suite')suite=process.argv[++i];
  else if(arg==='--keep')keep=true;
  else if(arg==='--report'){report=process.argv[++i];if(!report||!path.isAbsolute(report))throw Error('--report requires an absolute path');}
  else throw Error(`Unknown argument ${arg}`);
}
if(!['gateway','updater','all'].includes(suite))throw Error('--suite must be gateway, updater or all');
const tempBase=await fs.realpath(os.tmpdir()),temp=await fs.mkdtemp(path.join(tempBase,'agent-acp-linux-validation-'));
const token=randomUUID(),owner=path.join(temp,'.validation-owner.json'),home=path.join(temp,'home'),repo=path.join(temp,'source');
await fs.writeFile(owner,JSON.stringify({temp,token}),{flag:'wx',mode:0o600});
await fs.mkdir(home,{recursive:true});await fs.mkdir(repo);
const env={HOME:home,PATH:`${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,LANG:'C.UTF-8',LC_ALL:'C.UTF-8',
  TMPDIR:path.join(temp,'tmp'),XDG_CONFIG_HOME:path.join(home,'.config'),XDG_DATA_HOME:path.join(home,'.local/share'),XDG_STATE_HOME:path.join(home,'.local/state'),
  CODEX_HOME:path.join(home,'.codex'),CLAUDE_CONFIG_DIR:path.join(home,'.claude'),npm_config_cache:path.join(temp,'npm-cache'),npm_config_update_notifier:'false',
  GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:path.join(home,'.gitconfig')};
await fs.mkdir(env.TMPDIR);await fs.mkdir(env.CODEX_HOME,{recursive:true});await fs.mkdir(env.CLAUDE_CONFIG_DIR,{recursive:true});
const phases=[];
async function sourceIdentity(){
  const capture=args=>new Promise((resolve,reject)=>{
    // Canonicalize text line endings when reading the same checkout through
    // Windows Git and Linux Git; do not change repository config or index.
    const child=spawn('git',['--no-optional-locks','-c','core.autocrlf=input','-c',`safe.directory=${source}`,'-C',source,...args],{env,stdio:['ignore','pipe','pipe']});let out='',err='';
    child.stdout.on('data',data=>out+=data);child.stderr.on('data',data=>err+=data);child.once('error',reject);child.once('exit',code=>code===0?resolve(out.trim()):reject(Error(`Git source identity failed: ${err}`)));
  });
  return {commit:await capture(['rev-parse','HEAD']),dirty:!!await capture(['status','--porcelain','--untracked-files=normal'])};
}
async function run(label,command,args,cwd){
  console.log(`LINUX_VALIDATION ${label}: ${command} ${args.join(' ')}`);
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd,env,stdio:'inherit'});child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));
  });
  phases.push({label,...result});if(result.code!==0)throw Error(`${label} failed (exit ${result.code}, signal ${result.signal??'none'})`);
}
let failed,before,after;
try{
  before=await sourceIdentity();
  if(suite==='gateway'||suite==='all'){
    const target=path.join(repo,'gateway');await fs.mkdir(target);
    for(const file of ['package.json','package-lock.json','tsconfig.json'])await fs.copyFile(path.join(source,'gateway',file),path.join(target,file));
    for(const directory of ['src','tests','scripts','profiles'])await fs.cp(path.join(source,'gateway',directory),path.join(target,directory),{recursive:true});
    await run('npm-ci','npm',['ci','--ignore-scripts','--no-audit','--no-fund'],target);
    await run('gateway-full-test','npm',['test'],target);
  }
  if(suite==='updater'||suite==='all'){
    await fs.mkdir(path.join(repo,'distribution'),{recursive:true});await fs.mkdir(path.join(repo,'tests'),{recursive:true});
    await fs.cp(path.join(source,'distribution/linux'),path.join(repo,'distribution/linux'),{recursive:true});
    await fs.copyFile(path.join(source,'tests/linux-updater.test.mjs'),path.join(repo,'tests/linux-updater.test.mjs'));
    await run('linux-updater-test',process.execPath,['--test','tests/linux-updater.test.mjs'],repo);
  }
}catch(error){failed=error;console.error(error.stack??String(error));}
finally{
  try{after=await sourceIdentity();}catch(error){failed??=error;}
  if(before?.commit!==after?.commit)failed??=Error('Source commit changed during Linux validation');
  const receipt={schemaVersion:1,sourceCommit:before?.commit??null,sourceCommitAtFinish:after?.commit??null,sourceDirty:!!before?.dirty||!!after?.dirty,
    platform:process.platform,arch:process.arch,nodeVersion:process.version,suite,passed:!failed,finishedAt:new Date().toISOString(),phases,...(keep?{retainedFixture:temp}:{})};
  if(report){await fs.mkdir(path.dirname(report),{recursive:true});await fs.writeFile(report,JSON.stringify(receipt,null,2)+'\n');}
  console.log('LINUX_VALIDATION_RESULT '+JSON.stringify(receipt));
  if(!keep){
    const recorded=JSON.parse(await fs.readFile(owner,'utf8'));
    if(recorded.token!==token||recorded.temp!==temp||path.dirname(temp)!==tempBase||await fs.realpath(temp)!==temp)throw Error(`Unsafe cleanup target retained: ${temp}`);
    await fs.rm(temp,{recursive:true,force:false});
  }
}
if(failed)process.exitCode=1;
