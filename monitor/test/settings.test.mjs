import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createMonitor,sanitizeJob,runSettings} from '../backend/monitor.mjs';
const require=createRequire(import.meta.url);
const {describeSetting,describeSpeed}=require('../ui/settings.js');
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
  assert.equal(codex.lastRun.jobId,'22222222-2222-2222-2222-222222222222');assert.equal(codex.lastRun.selection,null);assert.equal(codex.lastRun.model,'gpt-legacy');assert.equal(describeSetting(codex,'model').text,'gpt-legacy · 최근 관측');assert.equal(describeSpeed(codex).primary,'확인 불가');
});

const speedRun=(executionSpeed,extra={},provider='codex')=>({provider,lastRun:{jobId:'j',at:'2026-10-01T00:00:00.000Z',sessionId:'s1',turnId:'t1',executionSpeed,...extra}});
const appliedSpeed=(extra={})=>({effective:'fast',effectiveSource:'app_server.thread/start',effectiveVerified:true,threadId:'s1',turnId:'t1',...extra});

test('detail separates primary value from secondary status and keeps legacy text',()=>{
  const d=describeSetting(run({model:{value:'gpt-5.5',source:'parent',reason:'복잡한 구현'}},null),'model');
  assert.equal(d.primary,'gpt-5.5');assert.equal(d.status,'설정값 · 실제 확인 불가');assert.doesNotMatch(d.primary,/·/);assert.match(d.detail,/요청: gpt-5.5 \(Parent 선택\)/);assert.match(d.detail,/이유: 복잡한 구현/);assert.equal(d.compare,null);
  const v=describeSetting(run(null,{effort:{value:'high',source:'session_config',verified:true}}),'effort');
  assert.equal(v.primary,'high');assert.equal(v.status,'실제 확인');assert.equal(v.state,'verified');
});
test('mismatch exposes requested and actual as separate values',()=>{
  const long='claude-opus-5-5-with-a-very-long-identifier-that-must-wrap-instead-of-ellipsis-20261001';
  const d=describeSetting(run({model:{value:long,source:'configured'}},{model:{value:'claude-sonnet-5-5',source:'cli_result',verified:true}}),'model');
  assert.equal(d.mismatch,true);assert.equal(d.primary,'claude-sonnet-5-5');assert.deepEqual(d.compare,{requested:long,requestedSource:'고정 설정',actual:'claude-sonnet-5-5'});
  assert.match(d.status,/요청과 다름/);assert.match(d.detail,/^실제: claude-sonnet-5-5/);assert.ok(d.detail.split('\n').some(line=>line===`요청: ${long} (고정 설정)`));
});
test('same-run unknowns never borrow an unrelated prior model or effort',()=>{
  const p={model:'old-model',effort:'low',modelPolicy:'current-policy-model',effortPolicy:'xhigh',lastRun:{jobId:'j',at:'2026-10-01T00:00:00.000Z',model:null,effort:null,selection:null,observation:null}};
  for(const values of [{model:null,effort:null},{model:undefined,effort:undefined}])for(const axis of ['model','effort']){
    const d=describeSetting({...p,lastRun:{...p.lastRun,...values}},axis);
    assert.doesNotMatch(d.text+d.detail+d.primary,/old-model|low|current-policy-model|xhigh/);assert.equal(d.primary,'확인 불가');assert.equal(d.state,'unknown');assert.equal(d.status,'이 실행에서 확인 불가');
  }
  const same=describeSetting({model:'old-model',lastRun:{jobId:'j',at:'2026-10-01T00:00:00.000Z',model:'run-model'}},'model');
  assert.equal(same.primary,'run-model');assert.equal(same.status,'보고값 · 미검증');
  const selected=describeSetting({model:'old-model',...run({model:{value:'gpt-5.5',source:'parent'}},null)},'model');assert.doesNotMatch(selected.detail,/old-model/);
  const legacy=describeSetting({model:'grok-4.7',lastRun:null},'model');assert.equal(legacy.primary,'grok-4.7');assert.match(legacy.status,/최근 관측/);
});
test('speed prefers verified observation, then verified CLI effective, and labels sources honestly',()=>{
  const obs=describeSpeed(speedRun(appliedSpeed({requested:'fast',settingSource:'configured',observed:'fast',observationSource:'provider_event',verified:true,effective:'standard'})));
  assert.equal(obs.primary,'Fast');assert.equal(obs.status,'실행 확인');assert.equal(obs.state,'verified');assert.equal(obs.mismatch,false);assert.equal(obs.basis,'observation');
  for(const effectiveSource of ['app_server.thread/start','app_server.thread/resume','app_server.thread/settings/updated']){
    const cli=describeSpeed(speedRun(appliedSpeed({requested:'fast',settingSource:'configured',observed:null,verified:false,effectiveSource})));
    assert.equal(cli.primary,'Fast');assert.equal(cli.status,'CLI 적용 확인');assert.match(cli.detail,/Codex CLI effective/);assert.ok(cli.detail.includes(effectiveSource));assert.equal(cli.basis,'effective');
  }
  const mism=describeSpeed(speedRun(appliedSpeed({requested:'fast',settingSource:'configured',effective:'standard'})));
  assert.equal(mism.mismatch,true);assert.equal(mism.primary,'Standard');assert.deepEqual(mism.compare,{requested:'Fast',requestedSource:'고정 설정',actual:'Standard'});
});
test('speed never presents requested, unverified, foreign-turn or unknown values as actual',()=>{
  const req=describeSpeed(speedRun({requested:'fast',settingSource:'configured',observed:null,verified:false,effective:null,effectiveVerified:false}));
  assert.equal(req.primary,'Fast');assert.equal(req.status,'설정값 · 실제 확인 불가');assert.equal(req.state,'selected');assert.equal(req.basis,'requested');assert.doesNotMatch(req.status,/실행 확인|CLI 적용 확인/);
  const unverifiedEffective=describeSpeed(speedRun({requested:'fast',effective:'fast',effectiveVerified:false}));assert.equal(unverifiedEffective.basis,'requested');
  const foreign=describeSpeed(speedRun(appliedSpeed({requested:null,turnId:'other'})));assert.equal(foreign.primary,'확인 불가');assert.equal(foreign.state,'unknown');
  const reported=describeSpeed(speedRun({observed:'fast',verified:false,observationSource:'echo'}));assert.equal(reported.status,'보고값 · 미검증');assert.equal(reported.state,'observed');
  const bogus=describeSpeed(speedRun({requested:'<img src=x onerror=1>',observed:'turbo',verified:true,effective:'ultra',effectiveVerified:true}));assert.equal(bogus.primary,'확인 불가');
  assert.equal(describeSpeed(speedRun(null)).primary,'확인 불가');assert.equal(describeSpeed({lastRun:null,model:'x'}).primary,'확인 불가');assert.equal(describeSpeed(undefined).state,'unknown');
  assert.match(describeSpeed(speedRun(null)).status,/속도 정보 없음/);
});
test('CLI application requires matching nonempty IDs, a Codex provider and an exact source',()=>{
  const cases=[
    ...['sessionId','turnId'].flatMap(field=>[null,undefined,'','other'].map(value=>({name:`run ${field} ${String(value)}`,run:{[field]:value}}))),
    ...['threadId','turnId'].flatMap(field=>[null,undefined,'','other'].map(value=>({name:`speed ${field} ${String(value)}`,speed:{[field]:value}}))),
    ...[null,undefined,'','codex_app_server','configured','app_server.thread/start/extra','app_server.thread/settings'].map(value=>({name:`source ${String(value)}`,speed:{effectiveSource:value}})),
    ...['claude','grok','unknown',null].map(provider=>({name:`provider ${String(provider)}`,provider})),
    ...[false,'true',1].map(value=>({name:`flag ${String(value)}`,speed:{effectiveVerified:value}})),
    {name:'both IDs missing',run:{sessionId:undefined,turnId:undefined},speed:{threadId:undefined,turnId:undefined}},
    {name:'both IDs empty',run:{sessionId:'',turnId:''},speed:{threadId:'',turnId:''}},
  ];
  for(const fixture of cases){
    const d=describeSpeed(speedRun(appliedSpeed(fixture.speed),fixture.run,fixture.provider===undefined?'codex':fixture.provider));
    assert.equal(d.primary,'확인 불가',fixture.name);assert.equal(d.state,'unknown',fixture.name);assert.equal(d.basis,'none',fixture.name);assert.doesNotMatch(d.status,/실행 확인|CLI 적용 확인/,fixture.name);
  }
  const noProvider=speedRun(appliedSpeed());delete noProvider.provider;
  assert.equal(describeSpeed(noProvider).basis,'none');
  const requested=describeSpeed(speedRun(appliedSpeed({requested:'fast',threadId:undefined})));
  assert.equal(requested.basis,'requested');assert.equal(requested.status,'설정값 · 실제 확인 불가');
});
test('ultrafast is recognized while unsupported speed names never gain confirmation',()=>{
  const effective=describeSpeed(speedRun(appliedSpeed({requested:'ultrafast',effective:'ultrafast'})));
  assert.equal(effective.primary,'Ultrafast');assert.equal(effective.value,'ultrafast');assert.equal(effective.basis,'effective');assert.equal(effective.status,'CLI 적용 확인');
  const observed=describeSpeed(speedRun({observed:'ultrafast',verified:true,observationSource:'provider_result'}));
  assert.equal(observed.primary,'Ultrafast');assert.equal(observed.basis,'observation');assert.equal(observed.status,'실행 확인');
  const requested=describeSpeed(speedRun({requested:'ultrafast',settingSource:'configured'}));
  assert.equal(requested.primary,'Ultrafast');assert.equal(requested.basis,'requested');assert.equal(requested.status,'설정값 · 실제 확인 불가');
  for(const value of ['flex','ultra','turbo']){
    const d=describeSpeed(speedRun(appliedSpeed({requested:value,observed:value,verified:true,effective:value})));
    assert.equal(d.primary,'확인 불가');assert.equal(d.basis,'none');
  }
});
test('Claude observed speed and Grok requested speed use their respective evidence',()=>{
  const claude=describeSpeed(speedRun({requested:'fast',settingSource:'configured',observed:'standard',observationSource:'claude.result',verified:true},{},'claude'));
  assert.equal(claude.primary,'Standard');assert.equal(claude.basis,'observation');assert.equal(claude.mismatch,true);assert.deepEqual(claude.compare,{requested:'Fast',requestedSource:'고정 설정',actual:'Standard'});
  const grok=describeSpeed(speedRun({requested:'standard',settingSource:'default',observed:null,verified:false,effective:null,effectiveVerified:false},{},'grok'));
  assert.equal(grok.primary,'Standard');assert.equal(grok.basis,'requested');assert.equal(grok.status,'설정값 · 실제 확인 불가');assert.match(grok.detail,/기본 설정/);
});
test('speed is bound to the latest run and ignores provider-level legacy fields',()=>{
  const d=describeSpeed({speed:'fast',executionSpeed:{observed:'fast',verified:true},lastRun:{jobId:'j',at:'2026-10-01T00:00:00.000Z',executionSpeed:null}});
  assert.equal(d.primary,'확인 불가');
});
test('detail renderer writes through textContent only and ships the speed/status DOM nodes',async()=>{
  const html=await fs.readFile(new URL('../ui/detail.html',import.meta.url),'utf8'),js=await fs.readFile(new URL('../ui/detail.js',import.meta.url),'utf8');
  for(const id of ['model','effort','speed','model-detail','effort-detail','speed-detail','model-status','effort-status','speed-status','model-compare','speed-compare'])assert.match(html,new RegExp(`id="${id}"`));
  assert.doesNotMatch(js,/innerHTML|outerHTML|insertAdjacentHTML/);
  const hostile=describeSetting(run({model:{value:'<img src=x onerror=alert(1)>',source:'parent'}},null),'model');
  assert.equal(hostile.primary,'<img src=x onerror=alert(1)>');
});
