import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveProviderSettings,validateRunSettings} from '../src/model-settings.js';
test('model options require unambiguous provider ownership and safe CLI identifiers',()=>{
 const base={cwd:process.cwd(),task:'fixture'};
 validateRunSettings({...base,provider:'claude',model:'opus[1m]',effort:'high'});
 validateRunSettings({...base,provider:'auto',provider_options:{claude:{model:'opus',effort:'high'},codex:{effort:'xhigh'}}});
 for(const provider of ['auto','grok,claude',undefined])assert.throws(()=>validateRunSettings({...base,provider,model:'opus'}),/one explicit/);
 assert.throws(()=>validateRunSettings({...base,provider:'claude',effort:'high',provider_options:{claude:{model:'opus'}}}),/not both/);
 assert.throws(()=>validateRunSettings({...base,provider:'grok',provider_options:{claude:{model:'opus'}}}),/unrequested/);
 for(const model of ['--help','model;bad','model\nfoo','model"bad','model bad','x'.repeat(201)])assert.throws(()=>validateRunSettings({...base,provider:'claude',model}),/Invalid model/);
});
test('per-provider overrides and explicit auto are independent of shared environment',()=>{
 const old=process.env.CLAUDE_MODEL;process.env.CLAUDE_MODEL='configured-model';
 try{
  const base={cwd:process.cwd(),task:'fixture'};
  const first=resolveProviderSettings('claude',{...base,provider_options:{claude:{model:'auto',effort:'high'}}});
  const second=resolveProviderSettings('claude',base);
  assert.equal(first.model,'auto');assert.equal(first.modelSource,'call');assert.equal(first.effort,'high');
  assert.equal(second.model,'configured-model');assert.equal(second.modelSource,'environment');assert.equal(process.env.CLAUDE_MODEL,'configured-model');
 }finally{if(old===undefined)delete process.env.CLAUDE_MODEL;else process.env.CLAUDE_MODEL=old;}
});
