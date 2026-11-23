// Opt-in Windows integration check. Requires a packaged Monitor, compiled Gateway,
// network access to npm, and a historical official Claude Code npm version.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';

const exec=promisify(execFile);
const repo=fileURLToPath(new URL('../',import.meta.url));
const [from,npmCli]=process.argv.slice(2);
if(process.platform!=='win32'||!/^\d+\.\d+\.\d+$/.test(from)||!path.isAbsolute(npmCli??''))throw Error('Usage on Windows: node tests/Smoke-Monitor-Cli.mjs <older-version> <absolute npm-cli.js>');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'agent-monitor-cli-e2e-'));
const home=path.join(root,'home'), data=path.join(root,'data'), prefix=path.join(home,'npm');
const monitor=path.join(root,'monitor'),gateway=path.join(root,'gateway');
const selected=path.join(prefix,'claude.cmd');
const env={...process.env,USERPROFILE:home,HOME:home,APPDATA:path.join(home,'roaming'),LOCALAPPDATA:path.join(home,'local'),
  CLAUDE_CONFIG_DIR:path.join(home,'.claude'),CODEX_HOME:path.join(home,'.codex'),AGENT_MCP_STATE_DIR:path.join(home,'state'),
  AGENT_GATEWAY_ROOT:gateway,CLAUDE_CLI:selected,CODEX_CLI:path.join(home,'missing-codex'),GROK_CLI:path.join(home,'missing-grok'),
  PATH:[path.dirname(process.execPath),prefix,process.env.SystemRoot,path.join(process.env.SystemRoot,'System32')].join(';'),
  npm_config_cache:path.join(home,'npm-cache'),CLAUDE_ENABLED:'false',CODEX_ENABLED:'false',GROK_ENABLED:'false'};
delete env.ELECTRON_RUN_AS_NODE;
try{
  await Promise.all([home,prefix,env.APPDATA,env.LOCALAPPDATA].map(d=>fs.mkdir(d,{recursive:true})));
  await exec(process.execPath,[npmCli,'install','--global','--prefix',prefix,'--no-fund','--no-audit','--registry=https://registry.npmjs.org','@anthropic-ai/claude-code@'+from],{env,cwd:home,timeout:180000});
  await fs.cp(path.join(repo,'monitor/release/Agent Monitor-win32-x64'),monitor,{recursive:true});
  for(const item of ['dist/src','package.json','node_modules'])await fs.cp(path.join(repo,'gateway',item),path.join(gateway,item),{recursive:true});
  await fs.writeFile(path.join(monitor,'agent-monitor.config.json'),JSON.stringify({gatewayRoot:gateway,nodeExecutable:process.execPath}));
  const asar=await import(pathToFileURL(createRequire(path.join(repo,'monitor/package.json')).resolve('@electron/asar')).href);
  const archive=path.join(monitor,'resources/app.asar'),extracted=path.join(root,'app');
  asar.extractAll(archive,extracted);
  const main=path.join(extracted,'main.cjs');
  let source=(await fs.readFile(main,'utf8')).replaceAll('\r\n','\n');
  // Replace only discovery of other environments and updates of the Monitor itself.
  source=source.replace('stateDir,monitorDirectory,\n  ...(smoke','stateDir,monitorDirectory,listTargets:async()=>[{id:"windows",name:"Windows",running:true}],\n  ...(smoke')
    .replace("platform:smoke||verifyLive?'disabled':process.platform","platform:'disabled'")
    .replace('function checkUpdates(force=false){','function checkUpdates(force=false){return Promise.resolve();');
  const headlessRun=async function(){
    const wait=async test=>{
      const until=Date.now()+150000;
      while(Date.now()<until){const value=await test();if(value)return value;await new Promise(r=>setTimeout(r,150));}
      throw Error('Timed out: '+JSON.stringify(cliUpdates.snapshot()));
    };
    await wait(()=>bar?.isVisible()&&!bar.webContents.isLoading()&&cliUpdates.snapshot().targets.some(t=>t.rows.length));
    const offers=cliUpdates.snapshot().targets.flatMap(t=>t.rows.filter(r=>r.status==='available'));
    if(offers.length!==1||offers[0].path!==process.env.CLAUDE_CLI)throw Error('Fixture target mismatch: '+JSON.stringify(offers));
    await wait(()=>bar.webContents.executeJavaScript("!document.querySelector('#cli-updates').hidden && !document.querySelector('#cli-updates').disabled"));
    await bar.webContents.executeJavaScript("document.querySelector('#cli-updates').click()");
    const row=await wait(()=>cliUpdates.snapshot().targets[0]?.rows.find(r=>['updated','blocked','error'].includes(r.status)&&r.provider==='claude'));
    if(row.status!=='updated'||row.currentVersion!==offers[0].latestVersion)throw Error('CLI update failed: '+JSON.stringify(row));
    fs.writeFileSync(path.join(stateDir,'proof.json'),JSON.stringify({before:offers[0].currentVersion,after:row.currentVersion,path:row.path}));
    app.quit();
  };
  source+='\napp.whenReady().then('+headlessRun.toString()+').catch(e=>{console.error(e);app.exit(1)});\n';
  await fs.writeFile(main,source);await fs.unlink(archive);await asar.createPackage(extracted,archive);
  await exec(path.join(monitor,'Agent Monitor.exe'),['--data-dir='+data],{env,cwd:home,timeout:200000});
  const proof=JSON.parse(await fs.readFile(path.join(data,'proof.json')));
  assert.equal(proof.before,from);assert.equal(proof.path,selected);
  const queried=JSON.parse((await exec(process.execPath,[path.join(gateway,'dist/src/cli-update-command.js'),'list','--json'],{env,cwd:home})).stdout).rows.find(r=>r.provider==='claude');
  assert.equal(queried.path,selected);assert.equal(queried.currentVersion,proof.after);
  console.log('PACKAGED_CLI_BAR_OK',proof.before,'→',proof.after);
  await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:250});
}catch(error){
  console.error('Isolated installation retained for diagnosis:',root);
  throw error;
}

