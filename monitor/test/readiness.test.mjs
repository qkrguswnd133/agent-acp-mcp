import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
const require = createRequire(import.meta.url);
const { checkReadiness } = require('../update/readiness.cjs');
const execute = promisify(execFile);
const birth = '2026-01-01T00:00:00.000Z', start = '2026-01-01T00:01:00.000Z';
const row = (pid, extra = {}) => ({ pid, parentPid: 1, createdAt: birth, creationKey: 'windows:638712864000000000', imageName: 'other.exe', ...extra });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-readiness-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const installRoot = path.join(root, 'Gateway with spaces'), stateRoot = path.join(root, 'external state');
  await fs.mkdir(installRoot); await fs.mkdir(stateRoot);
  const write = async (relative, value, base = stateRoot) => { const file = path.join(base, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value)); return file; };
  const check = (processes = [], options = {}) => checkReadiness({ installRoot, stateRoot, inventory: { complete: true, processes }, ...options });
  return { root, installRoot, stateRoot, write, check };
}
test('readiness permits idle installations, preserves terminal records, and reads inventory once', async t => {
  const f = await fixture(t); const record = { job_id: 'old', status: 'failed', ownerPid: 55, startedAt: start };
  const file = await f.write('jobs/old.json', record); let calls = 0;
  const result = await f.check([], { inventory: async () => { calls++; return { complete: true, processes: [] }; } });
  assert.equal(result.ready, true); assert.equal(calls, 1); assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), record);
});
test('active jobs in external state block; dead and reused owners only pass without children', async t => {
  const f = await fixture(t); await f.write('jobs/job.json', { job_id: 'job', status: 'running', ownerPid: 55, startedAt: start });
  let value = await f.check([row(55)]); assert.equal(value.ready, false); assert.equal(value.activeJobs[0].ownership, 'alive');
  assert.equal((await f.check([])).ready, true);
  assert.equal((await f.check([row(55, { createdAt: '2026-01-01T01:00:00Z' })])).ready, true);
  value = await f.check([row(88, { parentPid: 55, createdAt: start })]); assert.equal(value.ready, false); assert.deepEqual(value.activeJobs[0].childPids, [88]);
  value = await f.check([row(55, { createdAt: null })]); assert.equal(value.ready, false); assert.equal(value.activeJobs[0].ownership, 'unknown');
});
test('recorded orphaned child identity blocks even after Linux reparenting', async t => {
  const f = await fixture(t);
  await f.write('jobs/job.json', { job_id: 'job', status: 'running', ownerPid: 55, startedAt: start,
    runtimeEvidence: { processCleanup: { trackedPids: [88], trackedProcesses: [row(88)] } } });
  assert.equal((await f.check([row(88, { parentPid: 1 })])).ready, false);
  assert.equal((await f.check([row(88, { parentPid: 1, creationKey: 'windows:638712864000000010' })])).ready, true);
});
test('missing ownership, incomplete inventory and unreadable JSON fail closed', async t => {
  const f = await fixture(t); await f.write('jobs/job.json', { status: 'queued' });
  assert.equal((await f.check()).activeJobs[0].ownership, 'unknown');
  assert.match((await f.check([], { inventory: { complete: false, processes: [] } })).reason, /inventory/);
  await fs.writeFile(path.join(f.stateRoot, 'jobs/job.json'), '{');
  assert.equal((await f.check()).ready, false);
  assert.equal((await checkReadiness({ installRoot: f.installRoot, inventory: async () => { throw Error('CIM denied'); } })).reason, 'CIM denied');
});
test('Gateway entry matching excludes monitor worker, eval and unrelated Node', async t => {
  const f = await fixture(t), entry = path.join(f.installRoot, 'dist/src/index.js');
  const nodes = [
    row(11, { imageName: 'node.exe', commandLine: `"C:\\node.exe" "${entry}"` }),
    row(12, { imageName: 'node.exe', commandLine: `node.exe worker.js "${entry}"` }),
    row(13, { imageName: 'node.exe', commandLine: `node.exe -e "console.log('${entry.replaceAll('\\', '/')}')"` }),
    row(14, { imageName: 'node.exe', commandLine: 'node.exe other.js' })
  ];
  const value = await f.check(nodes, { platform: 'win32' }); assert.equal(value.ready, true); assert.deepEqual(value.gatewayPids, [11]);
});
test('actual Linux entry argv and cwd identify relative Gateway script', async t => {
  const f = await fixture(t);
  const value = await f.check([row(11, { imageName: 'node', args: ['/usr/bin/node', 'dist/src/index.js'], cwd: f.installRoot })], { platform: 'linux' });
  assert.equal(value.ready, true); assert.deepEqual(value.gatewayPids, [11]);
});
test('nonstandard entry-bearing Node flags fail closed instead of missing a Gateway', async t => {
  const f = await fixture(t), entry = path.join(f.installRoot, 'dist/src/index.js');
  const value = await f.check([row(11, { imageName: 'node', args: ['node', '--no-warnings', entry] })]);
  assert.equal(value.ready, false); assert.match(value.reason, /Unrecognized Gateway invocation/);
});
test('Linux Node24 MainThread comm is resolved through its executable, unknown birth inspection blocks', async t => {
  const f = await fixture(t), entry = path.join(f.installRoot, 'dist/src/index.js');
  let value = await f.check([row(11, { imageName: 'MainThread', executablePath: '/usr/bin/node', args: ['/usr/bin/node', entry] })], { platform: 'linux' });
  assert.equal(value.ready, true); assert.deepEqual(value.gatewayPids, [11]);
  value = await f.check([row(11, { imageName: 'MainThread', executablePath: null })], { platform: 'linux' });
  assert.equal(value.ready, false); assert.match(value.reason, /runtime/);
});
test('provider children block before job record exists; reused PPID older child is excluded', async t => {
  const f = await fixture(t), gateway = row(11, { imageName: 'node', args: ['node', path.join(f.installRoot, 'dist/src/index.js')] });
  let value = await f.check([gateway, row(12, { parentPid: 11, createdAt: start })]);
  assert.equal(value.ready, false); assert.equal(value.activeOperations[0].status, 'provider_or_cli_activity');
  value = await f.check([gateway, row(12, { parentPid: 11, createdAt: '2025-12-31T23:59:00Z' })]); assert.equal(value.ready, true);
});
test('live maintenance operations block; absent owners preserve stale operation records', async t => {
  const f = await fixture(t); const file = await f.write('operations/op.json', { operation_id: 'op', status: 'running', ownerPid: 55, startedAt: start, ownerStartedAt: '638712864000000008' });
  assert.equal((await f.check([row(55)])).ready, false);
  assert.equal((await f.check([row(55, { creationKey: 'windows:638712864000000010' })])).ready, true);
  assert.equal((await f.check()).ready, true); assert.ok(await fs.stat(file));
});
test('maintenance lease and Linux updater locks block without changing them', async t => {
  const f = await fixture(t); const lock = await f.write('jobs/job.json.cleanup.lock', { ownerPid: 55, ownerCreationKey: 'windows:638712864000000000', ownerCreatedAt: birth, expiresAt: start });
  assert.equal((await f.check([row(55)])).ready, false);
  assert.equal((await f.check()).ready, true); assert.ok(await fs.stat(lock));
  await f.write('update.lock', { pid: 999, identity: 'linux:00000000-0000-0000-0000-000000000000:1:1000' });
  const value = await f.check(); assert.equal(value.ready, false); assert.equal(value.activeOperations[0].status, 'update_lock_requires_release');
});
test('unfinished update transactions block and restored transactions pass', async t => {
  const f = await fixture(t); await f.write('updates/transactions/tx.json', { id: 'tx', status: 'failed', recovery: 'failed' });
  assert.equal((await f.check()).ready, false);
  await f.write('updates/transactions/tx.json', { id: 'tx', status: 'failed', recovery: 'restored' });
  assert.equal((await f.check()).ready, true);
});
test('pre-launch updater record and partial state writes block before update lock exists', async t => {
  const f = await fixture(t); await f.write('updates/operations/update.json', { operationId: 'update', status: 'starting' });
  assert.equal((await f.check()).activeOperations[0].status, 'update_in_progress');
  await f.write('updates/operations/update.json', { operationId: 'update', status: 'installed' });
  await f.write('jobs/new.json.temp.tmp', {});
  const value = await f.check(); assert.equal(value.ready, false); assert.match(value.reason, /being written/);
});
test('large active summaries stay bounded while preserving readiness decision and counts', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 30; i++) await f.write(`jobs/${i}.json`, { job_id: String(i), status: 'running', ownerPid: 55, startedAt: start });
  const value = await f.check([row(55)]); assert.equal(value.ready, false); assert.equal(value.activeJobsCount, 30); assert.equal(value.activeJobs.length, 25); assert.equal(value.truncated, true);
});
test('fresh Linux registry busy state blocks, stale process generations are ignored', async t => {
  const f = await fixture(t), key = 'linux:00000000-0000-0000-0000-000000000000:10:1000';
  await f.write('gateways/55.json', { pid: 55, startIdentity: key, installRoot: f.installRoot, stateRoot: f.stateRoot, updatedAt: new Date().toISOString(), idle: false });
  let value = await f.check([row(55, { startIdentity: key })]); assert.equal(value.ready, false); assert.deepEqual(value.gatewayPids, [55]);
  value = await f.check([row(55, { startIdentity: key.replace(':10:', ':11:') })]); assert.equal(value.ready, true);
});
test('installation receipt supplies state location when no explicit path was passed', async t => {
  const f = await fixture(t); await f.write('agent-acp-installation.json', { schemaVersion: 1, stateRoot: f.stateRoot }, f.installRoot);
  await f.write('jobs/job.json', { status: 'running', ownerPid: 55, startedAt: start });
  assert.equal((await f.check([row(55)], { stateRoot: undefined })).ready, false);
});
test('symlink and junction state roots fail closed without following or changing target', async t => {
  const f = await fixture(t), link = path.join(f.root, 'state link');
  await fs.symlink(f.stateRoot, link, process.platform === 'win32' ? 'junction' : 'dir');
  const value = await f.check([], { stateRoot: link }); assert.equal(value.ready, false); assert.match(value.reason, /traverses a link/);
  assert.deepEqual(await fs.readdir(f.stateRoot), []);
});
test('standalone node -e uses argv[1] and returns one JSON result', { timeout: 30000 }, async t => {
  const f = await fixture(t), source = await fs.readFile(new URL('../update/readiness.cjs', import.meta.url), 'utf8');
  const { stdout } = await execute(process.execPath, ['-e', source, f.installRoot, f.stateRoot], { windowsHide: true, timeout: 25000 });
  const value = JSON.parse(stdout); assert.equal(typeof value.ready, 'boolean'); assert.ok(Array.isArray(value.gatewayPids));
  // Other inaccessible Node processes on the machine may legitimately block.
  if (!value.ready) assert.equal(typeof value.reason, 'string');
});
test('native process inventory detects a real active fixture then observes its exit', { timeout: 30000 }, async t => {
  const f = await fixture(t), entry = path.join(f.installRoot, 'dist/src/index.js');
  await fs.mkdir(path.dirname(entry), { recursive: true }); await fs.writeFile(entry, "process.stdout.write('ready\\n');setInterval(()=>{},1000);");
  const child = spawn(process.execPath, [entry], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => { if (child.exitCode === null) child.kill(); await exit; });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
  await f.write('jobs/live.json', { job_id: 'live', status: 'running', ownerPid: child.pid, startedAt: new Date().toISOString() });
  const active = await checkReadiness({ installRoot: f.installRoot, stateRoot: f.stateRoot });
  assert.equal(active.ready, false);
  if (active.activeJobs.length) { assert.equal(active.activeJobs[0].ownerPid, child.pid); assert.ok(active.gatewayPids.includes(child.pid)); }
  else assert.match(active.reason, /Cannot inspect Node process/);
  child.kill(); await exit;
  const stopped = await checkReadiness({ installRoot: f.installRoot, stateRoot: f.stateRoot });
  assert.equal(stopped.activeJobs.length, 0); assert.equal(stopped.gatewayPids.includes(child.pid), false);
});
