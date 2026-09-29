import test from 'node:test';
import assert from 'node:assert/strict';
import {claudeModelMetadata} from '../src/claude-model.js';

test('preserves CLI and transcript identifiers without inventing a minor version',()=>{
 const result=claudeModelMetadata({modelUsage:{'claude-opus-5[1m]':{}},version:'2.1.278',result:'I am Opus 5.2'},['claude-opus-5']);
 assert.equal(result.model,'claude-opus-5[1m]');
 assert.deepEqual(result.observedModels,['claude-opus-5[1m]','claude-opus-5']);
 assert.equal(result.minorVersion,'unavailable');assert.equal(result.modelSnapshot,'unavailable');
 assert.equal(result.modelEvidence[1].source,'session_jsonl.message.model');
});
test('retains multiple used models rather than selecting the first usage key',()=>{
 const result=claudeModelMetadata({modelUsage:{'model-a':{},'model-b':{}}},['model-b']);
 assert.equal(result.model,'mixed');assert.deepEqual(result.cliModels,['model-a','model-b']);
});
test('failed or missing CLI result retains transcript models',()=>{
 assert.equal(claudeModelMetadata(undefined,['model-a']).model,'model-a');
 assert.equal(claudeModelMetadata(undefined,['model-a','model-b']).model,'mixed');
 assert.equal(claudeModelMetadata(undefined).model,'unavailable');
});
test('explicit model revision fields preserve evidence and conflicting values',()=>{
 const result=claudeModelMetadata({model:'model-a',model_minor_version:'5.2',model_snapshot:'snapshot-id'});
 assert.equal(result.minorVersion,'5.2');assert.equal(result.modelSnapshot,'snapshot-id');
 assert.equal(result.minorVersionEvidence[0].source,'cli_result.model_minor_version');
 assert.equal(claudeModelMetadata({model_minor_version:'5.2',modelMinorVersion:'5.3'}).minorVersion,'mixed');
});
