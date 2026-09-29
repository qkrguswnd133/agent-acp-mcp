import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {root} from '../src/acp.js';
import {Policy,canonical} from '../src/policy.js';
import {resolveGitExecutable} from '../src/git-read-policy.js';
test('filesystem policy rejects outside, readonly, sensitive and disallowed paths',async()=>{
 const cwd=await canonical(path.join(root,'work/policy-tests'));
 await fs.mkdir(cwd,{recursive:true});
 const p=new Policy(cwd,true,[path.join(cwd,'src')]);
 assert.equal(await p.checkPath('src/new.js',true),path.join(cwd,'src/new.js'));
 for(const name of ['../outside.js','other.js','src/.env','src/.git/config','src/new.js:stream'])await assert.rejects(p.checkPath(name,true));
 await assert.rejects(new Policy(cwd,false).checkPath('new.js',true));
});
test('filesystem policy rejects junction escape',async()=>{
 const cwd=await canonical(await fs.mkdtemp(path.join(os.tmpdir(),'agent-policy-junction-')));
 const outside=await canonical(await fs.mkdtemp(path.join(os.tmpdir(),'agent-policy-outside-')));
 const link=path.join(cwd,'escape');
 try{
  await fs.symlink(outside,link,'junction');
  await assert.rejects(new Policy(cwd,true).checkPath('escape/new.js',true));
 }finally{await fs.unlink(link).catch(()=>{});await fs.rmdir(cwd);await fs.rmdir(outside);}
});
test('implementation permits local test shells while read-only remains restricted',async()=>{
 const cwd=await canonical(path.join(root,'work/policy-tests'));const p=new Policy(cwd,true);
 for(const cmd of ['git push','git reset --hard','git clean -fd','node --check ../outside.js',''])await assert.rejects(p.command(cmd));
 for(const cmd of ['gradlew.bat test','mvn test','python -m pytest','npm test','bash -lc "npm test"','Write-Output fixture']){assert.ok(await p.command(cmd));await assert.rejects(new Policy(cwd,false).command(cmd));}
 assert.deepEqual((await p.command('node --check "한글 파일.js"')).args,['--check',path.join(cwd,'한글 파일.js')]);
 assert.ok(await new Policy(cwd,false).command('git diff --check'));
 await assert.rejects(p.permission({toolCallId:'1',kind:'other',rawInput:{}}));
});

import {execFileSync} from 'node:child_process';
import os from 'node:os';

test('Git read allowlist works in read and write modes, blocks mutation and shell escapes',async()=>{
 const cwd=await canonical(path.join(root,'work/policy-tests'));
 for(const writable of [false,true]) {
  const p=new Policy(cwd,writable);
  for(const cmd of ['git status --short','git status --porcelain=v1','git log -5 --oneline','git log -n 2 --format="%h %s"','git show HEAD --stat','git show HEAD:src/file.ts','git diff --cached -- src/file.ts','git diff HEAD~1 HEAD --name-only','git branch --show-current','git rev-parse HEAD','git ls-files']) assert.ok(await p.command(cmd),cmd);
  for(const cmd of ['git push','git fetch','git checkout main','git reset --hard','git clean -fd','git config user.name test','git status; git push','git status && git push','git log > out.txt','git -c alias.x=!whoami x','git diff --output=out.txt','git diff --ext-diff','git log --textconv','git show --show-signature','git log --format=%G?','git diff --no-index a b','git show HEAD:.env','git diff -- ../escape','git diff -- .aws/config','git show HEAD:../outside','git diff -- :(top)file','git status\nwhoami']) await assert.rejects(p.command(cmd),cmd);
 }
});

test('real Git queries preserve worktree/index and exclude credential files',async()=>{
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'grok-git-policy-'));
 const git=await resolveGitExecutable();
 const run=(...args:string[])=>execFileSync(git,args,{cwd,encoding:'utf8',windowsHide:true});
 try {
  run('init','-q');run('config','user.name','Policy fixture');run('config','user.email','fixture@example.invalid');
  await fs.writeFile(path.join(cwd,'a.txt'),'before\n');await fs.writeFile(path.join(cwd,'.env'),'FIXTURE_ONLY=hidden\n');
  run('add','a.txt','.env');run('commit','-qm','fixture');await fs.writeFile(path.join(cwd,'a.txt'),'after\n');await fs.writeFile(path.join(cwd,'.env'),'FIXTURE_ONLY=changed\n');
  const before=await fs.readFile(path.join(cwd,'.git/index'));const p=new Policy(await canonical(cwd),false);
  for(const cmd of ['git status --short','git log -1 --oneline','git log -1 -p','git show HEAD','git show HEAD:a.txt','git diff','git diff --check','git ls-files']) {
   const safe=await p.command(cmd);const result=execFileSync(safe.command,safe.args,{cwd,encoding:'utf8',windowsHide:true,env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_NO_LAZY_FETCH:'1'}});
   assert.ok(!result.includes('FIXTURE_ONLY'),cmd);assert.ok(!result.includes('.env'),cmd);
  }
  assert.deepEqual(await fs.readFile(path.join(cwd,'.git/index')),before);
  assert.equal(await fs.readFile(path.join(cwd,'a.txt'),'utf8'),'after\n');
 } finally {await fs.rm(cwd,{recursive:true,force:true});}
});

test('Windows Git discovery supports per-user and PATH installations without shell launchers',{skip:process.platform!=='win32'},async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'agent git discovery '));
 const pathKey=Object.keys(process.env).find(key=>key.toLowerCase()==='path')??'PATH';
 const keys=['ProgramFiles','ProgramFiles(x86)','LOCALAPPDATA',pathKey];
 const saved=new Map(keys.map(key=>[key,process.env[key]]));
 try{
  process.env.ProgramFiles=path.join(directory,'system');process.env['ProgramFiles(x86)']=path.join(directory,'system-x86');process.env.LOCALAPPDATA=path.join(directory,'local');
  const bin=path.join(directory,'portable bin');await fs.mkdir(bin,{recursive:true});
  process.env[pathKey]=[bin,path.join(process.env.SystemRoot??'C:/Windows','System32')].join(path.delimiter);
  await fs.writeFile(path.join(bin,'git.cmd'),'@echo off\r\necho SHOULD_NOT_RUN\r\n');
  await assert.rejects(resolveGitExecutable(),/Git executable not found/);
  const portable=path.join(bin,'git.exe');await fs.writeFile(portable,'discovery fixture; never executed');
  assert.equal(await resolveGitExecutable(),portable);
  const userInstall=path.join(process.env.LOCALAPPDATA,'Programs','Git','cmd','git.exe');await fs.mkdir(path.dirname(userInstall),{recursive:true});await fs.writeFile(userInstall,'discovery fixture; never executed');
  assert.equal(await resolveGitExecutable(),userInstall);
  const systemInstall=path.join(process.env.ProgramFiles,'Git','cmd','git.exe');await fs.mkdir(path.dirname(systemInstall),{recursive:true});await fs.writeFile(systemInstall,'discovery fixture; never executed');
  assert.equal(await resolveGitExecutable(),systemInstall);
 }finally{
  for(const [key,value] of saved){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  await fs.rm(directory,{recursive:true,force:true});
 }
});
