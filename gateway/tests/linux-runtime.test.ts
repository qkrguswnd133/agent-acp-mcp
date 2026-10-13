import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {userStateDirectory,installationStateDirectory,assertLinuxStateMigrated} from '../src/state-paths.js';
import {linuxStartTicks,processIdentity} from '../src/process-identity.js';
import {MaintenanceGate} from '../src/maintenance.js';
import {GatewayRegistry} from '../src/gateway-registry.js';

const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const identity='linux:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:123456:1000';
const fixture=()=>fs.mkdtempSync(path.join(os.tmpdir(),'gateway-linux-runtime-'));

test('Linux and WSL state use XDG or explicit absolute override; Windows layout is preserved',()=>{
  assert.equal(userStateDirectory({platform:'linux',home:'/home/USERNAME',env:{}}),'/home/USERNAME/.local/state/agent-acp-mcp');
  assert.equal(userStateDirectory({platform:'linux',home:'/home/USERNAME',env:{XDG_STATE_HOME:'/data/state',WSL_DISTRO_NAME:'Ubuntu'}}),'/data/state/agent-acp-mcp');
  assert.equal(userStateDirectory({platform:'linux',home:'/home/USERNAME',env:{XDG_STATE_HOME:'relative'}}),'/home/USERNAME/.local/state/agent-acp-mcp');
  assert.equal(userStateDirectory({platform:'linux',env:{AGENT_MCP_STATE_DIR:'/existing/runtime'}}),'/existing/runtime');
  assert.throws(()=>userStateDirectory({platform:'linux',env:{AGENT_MCP_STATE_DIR:'relative'}}),/absolute Linux path/);
  assert.equal(installationStateDirectory('C:\\Gateway',{platform:'win32',env:{AGENT_MCP_STATE_DIR:'C:\\Quota'}}),'C:\\Gateway\\state');
  assert.equal(userStateDirectory({platform:'win32',env:{AGENT_MCP_STATE_DIR:'C:\\Quota'}}),'C:\\Quota');
});

test('Linux installation metadata locates migrated state; explicit env wins and invalid metadata fails',()=>{
  const dir=fixture();
  try{
    fs.writeFileSync(path.join(dir,'agent-acp-installation.json'),JSON.stringify({schemaVersion:1,stateRoot:'/external/state'}));
    assert.equal(installationStateDirectory(dir,{platform:'linux',env:{}}),'/external/state');
    assert.equal(installationStateDirectory(dir,{platform:'linux',env:{AGENT_MCP_STATE_DIR:'/override'}}),'/override');
    fs.writeFileSync(path.join(dir,'agent-acp-installation.json'),JSON.stringify({schemaVersion:1,stateRoot:'relative'}));
    assert.throws(()=>installationStateDirectory(dir,{platform:'linux',env:{}}),/Invalid Linux installation/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('Linux startup refuses hidden legacy state and state inside replaceable installation',()=>{
  const dir=fixture(),root=path.join(dir,'gateway'),state=path.join(dir,'data');
  try{
    fs.mkdirSync(path.join(root,'state'),{recursive:true});
    assertLinuxStateMigrated(root,state,'linux');
    fs.writeFileSync(path.join(root,'state','saved-job.json'),'{}');
    assert.throws(()=>assertLinuxStateMigrated(root,state,'linux'),/LEGACY_STATE_MIGRATION_REQUIRED/);
    assert.throws(()=>assertLinuxStateMigrated(root,path.join(root,'elsewhere'),'linux'),/outside/);
    assertLinuxStateMigrated(root,state,'win32');
    assert.equal(fs.readFileSync(path.join(root,'state','saved-job.json'),'utf8'),'{}');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('Linux process identity verifies stat generation, boot and every UID without shell execution',()=>{
  const dir=fixture(),pid=123;
  const stat=`${pid} (node (worker)) S ${Array(18).fill('0').join(' ')} 123456 0`;
  try{
    fs.mkdirSync(path.join(dir,String(pid)),{recursive:true});fs.mkdirSync(path.join(dir,'sys/kernel/random'),{recursive:true});
    fs.writeFileSync(path.join(dir,String(pid),'stat'),stat);
    fs.writeFileSync(path.join(dir,String(pid),'status'),'Name:\tnode\nUid:\t1000\t1000\t1000\t1000\n');
    fs.writeFileSync(path.join(dir,'sys/kernel/random/boot_id'),'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n');
    assert.equal(linuxStartTicks(stat),'123456');
    assert.equal(processIdentity(pid,{platform:'linux',procRoot:dir,uid:1000}),identity);
    assert.equal(processIdentity(pid,{platform:'linux',procRoot:dir,uid:2000}),undefined);
    fs.writeFileSync(path.join(dir,String(pid),'status'),'Uid:\t1000\t0\t1000\t1000\n');
    assert.equal(processIdentity(pid,{platform:'linux',procRoot:dir,uid:1000}),undefined);
    assert.equal(processIdentity(999,{platform:'linux',procRoot:dir,uid:1000}),undefined);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

function lease(root:string,changes:Record<string,unknown>={}){
  const value={schemaVersion:1,operationId:randomUUID(),ownerPid:42,ownerStartedAt:identity,platform:'linux',requestedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60_000).toISOString(),phase:'prepare',...changes};
  fs.writeFileSync(root+'.maintenance.json',JSON.stringify(value));return value;
}
test('Linux busy lease blocks new work; idle prepare acknowledges generation and commit exits once',async()=>{
  const dir=fixture(),root=path.join(dir,'gateway');let idle=false,exits=0;
  const gate=new MaintenanceGate(root,()=>idle,()=>exits++,{platform:'linux',identity:()=>identity,alive:()=>true});
  try{
    const request=lease(root);gate.start();assert.throws(()=>gate.assertAvailable(),/GATEWAY_MAINTENANCE/);
    const ack=`${root}.maintenance.${request.operationId}.${process.pid}.ack.json`;
    assert.equal(fs.existsSync(ack),false);assert.equal(exits,0);
    idle=true;await pause(150);
    assert.equal(JSON.parse(fs.readFileSync(ack,'utf8')).gatewayStartedAt,identity);
    fs.writeFileSync(root+'.maintenance.json',JSON.stringify({...request,phase:'commit'}));
    await pause(250);assert.equal(exits,1);
  }finally{gate.stop();fs.rmSync(dir,{recursive:true,force:true});}
});
test('Linux ignores expired, cross-platform, wrong-generation and dead updater leases',()=>{
  const dir=fixture(),root=path.join(dir,'gateway');let observed=identity,alive=true;
  const gate=new MaintenanceGate(root,()=>true,()=>{throw Error('must not exit');},{platform:'linux',identity:()=>observed,alive:()=>alive});
  try{
    lease(root,{expiresAt:new Date(Date.now()-1).toISOString()});assert.equal(gate.blocked(),false);
    lease(root,{platform:'win32',ownerStartedAt:'123456789012345678'});assert.equal(gate.blocked(),false);
    lease(root);assert.equal(gate.blocked(),true);
    observed=identity.replace('123456','123457');assert.equal(gate.blocked(),false);
    observed=identity;alive=false;assert.equal(gate.blocked(),false);
  }finally{gate.stop();fs.rmSync(dir,{recursive:true,force:true});}
});
test('Linux gateway respawn honors existing maintenance lease before accepting work',()=>{
  const dir=fixture(),root=path.join(dir,'gateway');
  const gate=new MaintenanceGate(root,()=>true,()=>{},{platform:'linux',identity:()=>identity,alive:()=>true});
  try{lease(root,{phase:'commit'});assert.throws(()=>gate.assertAvailable(),/GATEWAY_MAINTENANCE/);}finally{gate.stop();fs.rmSync(dir,{recursive:true,force:true});}
});
test('Linux registry records installation and generation; stop preserves another generation record',()=>{
  const dir=fixture(),root=path.join(dir,'gateway'),state=path.join(dir,'state');
  const registry=new GatewayRegistry(root,state,()=>false,'linux',()=>identity);
  try{
    registry.start();const record=JSON.parse(fs.readFileSync(registry.file,'utf8'));
    assert.equal(record.startIdentity,identity);assert.equal(record.installRoot,root);assert.equal(record.stateRoot,state);assert.equal(record.idle,false);
    registry.stop();assert.equal(fs.existsSync(registry.file),false);
    registry.start();fs.writeFileSync(registry.file,JSON.stringify({...record,startIdentity:'other-generation'}));
    registry.stop();assert.equal(fs.existsSync(registry.file),true);
  }finally{registry.stop();fs.rmSync(dir,{recursive:true,force:true});}
});
test('native Linux /proc identity works for current process without Windows commands',{skip:process.platform!=='linux'},()=>{
  assert.match(processIdentity(process.pid)??'',/^linux:[0-9a-f-]{36}:\d+:\d+$/i);
});

test('native Linux Gateway registers external state, acknowledges idle maintenance and exits without CLI calls',{skip:process.platform!=='linux',timeout:15000},async()=>{
  const dir=fixture(),root=path.join(dir,'gateway'),state=path.join(dir,'state');
  const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
  fs.mkdirSync(path.join(root,'dist'),{recursive:true});
  fs.cpSync(path.join(source,'dist/src'),path.join(root,'dist/src'),{recursive:true});
  fs.copyFileSync(path.join(source,'package.json'),path.join(root,'package.json'));
  fs.symlinkSync(path.join(source,'node_modules'),path.join(root,'node_modules'),'dir');
  fs.writeFileSync(path.join(root,'agent-acp-installation.json'),JSON.stringify({schemaVersion:1,stateRoot:state}));
  const env:NodeJS.ProcessEnv={...process.env,GROK_ENABLED:'false',CLAUDE_ENABLED:'false',CODEX_ENABLED:'false'};delete env.AGENT_MCP_STATE_DIR;
  const child=spawn(process.execPath,[path.join(root,'dist/src/index.js')],{env,stdio:['pipe','pipe','pipe']});
  let stderr='';child.stderr.on('data',data=>stderr+=String(data));child.stdout.on('data',()=>{});
  const ended=new Promise<number|null>(resolve=>child.once('exit',code=>resolve(code)));
  async function until(predicate:()=>boolean){for(let i=0;i<100;i++){if(predicate())return;assert.equal(child.exitCode,null,stderr);await pause(50);}throw Error(`Timed out waiting for gateway: ${stderr}`);}
  try{
    const registry=path.join(state,'gateways',`${child.pid}.json`);
    await until(()=>fs.existsSync(registry));
    const record=JSON.parse(fs.readFileSync(registry,'utf8'));assert.equal(record.idle,true);assert.equal(record.stateRoot,state);
    assert.equal(fs.existsSync(path.join(root,'state')),false);
    const request=lease(root,{ownerPid:process.pid,ownerStartedAt:processIdentity(process.pid)});
    const ack=`${root}.maintenance.${request.operationId}.${child.pid}.ack.json`;
    await until(()=>fs.existsSync(ack));assert.equal(JSON.parse(fs.readFileSync(ack,'utf8')).gatewayStartedAt,record.startIdentity);
    fs.writeFileSync(root+'.maintenance.json',JSON.stringify({...request,phase:'commit'}));
    const code=await Promise.race([ended,pause(5000).then(()=>{throw Error('Gateway did not exit after idle maintenance commit');})]);
    assert.equal(code,0,stderr);assert.equal(fs.existsSync(registry),false);
  }finally{if(child.exitCode===null){child.kill('SIGTERM');await ended;}fs.rmSync(dir,{recursive:true,force:true});}
});
