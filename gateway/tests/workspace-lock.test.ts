import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {workspaceConflict} from '../src/workspace-lock.js';
test('lock policy allows only readers to overlap and permits separate worktree paths',()=>{
 const cwd=path.resolve('fixture'),child=path.join(cwd,'child'),other=path.resolve('fixture-other');
 for(const reader of ['agent_ask','agent_review','agent_investigate','grok_ask','grok_review','grok_investigate']){
  assert.equal(workspaceConflict({cwd,kind:reader},{cwd:child,kind:'grok_review'}),false);
  assert.equal(workspaceConflict({cwd,kind:reader},{cwd:child,kind:'agent_implement'}),true);
  assert.equal(workspaceConflict({cwd:child,kind:'grok_implement'},{cwd,kind:reader}),true);
 }
 assert.equal(workspaceConflict({cwd,kind:'unknown'},{cwd,kind:'agent_ask'}),true);
 assert.equal(workspaceConflict({cwd,kind:'agent_implement'},{cwd:other,kind:'agent_implement'}),false);
 assert.equal(workspaceConflict({cwd:path.parse(cwd).root,kind:'agent_implement'},{cwd,kind:'agent_review'}),true);
});
