import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Client} from '../gateway/node_modules/@modelcontextprotocol/client/dist/index.mjs';
import {StdioClientTransport} from '../gateway/node_modules/@modelcontextprotocol/client/dist/stdio.mjs';
import {createManagedWorktree} from '../gateway/dist/src/managed-worktree.js';
import {persistJobPayload} from '../gateway/dist/src/job-payload.js';
test('MCP lifecycle tools bound output, preview cleanup and cancel waits without cancelling jobs',async()=>{
const exec=promisify(execFile),repoRoot=process.cwd(),fixture=await fs.mkdtemp(path.join(os.tmpdir(),'lifecycle-mcp-fixture-'));
const gateway=path.join(fixture,'gateway'),jobs=path.join(gateway,'state/jobs'),repo=path.join(fixture,'sample-project');
const previousStorage=process.env.AGENT_MCP_WORKTREE_DIR;process.env.AGENT_MCP_WORKTREE_DIR=path.join(fixture,'worktrees');
await fs.cp(path.join(repoRoot,'gateway/dist'),path.join(gateway,'dist'),{recursive:true});
await fs.copyFile(path.join(repoRoot,'gateway/package.json'),path.join(gateway,'package.json'));
await fs.symlink(path.join(repoRoot,'gateway/node_modules'),path.join(gateway,'node_modules'),'junction');await fs.mkdir(jobs,{recursive:true});await fs.mkdir(repo);
const git=async(...args)=>(await exec('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid',...args],{cwd:repo,windowsHide:true})).stdout.trim();
await git('init');await fs.writeFile(path.join(repo,'base.txt'),'base');await git('add','.');await git('commit','-m','base');
const entries=[];for(let n=0;n<2;n++){const id=randomUUID(),created=await createManagedWorktree({cwd:repo,task:'fixture'},id);entries.push({id,worktree:created.worktree});await fs.writeFile(path.join(jobs,id+'.json'),JSON.stringify({job_id:id,kind:'agent_implement',cwd:created.input.cwd,status:'failed',ownerPid:process.pid,startedAt:'2020-01-01T00:00:00Z',lastActivityAt:'2020-01-01T00:00:00Z',worktree:{...created.worktree,createdAt:'2020-01-01T00:00:00Z'},result:{error:'fixture task failure'}}));}
await fs.writeFile(path.join(entries[1].worktree.path,'retain.txt'),'retain');
const reviewText='Full review: 한글 본문을 보존합니다.\n'.repeat(500);
const largeId=randomUUID(),full={job_id:largeId,kind:'agent_review',cwd:repo,status:'completed',ownerPid:process.pid,startedAt:new Date().toISOString(),lastActivityAt:new Date().toISOString(),result:{error:null,results:[{provider:'codex',model:'fixture',sessionId:'fixture',text:reviewText,usage:{totalTokens:3},rawEvents:'x'.repeat(764000),commandExecutions:[{command:'git show',exitCode:0,output:'y'.repeat(705000)}]}]}};
await fs.writeFile(path.join(jobs,largeId+'.json'),JSON.stringify(await persistJobPayload(full,jobs)));
const activeId=randomUUID(),active={job_id:activeId,kind:'agent_ask',cwd:repo,status:'running',ownerPid:process.pid,startedAt:new Date().toISOString(),lastActivityAt:new Date().toISOString()};await fs.writeFile(path.join(jobs,activeId+'.json'),JSON.stringify(active));
const client=new Client({name:'codex-lifecycle-verifier',version:'1.0.0'});
const call=async(name,args={},options)=>{const r=await client.callTool({name,arguments:args},options);if(r.isError)throw Error(r.content[0].text);return JSON.parse(r.content[0].text);};
try{
 await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(gateway,'dist/src/index.js')],env:{...process.env,GROK_ENABLED:'false',CLAUDE_ENABLED:'false',CODEX_ENABLED:'false',AGENT_MCP_STATE_DIR:path.join(fixture,'quota')},stderr:'pipe'}));
 const listing=await client.listTools();for(const n of ['agent_worktree_list','agent_worktree_cleanup','agent_worktree_migrate','agent_worktree_recover','agent_job_wait'])assert(listing.tools.some(t=>t.name===n));
 assert.equal(listing.tools.find(t=>t.name==='agent_worktree_migrate').inputSchema.properties.dry_run.default,true);
 assert.equal(listing.tools.find(t=>t.name==='agent_worktree_list').inputSchema.properties.include_disk_size.default,false);
 assert.equal((await call('agent_status')).worktreeWarnings.count,2);
 assert.equal((await call('agent_worktree_list')).total,2);
 const preview=await call('agent_worktree_cleanup',{job_ids:entries.map(e=>e.id),dry_run:true});assert.equal(preview.results[0].eligible,true);assert.equal(preview.results[1].ok,false);assert(await fs.stat(entries[0].worktree.path));
 const cleaned=await call('agent_worktree_cleanup',{job_ids:entries.map(e=>e.id)});assert.equal(cleaned.results[0].worktree.state,'removed');assert.equal(cleaned.results[1].ok,false);
 const compact=await call('agent_job_status',{job_id:largeId});assert(Buffer.byteLength(JSON.stringify(compact))<=65536);assert.ok(compact.payload.artifact);assert.equal(compact.result.results[0].text,reviewText);
 assert.equal((await call('agent_job_status',{job_id:largeId,verbose:true})).result.results[0].rawEvents.length,764000);
 assert.equal((await call('agent_job_wait',{job_id:largeId,timeout_seconds:0})).wait.completed,true);
 assert.equal((await call('agent_job_wait',{job_id:activeId,timeout_seconds:0.1})).wait.timed_out,true);
 const abort=new AbortController(),waiting=call('agent_job_wait',{job_id:activeId,timeout_seconds:25},{signal:abort.signal});setTimeout(()=>abort.abort(),100);await assert.rejects(waiting);assert.equal((await call('agent_job_status',{job_id:activeId})).status,'running');
 await fs.unlink(path.join(entries[1].worktree.path,'retain.txt'));assert.equal((await call('agent_worktree_cleanup',{job_id:entries[1].id})).worktree.state,'removed');
 console.log(JSON.stringify({pass:true,host:'codex',bulkDryRun:true,safeBatch:true,oldWarning:true,compactBytes:Buffer.byteLength(JSON.stringify(compact)),fullBytes:Buffer.byteLength(JSON.stringify(full)),verboseRestored:true,waitCompleted:true,waitTimeout:true,waitCancellationLeavesJobRunning:true}));
}finally{await client.close();for(const entry of entries){if(await fs.stat(entry.worktree.path).catch(()=>false)){await fs.unlink(path.join(entry.worktree.path,'retain.txt')).catch(()=>{});await git('worktree','remove',entry.worktree.path);await git('update-ref','-d','refs/heads/'+entry.worktree.branch,entry.worktree.baseCommit);}}await fs.rm(fixture,{recursive:true,force:true});if(previousStorage===undefined)delete process.env.AGENT_MCP_WORKTREE_DIR;else process.env.AGENT_MCP_WORKTREE_DIR=previousStorage;}

});
