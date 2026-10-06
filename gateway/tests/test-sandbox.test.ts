import './isolated-environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';

const gateway=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const sandbox=createRequire(import.meta.url)(path.join(gateway,'scripts/test-sandbox.cjs'));
const preload=pathToFileURL(path.join(gateway,'scripts/test-sandbox-preload.mjs')).href;

test('test sandbox replaces caller storage and all temp aliases before child imports',()=>{
 const owned=sandbox.createTestSandbox();
 try{
  const env=sandbox.testEnvironment(owned,{...process.env,TEMP:'caller-temp',TMP:'caller-tmp',AGENT_MCP_WORKTREE_DIR:'caller-worktrees',AGENT_MCP_STATE_DIR:'caller-state'});
  const child=spawnSync(process.execPath,['--import',preload,'--input-type=module','-e','import os from "node:os"; console.log(JSON.stringify({temp:os.tmpdir(),worktrees:process.env.AGENT_MCP_WORKTREE_DIR,state:process.env.AGENT_MCP_STATE_DIR,TEMP:process.env.TEMP,TMP:process.env.TMP,TMPDIR:process.env.TMPDIR}));'],{env,encoding:'utf8',windowsHide:true});
  assert.equal(child.status,0,child.stderr);const result=JSON.parse(child.stdout);
  for(const key of ['temp','TEMP','TMP','TMPDIR'])assert.equal(result[key],path.join(owned.root,'tmp'));
  assert.equal(result.worktrees,path.join(owned.root,'worktrees'));assert.equal(result.state,path.join(owned.root,'state'));
 }finally{sandbox.cleanupTestSandbox(owned);}
 assert.equal(fs.existsSync(owned.root),false);
});

test('central runner cleans its owned root after a failed test with registered Git fixtures',()=>{
 const harness=fs.mkdtempSync(path.join(os.tmpdir(),'sandbox-failure-fixture-'));
 const testFile=path.join(harness,'failure.test.mjs'),reported=path.join(harness,'root.txt');
 const script=`import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import test from 'node:test';import {execFileSync} from 'node:child_process';fs.writeFileSync(${JSON.stringify(reported)},process.env.AGENT_MCP_TEST_SANDBOX_ROOT);const repo=path.join(os.tmpdir(),'repo');fs.mkdirSync(repo);const git=(...args)=>execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid',...args],{cwd:repo,stdio:'pipe'});git('init');fs.writeFileSync(path.join(repo,'file.txt'),'base');git('add','.');git('commit','-m','fixture');git('worktree','add','-b','fixture-worktree',path.join(process.env.AGENT_MCP_WORKTREE_DIR,'fixture'));const legacy=path.join(os.tmpdir(),'agent-acp-worktrees');fs.mkdirSync(legacy);fs.writeFileSync(path.join(legacy,'fixture.txt'),'fixture');test('deliberate failure',()=>{throw Error('expected fixture failure');});`;
 fs.writeFileSync(testFile,script);
 try{
  const child=spawnSync(process.execPath,[path.join(gateway,'scripts/run-tests.mjs'),testFile],{encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(child.status,1,child.stderr);assert.match(child.stdout,/expected fixture failure/);
  const generated=fs.readFileSync(reported,'utf8');assert.notEqual(generated,process.env.AGENT_MCP_TEST_SANDBOX_ROOT);assert.equal(fs.existsSync(generated),false);assert.ok(fs.existsSync(harness));
 }finally{fs.rmSync(harness,{recursive:true,force:true});}
});

test('sandbox cleanup unlinks child junctions without touching outside data',()=>{
 const owned=sandbox.createTestSandbox(),outside=fs.mkdtempSync(path.join(os.tmpdir(),'sandbox-outside-'));
 try{
  const sentinel=path.join(outside,'preserve.txt');fs.writeFileSync(sentinel,'outside data');fs.symlinkSync(outside,path.join(owned.root,'outside-link'),'junction');
  sandbox.cleanupTestSandbox(owned);assert.equal(fs.readFileSync(sentinel,'utf8'),'outside data');assert.equal(fs.existsSync(owned.root),false);
 }finally{if(fs.existsSync(owned.root))sandbox.cleanupTestSandbox(owned);fs.rmSync(outside,{recursive:true,force:true});}
});

test('sandbox cleanup refuses replaced ownership markers and redirected roots',()=>{
 const owned=sandbox.createTestSandbox(),marker=path.join(owned.root,'.agent-acp-test-owner.json'),original=fs.readFileSync(marker,'utf8');
 try{
  fs.writeFileSync(marker,JSON.stringify({schema:1,root:owned.root,token:'not-owned'}));assert.throws(()=>sandbox.cleanupTestSandbox(owned),/ownership marker/);assert.ok(fs.existsSync(owned.root));fs.writeFileSync(marker,original);
  const moved=owned.root+'-saved',outside=fs.mkdtempSync(path.join(os.tmpdir(),'sandbox-root-outside-'));fs.renameSync(owned.root,moved);
  try{fs.symlinkSync(outside,owned.root,'junction');assert.throws(()=>sandbox.cleanupTestSandbox(owned),/path changed/);assert.ok(fs.existsSync(outside));}
  finally{if(fs.lstatSync(owned.root).isSymbolicLink())fs.unlinkSync(owned.root);fs.renameSync(moved,owned.root);fs.rmSync(outside,{recursive:true,force:true});}
 }finally{sandbox.cleanupTestSandbox(owned);}
});
