/** Opt-in integration smoke with official npm releases. Uses a disposable user home,
 * global prefix, package cache, and a fresh Gateway resolver. Never run on startup. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [provider,fromVersion,npmCli]=process.argv.slice(2);
const packages={codex:'@openai/codex',claude:'@anthropic-ai/claude-code',grok:'@xai-official/grok'};
if(!Object.hasOwn(packages,provider)||!/^\d+\.\d+\.\d+$/.test(fromVersion)||!npmCli||!path.isAbsolute(npmCli)){
 throw Error('Usage: node tests/smoke-provider-update.mjs <provider> <old-version> <absolute npm-cli.js>');
}
const windows=process.platform==='win32';
const tempRoot=os.tmpdir(),root=mkdtempSync(path.join(tempRoot,'agent-cli-update-smoke-'));
try{
 const home=path.join(root,'home'),prefix=path.join(root,'prefix'),cache=path.join(root,'cache');
 mkdirSync(home);mkdirSync(prefix);
 const selected=path.join(prefix,windows?provider+'.cmd':'bin/'+provider);
 Object.assign(process.env,{
  HOME:home,USERPROFILE:home,CLAUDE_CONFIG_DIR:path.join(home,'.claude'),CODEX_HOME:path.join(home,'.codex'),GROK_HOME:path.join(home,'.grok'),
  AGENT_MCP_STATE_DIR:path.join(home,'state'),XDG_CONFIG_HOME:path.join(home,'.config'),XDG_CACHE_HOME:cache,XDG_DATA_HOME:path.join(home,'.local/share'),
  [provider.toUpperCase()+'_CLI']:selected,CI:'1',npm_config_cache:cache
 });
 if(windows){
  process.env.APPDATA=path.join(home,'AppData/Roaming');process.env.LOCALAPPDATA=path.join(home,'AppData/Local');
  mkdirSync(process.env.APPDATA,{recursive:true});mkdirSync(process.env.LOCALAPPDATA,{recursive:true});
 }
 execFileSync(process.execPath,[npmCli,'install','--global','--prefix',prefix,'--registry=https://registry.npmjs.org','--no-audit','--no-fund',packages[provider]+'@'+fromVersion],{cwd:home,timeout:240000,stdio:'inherit'});
 const {inspectCli,applyCli}=await import('../dist/src/cli-update-providers.js');
 const before=await inspectCli(provider);
 assert.equal(before.status,'available',JSON.stringify(before));assert.equal(before.path,selected);assert.equal(before.currentVersion,fromVersion);
 const after=await applyCli(provider,before);assert.equal(after.status,'current',JSON.stringify(after));assert.equal(after.currentVersion,before.latestVersion);
 const launch=provider==='claude'?await (await import('../dist/src/claude-launch.js')).resolveClaudeLaunch({explicit:selected})
  :provider==='grok'?await (await import('../dist/src/runtime.js')).grokLaunch()
  :await (async()=>{const {resolveCodexExecutable,codexNpmPackage}=await import('../dist/src/providers/codex.js');return (await import('../dist/src/npm-launch.js')).resolveNpmLaunch(await resolveCodexExecutable(),codexNpmPackage);})();
 const {runCommand}=await import('../dist/src/process.js');
 const loaded=await runCommand(launch,['--version'],{cwd:home,timeoutMs:15000});
 assert.equal(loaded.code,0);assert.ok(loaded.stdout.includes(after.currentVersion));
 console.log(JSON.stringify({passed:true,platform:process.platform,method:after.method,provider,previous:fromVersion,verified:loaded.stdout.trim(),sameSelectedPath:before.path===after.path}));
}finally{
 if(path.dirname(root)===tempRoot&&path.basename(root).startsWith('agent-cli-update-smoke-'))rmSync(root,{recursive:true,force:true});
}
