import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPrompt} from '../src/prompt.js';
test('all implementation providers preserve artifacts and require authorization before missing-cache downloads',()=>{
 for(const provider of ['Claude','Grok','Codex']){
  const prompt=buildPrompt('agent_implement',{cwd:process.cwd(),task:'Run local verification'},provider);
  assert.match(prompt,/Gradle --no-daemon/);assert.match(prompt,/Do not delete build artifacts/);
  assert.match(prompt,/remove_ignored_artifacts=true/);assert.match(prompt,/without explicit user authorization/);
  assert.match(prompt,/--offline alone does not prevent/);assert.match(prompt,/required verification command/);
  assert.match(prompt,/Do not create symlinks or directory junctions to the original workspace/);
 }
 assert.doesNotMatch(buildPrompt('agent_review',{cwd:process.cwd(),task:'Review'},'Codex'),/Use the available shell for local builds/);
});
