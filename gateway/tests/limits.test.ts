import assert from 'node:assert/strict';
import test from 'node:test';
import {classifyProviderError} from '../src/limits.js';

const now = Date.parse('2026-09-22T00:00:00.000Z');

test('classifies context and output limits before account limits', () => {
  assert.equal(classifyProviderError({code: 'context_length_exceeded', message: 'weekly quota exhausted'}, now).errorKind, 'context_limit');
  assert.equal(classifyProviderError({message: 'maximum output tokens reached'}, now).errorKind, 'output_limit');
});

test('distinguishes a transient 429 from subscription quota and reads retry headers', () => {
  const rate = classifyProviderError({status: 429, headers: {'Retry-After': '5'}, message: 'Too many requests'}, now);
  assert.equal(rate.errorKind, 'rate_limited'); assert.equal(rate.limitKind, 'rate_limited');
  assert.equal(rate.retryAfter, '2026-09-22T00:00:05.000Z');
  const quota = classifyProviderError({status: 429, error: {code: 'insufficient_quota', message: 'Weekly usage quota exhausted'}, headers: {'x-ratelimit-reset': '2026-09-23T00:00:00Z'}}, now);
  assert.equal(quota.errorKind, 'quota_exhausted'); assert.equal(quota.limitKind, 'quota_exhausted');
  assert.equal(quota.resetsAt, '2026-09-23T00:00:00.000Z');
});

test('does not guess timezone-free reset text and leaves ordinary errors alone', () => {
  const result = classifyProviderError({status: 429, headers: {'retry-after': '2026-09-22 12:00:00'}}, now);
  assert.equal(result.retryAfter, null); assert.equal(result.resetsAt, null);
  assert.deepEqual(classifyProviderError({error: {message: 'socket closed'}}), {errorKind: 'task_error'});
});

test('classifies nested provider error arrays', () => {
  const result = classifyProviderError({errors: [{code: 'rate_limit_exceeded', message: 'Too many requests'}]}, now);
  assert.equal(result.errorKind, 'rate_limited'); assert.equal(result.limitKind, 'rate_limited');
});
