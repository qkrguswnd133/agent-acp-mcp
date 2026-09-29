import assert from 'node:assert/strict';
import test from 'node:test';
import {quotaFromRateLimits} from '../src/providers/codex.js';
test('Codex preserves confirmed quota windows without guessing their durations',()=>{
 const quota=quotaFromRateLimits({rateLimits:{primary:{usedPercent:72,windowDurationMins:300,resetsAt:100},secondary:{usedPercent:91,windowDurationMins:10080}}});
 assert.deepEqual(quota.windows,[{id:'five_hour',label:'5시간',usedPercent:72,remainingPercent:28,resetsAt:new Date(100000).toISOString()},{id:'seven_day',label:'주간',usedPercent:91,remainingPercent:9,resetsAt:null}]);
 assert.equal(quotaFromRateLimits({primary:{usedPercent:2}}).windows,undefined);
 assert.equal(quotaFromRateLimits({primary:{usedPercent:null,windowDurationMins:300}}).windows,undefined);
});

test('Codex quota leaves null or missing usage unknown instead of treating it as zero',()=>{
 const quota=quotaFromRateLimits({rateLimits:{primary:{usedPercent:null,resetsAt:null},secondary:{resetsAt:1234}}});
 assert.equal(quota.state,'unknown');assert.equal(quota.usedPercent,undefined);assert.equal(quota.remainingPercent,undefined);assert.equal(quota.resetsAt,undefined);
});

test('Codex quota pairs highest usage with that window reset time',()=>{
 const quota=quotaFromRateLimits({rateLimits:{primary:{usedPercent:75,resetsAt:100},secondary:{usedPercent:20,resetsAt:999}}});
 assert.equal(quota.state,'available');assert.equal(quota.usedPercent,75);assert.equal(quota.remainingPercent,25);assert.equal(quota.resetsAt,100);
});

test('Codex quota uses the latest reset when multiple windows are exhausted',()=>{
 const quota=quotaFromRateLimits({rateLimits:{primary:{usedPercent:100,resetsAt:100},secondary:{usedPercent:100,resetsAt:999}}});
 assert.equal(quota.state,'exhausted');assert.equal(quota.usedPercent,100);assert.equal(quota.remainingPercent,0);assert.equal(quota.resetsAt,999);assert.match(String(quota.note),/multiple quota windows exhausted/);
});
