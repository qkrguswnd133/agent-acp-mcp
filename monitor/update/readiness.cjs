'use strict';

// Read-only preflight, deliberately self-contained so the same source can be
// passed to WSL's registered Node with `node -e <source> <install> <state>`.
// This is an observation, not an update lock. Installers still perform their
// maintenance handshake immediately before replacing any installed files.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const ACTIVE = new Set(['queued', 'running', 'cancelling']);
const FINISHED = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const execute = (file, args) => new Promise((resolve, reject) => execFile(file, args,
  { windowsHide: true, timeout: 10000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
  (error, stdout) => error ? reject(error) : resolve(stdout)));
const validPid = value => Number.isSafeInteger(value) && value > 0;
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

async function readInventory(platform) {
  if (platform === 'win32') {
    const script = "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);@(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,@{n='createdAt';e={if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}}},@{n='creationKey';e={if($_.CreationDate){'windows:'+$_.CreationDate.ToUniversalTime().Ticks.ToString()}}}) | ConvertTo-Json -Compress";
    const value = JSON.parse((await execute(path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script])).replace(/^\uFEFF/, ''));
    return { complete: true, processes: (Array.isArray(value) ? value : [value]).map(row => ({
      pid: row.ProcessId, parentPid: row.ParentProcessId, imageName: row.Name,
      executablePath: row.ExecutablePath, commandLine: row.CommandLine,
      createdAt: row.createdAt || null, creationKey: row.creationKey || null
    })) };
  }
  if (platform !== 'linux') throw Error('Update readiness is unsupported on this platform');
  const [bootText, stat, hzText, names] = await Promise.all([
    fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8'), fs.readFile('/proc/stat', 'utf8'),
    execute('getconf', ['CLK_TCK']), fs.readdir('/proc')
  ]);
  const boot = bootText.trim(), bootSeconds = Number(/^btime\s+(\d+)$/m.exec(stat)?.[1]), hz = Number(hzText.trim());
  if (!/^[a-f0-9-]{36}$/i.test(boot) || !Number.isSafeInteger(bootSeconds) || !Number.isSafeInteger(hz) || hz <= 0) throw Error('Linux process creation clock is unavailable');
  const pids = names.filter(name => /^\d+$/.test(name)), processes = [];
  if (pids.length > 50000) throw Error('Process inventory exceeds the safe inspection limit');
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(16, pids.length) }, async () => {
    while (cursor < pids.length) {
      const name = pids[cursor++], pid = Number(name), base = '/proc/' + name;
      try {
        const text = await fs.readFile(base + '/stat', 'utf8'), end = text.lastIndexOf(')'), fields = text.slice(end + 1).trim().split(/\s+/);
        if (!text.startsWith(name + ' (') || !/^\d+$/.test(fields[1] || '') || !/^\d+$/.test(fields[19] || '')) throw Error('Invalid Linux process identity');
        const [cmd, cwd, status, executablePath] = await Promise.all([
          fs.readFile(base + '/cmdline', 'utf8').catch(() => null), fs.readlink(base + '/cwd').catch(() => null), fs.readFile(base + '/status', 'utf8').catch(() => ''), fs.readlink(base + '/exe').catch(() => null)
        ]);
        const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
        processes.push({ pid, parentPid: Number(fields[1]), imageName: text.slice(text.indexOf('(') + 1, end),
          args: cmd === null ? null : cmd.split('\0').filter(Boolean), cwd, executablePath, uid: uid === undefined ? null : Number(uid),
          createdAt: new Date(bootSeconds * 1000 + Number(fields[19]) / hz * 1000).toISOString(),
          creationKey: `linux:${boot}:${fields[19]}`, startIdentity: uid === undefined ? null : `linux:${boot}:${fields[19]}:${uid}` });
      } catch (error) {
        if (!['ENOENT', 'ESRCH'].includes(error.code)) processes.push({ pid, parentPid: null, imageName: null, createdAt: null, creationKey: null });
      }
    }
  }));
  return { complete: true, processes };
}

// Windows CLI quoting, including backslashes immediately before a quote.
function windowsArgs(command) {
  const args = []; let word = '', quoted = false, started = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (/\s/.test(char) && !quoted) { if (started) { args.push(word); word = ''; started = false; } continue; }
    if (char === '\\') {
      let end = i; while (command[end] === '\\') end++;
      const count = end - i;
      if (command[end] === '"') { word += '\\'.repeat(Math.floor(count / 2)); if (count % 2) word += '"'; else quoted = !quoted; i = end; }
      else { word += '\\'.repeat(count); i = end - 1; }
    } else if (char === '"') quoted = !quoted;
    else word += char;
    started = true;
  }
  if (quoted) return null;
  if (started) args.push(word);
  return args;
}

function identity(row, recorded) {
  if (!row) return 'absent';
  const key = recorded.ownerCreationKey || recorded.creationKey || recorded.startIdentity || recorded.ownerStartedAt || recorded.identity;
  if (typeof key === 'string') {
    const normalized = /^\d{15,20}$/.test(key) ? 'windows:' + key : key;
    let current = normalized.startsWith('linux:') && normalized.split(':').length === 4 ? row.startIdentity : row.creationKey;
    if (typeof current !== 'string') return 'unknown';
    if (/^windows:\d{15,20}$/.test(current) && /^windows:\d{15,20}$/.test(normalized)) {
      const observed = BigInt(current.slice(8)), original = BigInt(normalized.slice(8));
      return observed === original || (observed % 10n === 0n && observed === original / 10n * 10n) ? 'alive' : 'reused';
    }
    return current === normalized ? 'alive' : 'reused';
  }
  const created = time(recorded.ownerCreatedAt || recorded.createdAt);
  if (created !== null) return time(row.createdAt) === null ? 'unknown' : time(row.createdAt) === created ? 'alive' : 'reused';
  const started = time(recorded.startedAt);
  if (started === null || time(row.createdAt) === null) return 'unknown';
  // Older job records have no owner birth identity. An owner created after
  // the job cannot own it; an earlier live process is conservatively blocking.
  return time(row.createdAt) > started ? 'reused' : 'alive';
}

async function checkReadiness(options = {}) {
  const result = { ready: false, activeJobs: [], activeOperations: [], gatewayPids: [] };
  const present = () => {
    for (const key of ['activeJobs', 'activeOperations', 'gatewayPids']) {
      if (result[key].length > 25) { result[key + 'Count'] = result[key].length; result[key] = result[key].slice(0, 25); result.truncated = true; }
    }
    for (const item of [...result.activeJobs, ...result.activeOperations]) {
      if (item.childPids?.length > 25) { item.childPidCount = item.childPids.length; item.childPids = item.childPids.slice(0, 25); result.truncated = true; }
    }
    return result;
  };
  const deadline = Date.now() + 20000;
  let inspected = 0;
  const bounded = () => { if (++inspected > 12000 || Date.now() > deadline) throw Error('Readiness inspection limit reached; finish work and retry'); };
  try {
    if (typeof options.installRoot !== 'string' || !path.isAbsolute(options.installRoot)) throw Error('An absolute Gateway installation path is required');
    const platform = options.platform || process.platform;
    const installRoot = path.resolve(options.installRoot);
    const normalize = value => { const normalized = path.normalize(value).replace(/\\/g, '/'); return platform === 'win32' ? normalized.toLowerCase() : normalized; };
    const safePath = async file => {
      let current = path.parse(path.resolve(file)).root;
      for (const part of path.resolve(file).slice(current.length).split(path.sep).filter(Boolean)) {
        bounded(); current = path.join(current, part);
        try { if ((await fs.lstat(current)).isSymbolicLink()) throw Error('Readiness path traverses a link: ' + current); }
        catch (error) { if (error.code === 'ENOENT') return; throw error; }
      }
    };
    const json = async (file, optional = false) => {
      bounded(); await safePath(file);
      let before; try { before = await fs.lstat(file); } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
      if (!before.isFile() || before.size > 4 * 1024 * 1024) throw Error('Unsafe or oversized readiness record: ' + file);
      const handle = await fs.open(file, 'r');
      try {
        const opened = await handle.stat();
        if (before.ino !== opened.ino || before.dev !== opened.dev || before.size !== opened.size) throw Error('Readiness record changed while opening: ' + file);
        const value = JSON.parse((await handle.readFile('utf8')).replace(/^\uFEFF/, ''));
        const after = await handle.stat();
        if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw Error('Readiness record is being written: ' + file);
        return value;
      } finally { await handle.close(); }
    };
    const list = async directory => {
      await safePath(directory); bounded();
      try { const names = await fs.readdir(directory, { withFileTypes: true }); if (names.length > 10000) throw Error('Too many readiness records: ' + directory); return names; }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    };
    await safePath(installRoot);
    if (!(await fs.lstat(installRoot)).isDirectory()) throw Error('Gateway installation is not a directory');
    const location = options.stateRoot ? null : await json(path.join(installRoot, 'agent-acp-installation.json'), true);
    if (location && (location.schemaVersion !== 1 || typeof location.stateRoot !== 'string')) throw Error('Invalid Gateway installation state location');
    const configured = options.stateRoot || location?.stateRoot || path.join(installRoot, 'state');
    if (typeof configured !== 'string' || !path.isAbsolute(configured)) throw Error('An absolute Gateway state path is required');
    const stateRoot = path.resolve(configured); await safePath(stateRoot);
    const inventory = typeof options.inventory === 'function' ? await options.inventory() : options.inventory || await readInventory(platform);
    if (inventory?.complete !== true || !Array.isArray(inventory.processes) || inventory.processes.length > 50000) throw Error('Complete process inventory is unavailable');
    const rows = inventory.processes, byPid = new Map();
    for (const row of rows) {
      if (!Number.isSafeInteger(row?.pid) || row.pid < 0 || byPid.has(row.pid)) throw Error('Invalid process inventory');
      byPid.set(row.pid, row);
    }
    const entry = normalize(path.join(installRoot, 'dist/src/index.js'));
    for (const row of rows) {
      if (row.imageName === null && row.createdAt === null) throw Error('Cannot identify process ' + row.pid);
      // Node24 Linux uses `MainThread` for /proc comm. The executable symlink
      // is authoritative for the runtime; comm alone would miss an old Gateway.
      const runtime = row.executablePath ? path.basename(row.executablePath) : row.imageName;
      if (!row.executablePath && row.imageName === 'MainThread') throw Error('Cannot identify Node runtime for PID ' + row.pid);
      if (!/^node(?:\.exe)?$/i.test(runtime || '')) continue;
      const args = row.args || (typeof row.commandLine === 'string' ? windowsArgs(row.commandLine) : null);
      if (!args) throw Error('Cannot inspect Node process ' + row.pid);
      // A monitor worker, `node -e`, or another Node program merely mentioning
      // this entry is never classified as the Gateway.
      if (args.length < 2) continue;
      if (args[1].startsWith('-')) {
        // Do not silently assume an unusual, entry-bearing Node launch is
        // idle. Eval/print are different programs even when passed our path.
        if (!['-e', '--eval', '-p', '--print'].includes(args[1]) && args.slice(2).some(arg => !arg.startsWith('-') && normalize(path.isAbsolute(arg) ? arg : path.resolve(row.cwd || '.', arg)) === entry)) throw Error('Unrecognized Gateway invocation for PID ' + row.pid + '; disconnect MCP before updating');
        continue;
      }
      const script = path.isAbsolute(args[1]) ? args[1] : row.cwd ? path.resolve(row.cwd, args[1]) : null;
      if (!script) { if (args[1].replace(/\\/g, '/').endsWith('dist/src/index.js')) throw Error('Cannot resolve Gateway working directory for PID ' + row.pid); continue; }
      if (normalize(script) === entry) result.gatewayPids.push(row.pid);
    }
    const children = (ownerPid, ownerRow, startedAt) => rows.filter(row => {
      if (row.parentPid !== ownerPid || row.pid === ownerPid) return false;
      if (ownerRow && time(ownerRow.createdAt) !== null && time(row.createdAt) !== null && time(row.createdAt) < time(ownerRow.createdAt)) return false;
      if (!ownerRow && time(startedAt) !== null && time(row.createdAt) !== null && time(row.createdAt) < time(startedAt)) return false;
      // A leaf system console host has no provider work of its own.
      const console = platform === 'win32' && /^conhost\.exe$/i.test(row.imageName || '') && typeof row.executablePath === 'string' && normalize(row.executablePath) === normalize(path.join(process.env.SystemRoot || 'C:/Windows', 'System32/conhost.exe'));
      return !(console && !rows.some(child => child.parentPid === row.pid));
    });
    const ownerState = record => {
      const pid = record.ownerPid ?? record.pid;
      if (!validPid(pid)) return { state: 'unknown', pid };
      const row = byPid.get(pid), state = identity(row, record);
      // Once an owner is reused, older children may still hold its old PPID.
      // Preserve these conservatively; never infer idleness from PID alone.
      const owned = children(pid, state === 'alive' ? row : null, record.startedAt);
      const cleanup = record.runtimeEvidence?.processCleanup;
      if (cleanup) {
        // Orphaned provider processes can be reparented on Linux. Include
        // recorded children even if their current PPID no longer names us.
        if (cleanup.truncated === true || cleanup.trackedPidCount > (cleanup.trackedPids?.length || 0)) return { state: 'unknown', pid, children: owned.map(child => child.pid) };
        for (const tracked of cleanup.trackedPids || []) {
          if (!validPid(tracked)) return { state: 'unknown', pid, children: [] };
          const current = byPid.get(tracked);
          if (!current) continue;
          const saved = cleanup.trackedProcesses?.find(item => item.pid === tracked);
          if (saved && identity(current, saved) === 'reused') continue;
          if (!owned.some(child => child.pid === tracked)) owned.push(current);
        }
      }
      return { state, pid, children: owned.map(child => child.pid) };
    };
    const checkActive = (record, target, kind, file) => {
      if (!record || typeof record.status !== 'string') throw Error('Invalid ' + kind + ' record: ' + file);
      if (FINISHED.has(record.status)) return;
      if (!ACTIVE.has(record.status)) throw Error('Unrecognized ' + kind + ' status: ' + file);
      const owner = ownerState(record);
      if (['absent', 'reused'].includes(owner.state) && !owner.children?.length) return;
      target.push({ id: record.job_id || record.operation_id || path.basename(file), status: record.status, ownerPid: owner.pid ?? null, ownership: owner.state, childPids: owner.children || [] });
    };
    const scanRecords = async (directory, target, kind) => {
      for (const item of await list(directory)) {
        bounded(); const file = path.join(directory, item.name);
        if (item.isSymbolicLink()) throw Error('Unsafe linked ' + kind + ' record: ' + file);
        if (item.isDirectory()) continue;
        if (item.name.endsWith('.json')) checkActive(await json(file), target, kind, file);
        else if (item.name.endsWith('.cleanup.lock')) {
          const lock = await json(file), owner = ownerState(lock);
          if (!['absent', 'reused'].includes(owner.state) || owner.children?.length) result.activeOperations.push({ id: item.name, status: 'maintenance_lock', ownerPid: owner.pid ?? null, ownership: owner.state });
        } else if (item.name.endsWith('.tmp')) throw Error('Gateway state is being written: ' + file);
      }
    };
    await scanRecords(path.join(stateRoot, 'jobs'), result.activeJobs, 'job');
    await scanRecords(path.join(stateRoot, 'operations'), result.activeOperations, 'maintenance operation');
    // Linux discovery covers nonstandard Node invocation flags. Only a matching
    // generation can contribute; stale registry files never imply live work.
    for (const item of await list(path.join(stateRoot, 'gateways'))) {
      if (item.isSymbolicLink()) throw Error('Unsafe Gateway registry record');
      if (!/^\d+\.json$/.test(item.name)) { if (item.name.endsWith('.tmp')) throw Error('Gateway registry is being written'); continue; }
      const record = await json(path.join(stateRoot, 'gateways', item.name));
      if (normalize(record.installRoot || '') !== normalize(installRoot)) continue;
      const owner = ownerState(record);
      if (owner.state === 'unknown') throw Error('Gateway registry ownership is unknown for PID ' + record.pid);
      if (owner.state !== 'alive') continue;
      if (!result.gatewayPids.includes(record.pid)) result.gatewayPids.push(record.pid);
      if (record.idle !== true || time(record.updatedAt) === null || Date.now() - time(record.updatedAt) > 5000) result.activeOperations.push({ id: 'gateway:' + record.pid, status: 'gateway_busy_or_unconfirmed', ownerPid: record.pid });
    }
    for (const pid of result.gatewayPids) {
      const row = byPid.get(pid);
      if (time(row?.createdAt) === null) throw Error('Gateway process birth is unknown for PID ' + pid);
      const owned = children(pid, row);
      if (owned.length) result.activeOperations.push({ id: 'gateway:' + pid, status: 'provider_or_cli_activity', ownerPid: pid, childPids: owned.map(child => child.pid) });
    }
    const maintenance = await json(installRoot + '.maintenance.json', true);
    if (maintenance) {
      const owner = ownerState(maintenance);
      if (!['absent', 'reused'].includes(owner.state) || owner.children?.length) result.activeOperations.push({ id: maintenance.operationId || 'maintenance', status: 'update_maintenance', ownerPid: owner.pid ?? null, ownership: owner.state });
    }
    const updateLock = await json(path.join(stateRoot, 'update.lock'), true);
    if (updateLock) result.activeOperations.push({ id: 'update.lock', status: 'update_lock_requires_release', ownerPid: updateLock.pid ?? null, ownership: ownerState(updateLock).state });
    for (const item of await list(path.join(stateRoot, 'updates', 'operations'))) {
      if (item.isSymbolicLink()) throw Error('Unsafe update operation');
      if (!item.name.endsWith('.json')) continue;
      const operation = await json(path.join(stateRoot, 'updates', 'operations', item.name));
      if (['starting', 'started', 'running'].includes(operation.status)) {
        const owner = ownerState(operation);
        if (!['absent', 'reused'].includes(owner.state) || owner.children?.length) result.activeOperations.push({ id: operation.operationId || item.name, status: 'update_in_progress', ownerPid: owner.pid ?? null, ownership: owner.state });
      }
    }
    for (const item of await list(path.join(stateRoot, 'updates', 'transactions'))) {
      if (item.isSymbolicLink()) throw Error('Unsafe update transaction');
      if (!item.name.endsWith('.json')) continue;
      const tx = await json(path.join(stateRoot, 'updates', 'transactions', item.name));
      if (!(['installed', 'rolled_back'].includes(tx.status) || (tx.status === 'failed' && ['restored', 'not_needed'].includes(tx.recovery)))) result.activeOperations.push({ id: tx.id || item.name, status: 'update_recovery_required' });
    }
    result.ready = !result.activeJobs.length && !result.activeOperations.length;
    if (!result.ready) result.reason = result.activeJobs.length ? 'Gateway has active or unconfirmed jobs; finish them before updating' : 'Gateway has active maintenance, provider activity or an unresolved update; finish it before updating';
    return present();
  } catch (error) {
    result.reason = error instanceof Error ? error.message : String(error);
    return present();
  }
}

module.exports = { checkReadiness };
if (require.main === module || !process.argv[0] || (process.argv.length >= 2 && typeof __filename === 'string' && __filename === '[eval]')) {
  const evaluated = typeof __filename === 'string' && __filename === '[eval]';
  checkReadiness({ installRoot: process.argv[evaluated ? 1 : 2], stateRoot: process.argv[evaluated ? 2 : 3] || undefined })
    .then(value => process.stdout.write(JSON.stringify(value) + '\n'));
}
