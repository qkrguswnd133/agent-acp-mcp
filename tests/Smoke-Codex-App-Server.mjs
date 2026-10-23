// Opt-in real subscription smoke test: one tiny read-only turn, never part of npm test.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

const options={speed:'standard',model:'gpt-6-luna',effort:'low'};
for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i].replace(/^--/,'');if(!['cli','speed','model','effort','report','gateway-dir'].includes(key)||!process.argv[i+1])throw Error('Expected --cli PATH [--speed standard|fast] [--model ID] [--effort VALUE] [--report PATH] [--gateway-dir PATH]');options[key]=process.argv[i+1];}
if(!options.cli||!path.isAbsolute(options.cli)||!['standard','fast'].includes(options.speed))throw Error('Explicit absolute --cli and supported --speed are required');
const gateway=path.resolve(options['gateway-dir']??path.join(path.dirname(fileURLToPath(import.meta.url)),'../gateway'));
const base=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(base,'agent-app-native-smoke-')),cwd=path.join(root,'workspace');
await fs.mkdir(cwd);Object.assign(process.env,{CODEX_CLI:options.cli,CODEX_SPEED:options.speed,CODEX_MODEL:'auto',CODEX_EFFORT:'auto',AGENT_MCP_STATE_DIR:path.join(root,'state')});
let receipt,retainFixture=false;
try{
 const {CodexProvider}=await import(pathToFileURL(path.join(gateway,'dist/src/providers/codex.js')));
 const provider=new CodexProvider(),status=await provider.status(true);
 assert.equal(status.authenticated,true,'Existing CLI login required');assert.equal(status.subscriptionAuth,true,'Subscription authentication required');
 assert.notEqual(status.quota.state,'exhausted','Do not run smoke while subscription is exhausted');
 const result=await provider.run('agent_ask',{cwd,task:'Read-only agent-acp-mcp app-server compatibility smoke test. Do not call any tools. Do not read, create, or modify files. Reply exactly with: AGENT_APP_SERVER_OK',provider:'codex',model:options.model,effort:options.effort,selection_reason:'Small read-only protocol verification with the selected lightweight model and effort.',max_runtime_minutes:2});
 retainFixture=result.processCleanup?.verified!==true;
 receipt={platform:process.platform,cliVersion:status.version,transport:result.transport,error:result.error??null,text:result.text,sessionId:result.sessionId,turnId:result.turnId,model:result.model,effort:result.effort,observation:result.observation,executionSpeed:result.executionSpeed,usage:result.usage,completion:result.completion,processExit:result.processExit,processCleanupState:result.processCleanup?.verified?'verified':result.processCleanup?.remainingPids?.length?'remaining':'unverified',workspaceEntries:await fs.readdir(cwd)};
 if(options.report)await fs.writeFile(options.report,JSON.stringify(receipt,null,2)+'\n');
 console.log(JSON.stringify(receipt,null,2));
 assert.equal(result.error,null);assert.equal(result.text.trim(),'AGENT_APP_SERVER_OK');assert.equal(result.transport,'codex_app_server');
 assert.equal(result.executionSpeed.effective,options.speed);assert.equal(result.executionSpeed.effectiveVerified,true);
 assert.equal(result.executionSpeed.threadId,result.sessionId);assert.equal(result.executionSpeed.turnId,result.turnId);
 assert.equal(result.completion.confirmed,true);assert.deepEqual(receipt.workspaceEntries,[]);
}finally{
 // Only remove the fresh fixture root; official CLI session history is retained.
 const resolved=await fs.realpath(root);
 if(retainFixture)console.error(`Process cleanup needs inspection; fixture retained: ${resolved}`);
 else if(path.dirname(resolved)===base&&path.basename(resolved).startsWith('agent-app-native-smoke-'))await fs.rm(resolved,{recursive:true,maxRetries:3,retryDelay:100});
}
