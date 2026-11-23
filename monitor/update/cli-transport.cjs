'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const {promisify} = require('node:util');
const exec = promisify(require('node:child_process').execFile);
const {findNode} = require('./service.cjs');
const {distroNames, parseOutput} = require('./wsl.cjs');

async function distributions(runningOnly = false) {
  const args = runningOnly ? ['--list','--running','--quiet'] : ['--list','--quiet'];
  const {stdout} = await exec('wsl.exe', args, {windowsHide:true, timeout:8000, encoding:'buffer'});
  return distroNames(stdout);
}

async function discover() {
  const windows = {id:'windows', name:'Windows', running:true};
  let names;
  try { names = await distributions(); } catch { return [windows]; }
  let running = [];
  try { running = await distributions(true); } catch { /* Require explicit start. */ }
  return [windows, ...names.map(name => ({id:'wsl:'+name, name:'WSL · '+name, running:running.includes(name)}))];
}

function createTransport(monitorDirectory) {
  const configFile = path.join(monitorDirectory,'agent-monitor.config.json');
  return async function command(id, args, {start=false, updating=false}={}) {
    let file, argv, env;
    if (id === 'windows') {
      const {loadMonitorEnvironment} = await import('../backend/monitor.mjs');
      const config = await loadMonitorEnvironment({configFile,env:{...process.env}});
      file = await findNode(configFile);
      if (!file) throw Error('Monitor 설정에서 Node.js 실행 경로를 확인하세요.');
      const entry = path.join(config.gatewayRoot,'dist','src','cli-update-command.js');
      try { await fs.access(entry); } catch { throw Error('CLI 관리 기능을 포함한 Windows Gateway를 먼저 업데이트하세요.'); }
      env = config.env;
      argv = [entry,...args,'--json'];
    } else {
      const distro = id.slice(4);
      if (!id.startsWith('wsl:') || !(await distributions(!start)).includes(distro))
        throw Error('WSL이 중지되었거나 목록에서 사라졌습니다. 시작하고 확인을 선택하세요.');
      file = 'wsl.exe';
      // Positional arguments are forwarded without shell interpolation.
      argv = ['--distribution',distro,'--exec','sh','-c','exec "$HOME/.local/bin/agent-acp" cli "$@"','agent-acp',...args,'--json'];
    }
    let stdout;
    try {
      ({stdout} = await exec(file, argv, {env, windowsHide:true, timeout:updating?0:90000, maxBuffer:1024*1024, encoding:'buffer'}));
    } catch (error) {
      try {
        const result = parseOutput(error.stdout);
        if (Array.isArray(result.rows) && result.rows.length) return result;
      } catch { /* Do not expose raw output or arguments. */ }
      throw Error('CLI 관리 명령을 완료하지 못했습니다. Gateway 버전과 실행 권한을 확인하세요.');
    }
    const result = parseOutput(stdout);
    if (!Array.isArray(result.rows)) throw Error('CLI 관리 기능을 지원하는 Gateway가 필요합니다.');
    return result;
  };
}
module.exports = {createTransport,discover};

