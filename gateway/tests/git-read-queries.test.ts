import test from 'node:test';
import assert from 'node:assert/strict';
import {gitReadCommand} from '../src/git-read-policy.js';
import {buildPrompt} from '../src/prompt.js';
test('rev-parse short and verify allow safe refs but never shell operators or global/mutation options',async()=>{
 for(const command of ['git rev-parse --short HEAD','git rev-parse --short=12 HEAD~1','git rev-parse --verify refs/heads/main','git rev-parse --verify HEAD^{commit}']){
  const result=await gitReadCommand(command,async value=>value);assert.ok(result);assert.ok(result.args.includes('--end-of-options'));
 }
 for(const command of ['git rev-parse --verify --output=bad','git rev-parse --short=0 HEAD','git rev-parse --short=1000 HEAD','git rev-parse --verify HEAD:file','git rev-parse --verify HEAD; git status','git status && git show','git -c core.sshCommand=bad rev-parse HEAD','git rev-parse --git-dir','git rev-parse --verify HEAD\ngit status'])await assert.rejects(gitReadCommand(command,async value=>value));
 assert.match(buildPrompt('agent_review',{cwd:process.cwd(),task:'fixture'},'Grok'),/one at a time/);
});
