import assert from 'node:assert/strict';
import test from 'node:test';
import {claudeUsageAccountKey,refreshClaudeCredentials} from '../src/claude-auth-refresh.js';
import {runCommand} from '../src/process.js';
import fs from 'node:fs/promises';

test('Claude usage cache identity requires verified account and organization and stores only a hash',()=>{
  const auth={loggedIn:true,email:'Example@Example.com',orgId:'org-a'};
  const key=claudeUsageAccountKey(auth);
  assert.match(key!,/^[a-f0-9]{64}$/);
  assert.equal(key,claudeUsageAccountKey({...auth,email:'example@example.com'}));
  assert.notEqual(key,claudeUsageAccountKey({...auth,orgId:'org-b'}));
  assert.notEqual(key,claudeUsageAccountKey({...auth,email:'other@example.com'}));
  assert.equal(claudeUsageAccountKey({...auth,loggedIn:false}),undefined);
  assert.equal(claudeUsageAccountKey({...auth,orgId:undefined}),undefined);
  assert.equal(claudeUsageAccountKey(null),undefined);
});

test('renewal sends only control initialize, disables customizations and confirms account without retaining secrets',async()=>{
  const auth={loggedIn:true,email:'example@example.com',orgId:'org-a'};
  let calls=0,temporary='';
  const run:typeof runCommand=async(command,args,options={})=>{
    calls++;temporary=options.cwd!;assert.equal(command,'claude-test');assert.ok(options.timeoutMs!<=25_000);
    assert.equal(options.env?.CLAUDE_CODE_SAFE_MODE,'1');assert.equal(options.env?.ANTHROPIC_API_KEY,undefined);
    if(calls===1){
      assert.ok(args.includes('--safe-mode'));assert.ok(args.includes('--no-session-persistence'));assert.ok(args.includes('--tools='));assert.ok(args.includes('--setting-sources='));
      assert.ok(args.includes('--strict-mcp-config'));assert.ok(args.includes('{"mcpServers":{}}'));
      const lines=options.stdin!.trim().split('\n');assert.equal(lines.length,1);
      const input=JSON.parse(lines[0]);assert.equal(input.type,'control_request');assert.equal(input.request.subtype,'initialize');assert.equal(input.message,undefined);
      return {code:0,signal:null,timedOut:false,stderr:'',stdout:JSON.stringify({type:'control_response',response:{subtype:'success',request_id:input.request_id}})};
    }
    assert.deepEqual(args,['auth','status','--json']);
    return {code:0,signal:null,timedOut:false,stderr:'',stdout:JSON.stringify(auth)};
  };
  await refreshClaudeCredentials('claude-test',claudeUsageAccountKey(auth),run);
  assert.equal(calls,2);await assert.rejects(fs.stat(temporary),{code:'ENOENT'});
});

test('unsupported CLI and identity mismatch fail generically without echoing private output',async()=>{
  const failure:typeof runCommand=async()=>({code:1,signal:null,timedOut:false,stdout:'secret',stderr:'private-token'});
  await assert.rejects(refreshClaudeCredentials('claude-test',undefined,failure),error=>error instanceof Error&&!/secret|private-token/.test(error.message));
  let calls=0;
  const changed:typeof runCommand=async()=>({code:0,signal:null,timedOut:false,stderr:'',stdout:++calls===1?JSON.stringify({type:'control_response',response:{subtype:'success',request_id:'usage-auth-initialize'}}):JSON.stringify({loggedIn:true,email:'other@example.com',orgId:'org-a'})});
  await assert.rejects(refreshClaudeCredentials('claude-test','a'.repeat(64),changed),/could not be confirmed/);
});
