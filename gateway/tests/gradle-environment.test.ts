import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {gradleEnvironment,gradleTelemetry,observedCommandDownloads} from '../src/gradle-environment.js';
import {selectedInput} from './selection-fixture.js';

test('Gradle defaults reuse user cache and preserve explicitly configured writable/read-only homes',()=>{
 const unix=gradleEnvironment('/work/project',{platform:'linux',home:'/opt/fixture',env:{}});assert.equal(unix.userHome,'/opt/fixture/.gradle');assert.equal(unix.source,'user_default');assert.equal(unix.env.GRADLE_RO_DEP_CACHE,undefined);
 const custom=gradleEnvironment('/work/project',{platform:'linux',env:{GRADLE_USER_HOME:'../shared',GRADLE_RO_DEP_CACHE:'/opt/cache/modules'}});assert.equal(custom.userHome,'/work/shared');assert.equal(custom.env.GRADLE_RO_DEP_CACHE,'/opt/cache/modules');assert.equal(custom.source,'environment');
 const windows=gradleEnvironment('C:\\workspace',{platform:'win32',home:'C:\\fixture',env:{}});assert.equal(windows.userHome,'C:\\fixture\\.gradle');
 const metadata=gradleTelemetry(custom);assert.equal(metadata.createdByGateway,false);assert.equal(metadata.perJobHome,false);assert.equal(metadata.cleanup.removedBytes,0);assert.deepEqual(metadata.cleanup.removedPaths,[]);assert.equal(metadata.legacyHomes.automaticCleanup,false);assert.equal(metadata.networkEnforced,false);assert.equal(metadata.downloads.status,'not_observed');assert.match(metadata.downloads.warning,/does not establish/);
});
test('download telemetry accepts tool output only, redacts URL credentials/query and distinguishes start/completion',()=>{
 const observed=observedCommandDownloads([{command:'./gradlew --no-daemon test',source:'codex_json',output:'Downloading https://user:password@services.gradle.org/distributions/gradle-8.0-bin.zip?token=secret\n[INFO] Downloaded from central: https://repo.maven.apache.org/maven2/example.jar\nDownloading https://user:password@services.gradle.org/distributions/gradle-8.0-bin.zip?token=other'}]);
 assert.equal(observed.status,'observed');assert.equal(observed.targets.length,2);assert.deepEqual(observed.targets.map(row=>row.event),['download_started','download_reported_complete']);assert.equal(observed.targets[0].target,'https://services.gradle.org/distributions/gradle-8.0-bin.zip');assert.equal(JSON.stringify(observed).includes('password'),false);assert.equal(JSON.stringify(observed).includes('token='),false);
 assert.equal(observedCommandDownloads([{output:'I will say Downloading https://example.com/file\nNo Downloading https://example.com/file'}]).status,'not_observed');
});
test('Gradle telemetry is bounded and does not create or delete cache directories',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gradle-policy-'));try{const cache=path.join(root,'cache');await fs.mkdir(cache);await fs.writeFile(path.join(cache,'wrapper.zip'),'existing wrapper');const env=gradleEnvironment(root,{env:{GRADLE_USER_HOME:cache}});const metadata=gradleTelemetry(env,[{output:Array.from({length:60},(_,n)=>`Downloading https://example.com/artifact-${n}.jar`).join('\n')}]);assert.equal(metadata.downloads.targets.length,50);assert.equal(metadata.downloads.truncated,true);assert.deepEqual(await fs.readdir(root),['cache']);assert.equal(await fs.readFile(path.join(cache,'wrapper.zip'),'utf8'),'existing wrapper');}finally{await fs.rm(root,{recursive:true,force:true});}
});
test('Codex implementation inherits existing Gradle cache and reports command download evidence',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'codex-gradle-')),command=path.join(root,process.platform==='win32'?'codex.cmd':'codex.sh');
 const env={CODEX_CLI:command,CODEX_HOME:path.join(root,'codex-home'),AGENT_MCP_STATE_DIR:path.join(root,'state'),CODEX_MODEL:'auto',CODEX_EFFORT:'auto',GRADLE_USER_HOME:path.join(root,'shared-cache'),GRADLE_RO_DEP_CACHE:path.join(root,'read-only-deps')};const previous=new Map(Object.keys(env).map(key=>[key,process.env[key]]));
 try{
  await fs.writeFile(path.join(root,'fixture.mjs'),`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(path.join(root,'env.json'))},JSON.stringify({home:process.env.GRADLE_USER_HOME,ro:process.env.GRADLE_RO_DEP_CACHE}));for(const event of [{type:'item.completed',item:{id:'cmd',type:'command_execution',command:'./gradlew --no-daemon test',exit_code:0,aggregated_output:'Downloading https://services.gradle.org/distributions/fixture.zip'}},{type:'item.completed',item:{type:'agent_message',text:'Done'}},{type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}])console.log(JSON.stringify(event));`);
  if(process.platform==='win32')await fs.writeFile(command,`@echo off\r\n"${process.execPath}" "%~dp0fixture.mjs" %*\r\n`);else{await fs.writeFile(command,`#!/bin/sh\n"${process.execPath}" "$(dirname "$0")/fixture.mjs" "$@"\n`);await fs.chmod(command,0o755);}
  Object.assign(process.env,env);const {CodexProvider}=await import(`../src/providers/codex.js?gradle=${Math.random()}`);const provider:any=new CodexProvider();const result=await provider.execute('agent_implement',selectedInput({cwd:root,task:'fixture',max_runtime_minutes:1},'codex'));
  assert.equal(result.error,null);assert.equal(result.gradleUserHome,env.GRADLE_USER_HOME);assert.equal(result.gradle.policy,'reuse_user_cache');assert.equal(result.gradle.cleanup.removedBytes,0);assert.equal(result.gradle.downloads.status,'observed');assert.equal(result.gradle.downloads.targets[0].target,'https://services.gradle.org/distributions/fixture.zip');assert.deepEqual(JSON.parse(await fs.readFile(path.join(root,'env.json'),'utf8')),{home:env.GRADLE_USER_HOME,ro:env.GRADLE_RO_DEP_CACHE});await assert.rejects(fs.stat(path.join(root,'state','gradle')));
 }finally{for(const [key,value] of previous){if(value===undefined)delete process.env[key];else process.env[key]=value;}await fs.rm(root,{recursive:true,force:true});}
});
