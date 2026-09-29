import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {validateContinuationScope as check} from '../src/continuation-scope.js';
import {buildPrompt,implementationWorkflow} from '../src/prompt.js';
const cwd=path.resolve('scope-fixture'),a=path.join(cwd,'src'),b=path.join(cwd,'tests');
test('continuation accepts reordered, duplicate and narrower paths',()=>{
 const saved={cwd,kind:'grok_implement',allowed:[a,b]};
 check(saved,cwd,saved.kind,[b,a,a]);check(saved,cwd,saved.kind,[path.join(a,'file.ts')]);check(saved,cwd,saved.kind,[]);
});
test('continuation refuses broader siblings, changed cwd/tool and invalid cache',()=>{
 const saved={cwd,kind:'grok_implement',allowed:[a]};
 for(const scope of [[cwd],[b],[path.join(cwd,'src-other')]])assert.throws(()=>check(saved,cwd,saved.kind,scope),/expands/);
 assert.throws(()=>check(saved,a,saved.kind,[a]),/cwd or tool/);
 assert.throws(()=>check(saved,cwd,'grok_review',[a]),/cwd or tool/);
 assert.throws(()=>check({...saved,allowed:['relative']},cwd,saved.kind,[a]),/invalid/);
 assert.throws(()=>check({...saved,allowed:[]},cwd,saved.kind,[a]),/expands/);
});
test('implementation workflow applies to all common provider prompts without changing read-only roles',()=>{
 for(const provider of ['grok','claude','codex'])assert.ok(buildPrompt('agent_implement',{cwd,task:'fix compile'},provider).includes(implementationWorkflow));
 assert.ok(!buildPrompt('agent_review',{cwd,task:'review'},'claude').includes(implementationWorkflow));
});
