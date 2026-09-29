import test from 'node:test';
import assert from 'node:assert/strict';
import {executionEvidence,implementationProgress} from '../src/execution-evidence.js';
test('completed turn with failed then successful commands does not certify acceptance',()=>{
 const value=executionEvidence({error:null,exitCode:1,commandExecutions:[{exitCode:1},{exitCode:0},{exitCode:0}]});
 assert.equal(value.turnStatus,'completed');assert.equal(value.completionCriteria.status,'unverified');
 assert.deepEqual(value.commands,{observed:3,succeeded:2,failed:1,unknown:0,status:'mixed',scope:'observed_commands_only',note:'Exit codes describe commands, not test counts or completion criteria. Earlier failures remain recorded after retries.'});
 assert.equal(executionEvidence({error:'failed',commandExecutions:[{exitCode:0}]}).turnStatus,'failed');
 assert.equal(executionEvidence({}).commands.status,'not_observed');
 assert.equal(executionEvidence({commandExecutions:[{exitCode:null}]}).commands.status,'incomplete');
});
test('progress warns on prolonged observed reads without claiming a stall or cancelling',()=>{
 const now=Date.now(),p={startedAt:new Date(now-300000).toISOString(),successfulReads:20,successfulWrites:0,commandsStarted:0};
 const read=(extra={})=>implementationProgress('agent_implement',{implementationProgress:{...p,...extra}},now);
 assert.equal(read().status,'exploration_without_observed_execution');assert.equal(read().automaticCancellation,false);
 assert.equal(read({successfulReads:19}).status,'observed_activity');
 assert.equal(read({successfulWrites:1}).status,'observed_activity');assert.equal(read({commandsStarted:1}).status,'observed_activity');
 assert.equal(read({startedAt:new Date(now-299000).toISOString()}).status,'observed_activity');
 assert.equal(implementationProgress('agent_review',{implementationProgress:p},now).status,'unavailable');
 assert.equal(implementationProgress('agent_implement',{},now).status,'unavailable');
});
