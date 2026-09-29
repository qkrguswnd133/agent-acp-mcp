import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {promisify} from 'node:util';
import {QuotaCache} from '../src/quota-cache.js';

async function fixture() { const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-acp-quota-')); return {directory, file: path.join(directory, 'quota.json')}; }
const rate = {errorKind: 'rate_limited', limitKind: 'rate_limited' as const};
const quota = {errorKind: 'quota_exhausted', limitKind: 'quota_exhausted' as const};
const execFileAsync = promisify(execFile);

test('expires a cooldown to unknown instead of marking it available', async () => {
  const {directory, file} = await fixture(); let now = 1_000;
  try {
    const cache = new QuotaCache(file, {now: () => now, rateRetryMs: 60});
    await cache.markLimited('claude', rate, 'slow down');
    assert.equal((await cache.get('claude'))?.state, 'exhausted');
    now += 61;
    assert.equal(await cache.get('claude'), undefined);
  } finally { await fs.rm(directory, {recursive: true, force: true}); }
});

test('expired limit evidence makes another process refresh a pre-limit snapshot', async () => {
  const {directory, file} = await fixture(); let now = 1_000;
  try {
    const writer = new QuotaCache(file, {now: () => now, rateRetryMs: 50});
    const observer = new QuotaCache(file, {now: () => now, rateRetryMs: 50});
    await writer.markLimited('codex', rate, 'retry', 1_000);
    now = 1_051;
    assert.equal(await observer.get('codex'), undefined);
    assert.equal(await observer.needsRefresh('codex', 999), true);
    assert.equal(await observer.needsRefresh('codex', 1_001), false);
  } finally { await fs.rm(directory, {recursive: true, force: true}); }
});

test('no-reset quota and rate limits use their distinct default cooldowns', async () => {
  const {directory, file} = await fixture(); const now = Date.parse('2026-09-22T00:00:00.000Z');
  try {
    const cache = new QuotaCache(file, {now: () => now, quotaRetryMs: 15 * 60_000, rateRetryMs: 60_000});
    await cache.markLimited('claude', quota, 'quota');
    await cache.markLimited('grok', rate, 'rate');
    const quotaStatus = await cache.get('claude'), rateStatus = await cache.get('grok');
    assert.equal(quotaStatus?.resetsAt, null); assert.equal(quotaStatus?.retryAfter, '2026-09-22T00:15:00.000Z');
    assert.equal(rateStatus?.resetsAt, null); assert.equal(rateStatus?.retryAfter, '2026-09-22T00:01:00.000Z');
  } finally { await fs.rm(directory, {recursive: true, force: true}); }
});

test('quota trusts a confirmed actual reset while rate uses Retry-After', async () => {
  const {directory, file} = await fixture(); const now = Date.parse('2026-09-22T00:00:00.000Z');
  try {
    const cache = new QuotaCache(file, {now: () => now});
    await cache.markLimited('claude', {...quota, resetsAt: '2026-09-22T02:00:00Z', retryAfter: '2026-09-22T00:00:30Z'}, 'quota reset');
    await cache.markLimited('grok', {...rate, resetsAt: '2026-09-22T02:00:00Z', retryAfter: '2026-09-22T00:00:45Z'}, 'retry header');
    assert.equal((await cache.get('claude'))?.retryAfter, '2026-09-22T02:00:00.000Z');
    assert.equal((await cache.get('grok'))?.retryAfter, '2026-09-22T00:00:45.000Z');
  } finally { await fs.rm(directory, {recursive: true, force: true}); }
});

test('migrates legacy blockedUntil but removes ambiguous legacy reset values', async () => {
  const {directory, file} = await fixture();
  try {
    await fs.writeFile(file, JSON.stringify({claude: {quota: {state: 'exhausted', source: 'old', resetsAt: '2099-01-01T00:00:00.000Z'}, blockedUntil: 2_000_000_000, updatedAt: '2026-09-22T00:00:00.000Z'}}));
    const cache = new QuotaCache(file, {now: () => 1_000});
    assert.equal((await cache.get('claude'))?.resetsAt, null);
    await cache.markAvailable('grok');
    const migrated = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(migrated.schemaVersion, 2); assert.equal(migrated.providers.claude.resetsAt, null); assert.equal(migrated.providers.claude.retryAfter, 2_000_000_000);
  } finally { await fs.rm(directory, {recursive: true, force: true}); }
});

test('multiple cache instances preserve independent writes and stale success cannot clear a newer limit', async () => {
  const {directory, file} = await fixture(); let now = 10_000;
  try {
    const first = new QuotaCache(file, {now: () => now, rateRetryMs: 500});
    const second = new QuotaCache(file, {now: () => now, rateRetryMs: 500});
    await Promise.all([first.markLimited('claude', rate, 'first', 10_000), second.markLimited('grok', rate, 'second', 10_001)]);
    assert.equal((await first.get('claude'))?.state, 'exhausted'); assert.equal((await second.get('grok'))?.state, 'exhausted');
    now = 10_100;
    await first.markAvailable('claude', 'late success', 9_999);
    assert.equal((await second.get('claude'))?.state, 'exhausted');
  } finally { await fs.rm(directory, {recursive: true, force: true}); }
});

test('separate processes serialize cache writes', async () => {
  const {directory, file} = await fixture();
  try {
    const moduleUrl = new URL('../src/quota-cache.js', import.meta.url).href;
    const writer = (provider: string) => execFileAsync(process.execPath, ['--input-type=module', '--eval', `import {QuotaCache} from ${JSON.stringify(moduleUrl)}; await new QuotaCache(${JSON.stringify(file)}).markLimited(${JSON.stringify(provider)},{errorKind:'rate_limited',limitKind:'rate_limited'},'worker');`]);
    await Promise.all([writer('claude'), writer('grok')]);
    const cache = new QuotaCache(file);
    assert.equal((await cache.get('claude'))?.state, 'exhausted'); assert.equal((await cache.get('grok'))?.state, 'exhausted');
  } finally { await fs.rm(directory, {recursive: true, force: true}); }
});

test('an orphaned lock is recovered without hiding an active recorded limit', async () => {
  const {directory, file} = await fixture(); let now = 20_000;
  try {
    const cache = new QuotaCache(file, {now: () => now, rateRetryMs: 500});
    await cache.markLimited('claude', rate, 'active');
    const lock = `${file}.lock`;
    await fs.writeFile(lock, 'orphan');
    const old = new Date(Date.now() - 20_000); await fs.utimes(lock, old, old);
    assert.equal((await cache.get('claude'))?.limitKind, 'rate_limited');
  } finally { await fs.rm(directory, {recursive: true, force: true}); }
});

test('a current lock still exposes an active block after contention', async () => {
  const {directory, file} = await fixture(); const now = 20_000;
  try {
    const cache = new QuotaCache(file, {now: () => now, rateRetryMs: 500});
    await cache.markLimited('claude', rate, 'active');
    const lock = `${file}.lock`; await fs.writeFile(lock, 'in use');
    assert.equal((await cache.get('claude'))?.limitKind, 'rate_limited');
    await fs.unlink(lock).catch(() => undefined);
  } finally { await fs.rm(directory, {recursive: true, force: true}); }
});

test('cache telemetry failures do not reject provider work', async () => {
  const {directory, file} = await fixture();
  try {
    await fs.writeFile(path.join(directory, 'blocked'), 'file');
    const cache = new QuotaCache(path.join(directory, 'blocked', 'quota.json'));
    await assert.doesNotReject(cache.markLimited('codex', rate, 'cannot write'));
    await assert.doesNotReject(cache.markAvailable('codex'));
  } finally { await fs.rm(directory, {recursive: true, force: true}); }
});

test('invalid legacy numeric reset evidence never throws or invents a reset', async () => {
  const {directory, file} = await fixture();
  try {
    const cache = new QuotaCache(file);
    await assert.doesNotReject(cache.markExhausted('claude', 'bad reset', Number.MAX_VALUE));
    const quota = await cache.get('claude');
    assert.equal(quota?.resetsAt, null);
  } finally { await fs.rm(directory, {recursive: true, force: true}); }
});

test('invalid numeric cache cooldown values are ignored without throwing', async () => {
  const {directory, file} = await fixture();
  try {
    await fs.writeFile(file, JSON.stringify({schemaVersion: 2, providers: {claude: {quota: {state: 'exhausted', source: 'old'}, limitKind: 'quota_exhausted', resetsAt: null, retryAfter: Number.MAX_VALUE, updatedAt: '2026-09-22T00:00:00.000Z', observedAt: 1}}}));
    const cache = new QuotaCache(file);
    await assert.doesNotReject(cache.get('claude'));
    assert.equal(await cache.get('claude'), undefined);
  } finally { await fs.rm(directory, {recursive: true, force: true}); }
});
