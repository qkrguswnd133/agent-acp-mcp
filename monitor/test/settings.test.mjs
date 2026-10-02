import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createMonitor,sanitizeJob,runSettings} from '../backend/monitor.mjs';
const require=createRequire(import.meta.url);
const {describeSetting}=require('../ui/settings.js');
const run=(selection,observation)=>({lastRun:{jobId:'j',at:'2026-10-01T00:00:00.000Z',selection,observation}});

test('parent and fixed selections without telemetry show the source and never claim confirmation',()=>{
  for(const [source,label] of [['parent','Parent 선택'],['configured','고정 설정']]){
    const p=run({model:{value:'grok-4.7',source,reason:'작업 규모에 맞춤'},effort:{value:'high',source}},null);
    const model=describeSetting(p,'model'),effort=describeSetting(p,'effort');
    assert.equal(model.text,`grok-4.7 · ${label} · 실제 확인 불가`);assert.match(model.title,/작업 규모에 맞춤/);assert.equal(model.state,'selected');
    assert.equal(effort.text,`high · ${label} · 실제 확인 불가`);
    assert.doesNotMatch(model.text+effort.text,/실제 확인(?! 불가)/);
  }
});
test('verified observation shows confirmation source; mismatch keeps both values visible',()=>{
  const same=describeSetting(run({model:{value:'gpt-5.5',source:'parent'}},{model:{value:'gpt-5.5',source:'session_config',verified:true}}),'model');
  assert.equal(same.text,'gpt-5.5 · 실제 확인 · Parent 선택');assert.match(same.title,/session_config/);
  const diff=describeSetting(run({model:{value:'claude-opus-5-5',source:'configured'}},{model:{value:'claude-sonnet-5-5',source:'cli_result',verified:true}}),'model');
  assert.equal(diff.mismatch,true);assert.match(diff.text,/claude-sonnet-5-5 · 실제 확인/);assert.match(diff.text,/선택 claude-opus-5-5 \(고정 설정\)/);
  const unverified=describeSetting(run(null,{effort:{value:'xhigh',source:'echo',verified:false}}),'effort');
  assert.equal(unverified.text,'xhigh · 보고값 · 미검증');
});
test('unknown and legacy providers keep previous honest display',()=>{
  assert.equal(describeSetting({model:null,modelPolicy:'auto',lastRun:null},'model').text,'자동 선택 · 실행 후 확인');
  assert.equal(describeSetting({effort:null,effortPolicy:'high'},'effort').text,'설정 high · 실행값 미확인');
  assert.equal(describeSetting({model:'grok-4.7',lastRun:null},'model').text,'grok-4.7 · 최근 관측');
  assert.equal(describeSetting(undefined,'model').text,'자동 선택 · 실행 후 확인');
});

test('backend keeps selection separate from observed root values and drops invalid metadata',()=>{
  const job=sanitizeJob({job_id:'x',cwd:'C:\\dev\\p',status:'completed',result:{results:[{provider:'codex',model:'unavailable',effort:null,selection:{model:{value:'gpt-5.5',source:'parent',reason:'복잡한 구현'},effort:{value:'high',source:'guess'}},observation:{model:{value:'auto',source:'x',verified:true},effort:{value:'high',source:'bad source!',verified:'yes'}}}]}});
  const r=job.providers[0];
  assert.equal(r.model,null);assert.deepEqual(r.selection,{model:{value:'gpt-5.5',source:'parent',reason:'복잡한 구현'},effort:null});
  assert.deepEqual(r.observation,{model:null,effort:{value:'high',source:'unavailable',verified:false}});
  assert.deepEqual(runSettings({model:'legacy'}),{selection:null,observation:null});
  assert.equal(runSettings({selection:{model:{value:'m',source:'parent',reason:'Bearer secret'}}}).selection.model.reason,null);
});

test('snapshot exposes newest run settings per provider and legacy newest run hides older selection',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agent-monitor-selection-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const jobs=path.join(dir,'state','jobs');await fs.mkdir(jobs,{recursive:true});
  const write=(id,at,results)=>fs.writeFile(path.join(jobs,`${id}.json`),JSON.stringify({job_id:id,cwd:'C:\\dev\\p',status:'completed',startedAt:at,finishedAt:at,result:{results}}));
  await write('11111111-1111-1111-1111-111111111111','2026-10-01T00:00:00Z',[
    {provider:'grok',selection:{model:{value:'grok-4.7',source:'configured'},effort:{value:'xhigh',source:'configured'}}},
    {provider:'claude',model:'claude-sonnet-5-5',selection:{model:{value:'claude-opus-5-5',source:'parent'}},observation:{model:{value:'claude-sonnet-5-5',source:'cli_result',verified:true}}},
    {provider:'codex',selection:{model:{value:'gpt-5.5',source:'parent'}}}]);
  await write('22222222-2222-2222-2222-222222222222','2026-10-02T00:00:00Z',[{provider:'codex',model:'gpt-legacy'}]);
  const monitor=createMonitor({gatewayRoot:dir,home:dir,env:{GROK_ENABLED:'false'},adapters:{claude:{status:async()=>({enabled:true,available:true,quota:{}})},codex:{status:async()=>({enabled:true,available:true,quota:{}})}}});
  const [grok,claude,codex]=(await monitor.status()).providers;
  assert.equal(grok.lastRun.selection.model.source,'configured');assert.equal(grok.model,null);assert.equal(grok.lastRun.observation,null);
  assert.equal(describeSetting(grok,'model').text,'grok-4.7 · 고정 설정 · 실제 확인 불가');
  assert.equal(claude.model,'claude-sonnet-5-5');assert.equal(describeSetting(claude,'model').mismatch,true);
  assert.equal(codex.lastRun,null);assert.equal(describeSetting(codex,'model').text,'gpt-legacy · 최근 관측');
});
