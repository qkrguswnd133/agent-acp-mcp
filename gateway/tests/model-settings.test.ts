import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveProviderSettings,validateRunSettings,validateCatalog} from '../src/model-settings.js';
import {codexCatalog,unavailableCatalog} from '../src/model-catalog.js';
const base={cwd:process.cwd(),task:'fixture'};
function env(values:Record<string,string|undefined>,fn:()=>void){const old=new Map(Object.keys(values).map(k=>[k,process.env[k]]));try{for(const [k,v] of Object.entries(values)){if(v===undefined)delete process.env[k];else process.env[k]=v;}fn();}finally{for(const[k,v]of old){if(v===undefined)delete process.env[k];else process.env[k]=v;}}}
test('model options require unambiguous ownership and safe CLI identifiers',()=>{
 validateRunSettings({...base,provider:'claude',model:'opus[1m]',effort:'high',selection_reason:'Task fit'});
 for(const provider of ['auto','grok,claude',undefined])assert.throws(()=>validateRunSettings({...base,provider,model:'opus'}),/one explicit/);
 assert.throws(()=>validateRunSettings({...base,provider:'claude',selection_reason:'reason',provider_options:{claude:{model:'opus'}}}),/not both/);
 assert.throws(()=>validateRunSettings({...base,provider:'grok',provider_options:{claude:{model:'opus'}}}),/unrequested/);
 for(const model of ['--help','model;bad','model\nfoo','model"bad','model bad','x'.repeat(201)])assert.throws(()=>validateRunSettings({...base,provider:'claude',model}),/Invalid model/);
});
test('auto policies require concrete parent choices and nonblank reason independently',()=>env({CLAUDE_MODEL:'auto',CLAUDE_EFFORT:'auto'},()=>{
 for(const input of [base,{...base,model:'opus',selection_reason:'fit'},{...base,model:'auto',effort:'high',selection_reason:'fit'}])assert.throws(()=>resolveProviderSettings('claude',input),/MODEL_SELECTION_REQUIRED/);
 for(const selection_reason of [undefined,'','   '])assert.throws(()=>resolveProviderSettings('claude',{...base,model:'opus',effort:'high',selection_reason}),/SELECTION_REASON_REQUIRED/);
 const value=resolveProviderSettings('claude',{...base,model:'opus',effort:'high',selection_reason:'  complex task  '});
 assert.deepEqual(value.selection,{model:{value:'opus',source:'parent',reason:'complex task'},effort:{value:'high',source:'parent',reason:'complex task'}});
 assert.equal(process.env.CLAUDE_MODEL,'auto');
}));
test('fixed values are honored, matching values accepted, conflicts rejected',()=>env({CLAUDE_MODEL:'fixed',CLAUDE_EFFORT:'high'},()=>{
 assert.deepEqual(resolveProviderSettings('claude',base).selection,{model:{value:'fixed',source:'configured'},effort:{value:'high',source:'configured'}});
 assert.equal(resolveProviderSettings('claude',{...base,model:'fixed',effort:'high'}).model,'fixed');
 for(const input of [{model:'other'},{effort:'low'},{model:'auto'}])assert.throws(()=>resolveProviderSettings('claude',{...base,...input}),/FIXED_SETTING_CONFLICT/);
}));
test('mixed policies resolve independently in both directions',()=>{
 env({CODEX_MODEL:'fixed',CODEX_EFFORT:'auto'},()=>{const s=resolveProviderSettings('codex',{...base,effort:'high',selection_reason:'analysis'});assert.equal(s.modelSource,'configured');assert.equal(s.effortSource,'parent');});
 env({GROK_MODEL:'auto',GROK_EFFORT:'xhigh'},()=>{const s=resolveProviderSettings('grok',{...base,model:'grok-choice',selection_reason:'analysis'});assert.equal(s.modelSource,'parent');assert.equal(s.effortSource,'configured');assert.equal(s.effort,'xhigh');});
});
test('authoritative catalogs reject unsupported model or effort; unavailable catalog never confirms',()=>env({CODEX_MODEL:'auto',CODEX_EFFORT:'auto'},()=>{
 const s=resolveProviderSettings('codex',{...base,model:'known',effort:'high',selection_reason:'fit'});
 const c=codexCatalog([{model:'known',supportedReasoningEfforts:[{reasoningEffort:'low'}]}],'version');
 assert.throws(()=>validateCatalog('codex',s,c),/UNSUPPORTED_MODEL_OR_EFFORT/);
 assert.throws(()=>validateCatalog('codex',{...s,model:'missing'},c),/UNSUPPORTED_MODEL_OR_EFFORT/);
 assert.doesNotThrow(()=>validateCatalog('codex',s,unavailableCatalog('codex')));
}));
