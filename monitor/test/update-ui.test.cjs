const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ui=name=>fs.readFileSync(path.join(__dirname,'..','ui',name),'utf8');
const html=ui('update.html');

class El{
  constructor(tag,id=''){this.tagName=tag;this.id=id;this.children=[];this.listeners={};this.attributes={};this.dataset={};this.textContent='';this.className='';this.hidden=false;this.disabled=false;this.open=false;}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=[...nodes];}
  setAttribute(name,value){this.attributes[name]=String(value);}
  addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);}
  click(){if(this.disabled)return;for(const fn of this.listeners.click||[])fn();}
  focus(){this.ownerDocument.activeElement=this;}
  all(){return this.children.flatMap(child=>[child,...child.all()]);}
}
function boot(monitor){
  const elements=new Map();
  const document={body:new El('body'),activeElement:null,getElementById:id=>elements.get(id)||null,createElement:tag=>{const el=new El(tag);el.ownerDocument=document;return el;}};
  document.activeElement=document.body;
  for(const [,id] of html.matchAll(/\sid="([^"]+)"/g)){const el=document.createElement('div');el.id=id;elements.set(id,el);}
  elements.get('wsl-section').hidden=true;elements.get('unified').hidden=true;
  const context={document,console,Date,Number,Math,Map,Array,Object,Promise,setTimeout,addEventListener(){}};
  context.window=context;context.monitor=monitor;vm.createContext(context);
  vm.runInContext(ui('update-flow.js'),context);vm.runInContext(ui('update.js'),context);
  return {context,el:id=>elements.get(id),document};
}
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
const release=(version='2.8.0')=>({version,publishedAt:'2026-01-01',size:2097152,components:{gateway:'2',monitor:'1'},notes:{gateway:['a'],monitor:['b']}});
const windowsState=(patch={})=>({phase:'idle',installed:{version:'2.7.0'},selected:release(),...patch});
const wslState=(patch={})=>({available:true,status:'available',targets:[{id:'Ubuntu',name:'Ubuntu',running:true,installed:true,version:'2.5.3',latestVersion:'2.5.4',canUpdate:true}],...patch});
const unified=(patch={})=>({active:false,status:'idle',phase:'idle',message:'',canCancel:false,targets:[],...patch});
const utarget=(patch={})=>({id:'windows',name:'Windows',kind:'windows',status:'pending',...patch});
function monitor(extra={}){
  const calls=[],self={calls};
  return Object.assign(self,{onUpdate:callback=>{self.push=callback;return ()=>{};},updateState:async()=>windowsState(),updateCheck:async()=>{},updateRun:async()=>{calls.push('run');return {started:true};},updateWindows:async()=>{calls.push('windows');return {started:true};},updateCancel:()=>{calls.push('cancel');}},extra);
}
const wslButtons=app=>app.el('wsl-targets').all().filter(node=>node.tagName==='button');
const rows=app=>app.el('unified-targets').children;
const rowTexts=row=>row.all().map(node=>node.textContent).filter(Boolean);

test('markup keeps one primary action and a collapsed individual-update area after the unified panel',()=>{
  assert.match(html,/id="update"[^>]*>전체 업데이트</);
  assert.match(html,/<details id="individual-section"[^>]*>\s*<summary>개별 업데이트<\/summary>/);
  assert.doesNotMatch(html,/<details id="individual-section"[^>]*\sopen/);
  assert.match(html,/<details id="individual-section"[\s\S]*id="update-windows"[\s\S]*<\/details>/);
  const before=html.slice(0,html.indexOf('<details id="individual-section"'));
  assert.match(before,/<section id="unified"/);
  assert.doesNotMatch(before.slice(before.indexOf('<section id="unified"')),/<details/,'unified panel is not inside any collapsed section');
});

test('primary button is enabled for WSL-only updates while Windows is already latest',async()=>{
  const m=monitor({updateState:async()=>windowsState({selected:release('2.7.0'),updateAction:{available:true,canStart:true,active:false}})});
  const app=boot(m);await flush();
  assert.equal(app.el('update').disabled,false);assert.equal(app.el('update').textContent,'전체 업데이트');
  assert.equal(app.el('update-windows').disabled,true,'Windows-only action needs a newer Windows release');
  assert.equal(app.el('status').textContent,'최신 버전 확인됨');
  app.el('update').click();await flush();assert.deepEqual(m.calls,['run']);
});

test('primary button follows the combined updateAction and falls back to the Windows rule without it',async()=>{
  let app=boot(monitor({updateState:async()=>windowsState({selected:release('2.7.0'),updateAction:{available:false,canStart:false,active:false}})}));await flush();
  assert.equal(app.el('update').disabled,true);
  app=boot(monitor({updateState:async()=>windowsState({updateAction:{available:true,canStart:false,active:false}})}));await flush();
  assert.equal(app.el('update').disabled,true,'backend canStart=false wins');
  app=boot(monitor());await flush();
  assert.equal(app.el('update').disabled,false,'no updateAction: newer Windows release starts');
  app=boot(monitor({updateState:async()=>windowsState({blocked:'수동 설치 필요'})}));await flush();
  assert.equal(app.el('update').disabled,true);
});

test('Windows-only button calls updateWindows once and is hidden without the API',async()=>{
  const m=monitor();const app=boot(m);await flush();
  assert.equal(app.el('individual-section').hidden,false);assert.equal(app.el('update-windows').disabled,false);
  app.el('update-windows').click();await flush();assert.deepEqual(m.calls,['windows']);
  const old=boot(monitor({updateWindows:undefined}));await flush();
  assert.equal(old.el('individual-section').hidden,true);assert.equal(old.el('update-windows').disabled,true);
});

test('active unified run shows the current target message and disables every individual control',async()=>{
  const m=monitor({wslState:async()=>wslState(),wslRefresh:async()=>wslState(),wslUpdate:async()=>wslState()});
  const app=boot(m);await flush();
  assert.equal(app.el('wsl-refresh').disabled,false);assert.ok(wslButtons(app).some(node=>!node.disabled));
  m.push(windowsState({updateAction:{available:true,canStart:false,active:true},unified:unified({active:true,status:'running',phase:'preparing',message:'Ubuntu 업데이트 중',canCancel:true,currentTarget:'Ubuntu',targets:[utarget({status:'completed',version:'2.7.0',latestVersion:'2.8.0'}),utarget({id:'Ubuntu',name:'Ubuntu',kind:'wsl',status:'running',message:'Gateway 설치 중'}),utarget({id:'Debian',name:'Debian',kind:'wsl',status:'pending'})]})}));
  assert.equal(app.el('unified').hidden,false);
  assert.equal(app.el('status').textContent,'Ubuntu 업데이트 중');
  assert.equal(app.el('unified-message').textContent,'Ubuntu 업데이트 중');
  assert.equal(rows(app).length,3);assert.equal(rows(app)[1].dataset.current,'true');assert.equal(rows(app)[0].dataset.current,undefined);
  assert.deepEqual(rowTexts(rows(app)[0]),['Windows','완료','2.7.0 → 2.8.0']);
  assert.deepEqual(rowTexts(rows(app)[1]),['Ubuntu','업데이트 중','Gateway 설치 중']);
  for(const id of ['check','update','update-windows','wsl-refresh'])assert.equal(app.el(id).disabled,true,id);
  assert.ok(wslButtons(app).length>0&&wslButtons(app).every(node=>node.disabled),'per-WSL controls are disabled');
  assert.equal(app.el('cancel').hidden,false);assert.equal(app.el('update').textContent,'업데이트 중');
  m.push(windowsState({unified:unified({active:true,status:'running',message:'확인 중',canCancel:false})}));
  assert.equal(app.el('cancel').hidden,true,'cancel follows canCancel');
  m.push(windowsState({unified:unified({status:'completed',message:'완료'})}));
  assert.ok(wslButtons(app).some(node=>!node.disabled),'controls come back once the run is over');
  assert.equal(app.el('check').disabled,false);assert.equal(app.el('wsl-refresh').disabled,false);
});

test('all-success result renders as success while partial, blocked, cancelled and interrupted never do',async()=>{
  const m=monitor();const app=boot(m);await flush();
  const ok=[utarget({status:'completed'}),utarget({id:'Ubuntu',name:'Ubuntu',kind:'wsl',status:'up_to_date'})];
  m.push(windowsState({selected:release('2.7.0'),unified:unified({status:'completed',message:'모든 대상 업데이트 완료',targets:ok})}));
  assert.equal(app.el('unified').dataset.tone,'success');assert.equal(app.el('unified-status').textContent,'전체 업데이트 완료');assert.equal(app.el('indicator').className,'');
  const failed=[utarget({status:'completed'}),utarget({id:'Ubuntu',name:'Ubuntu',kind:'wsl',status:'failed',message:'설치 실패'})];
  const cases=[['partial','일부 업데이트 실패','error',failed],['completed','일부 업데이트 실패','error',failed],['blocked','업데이트 보류','error',[utarget({status:'blocked',message:'설치 보류'})]],['cancelled','업데이트 취소됨','neutral',[utarget({status:'cancelled'})]],['interrupted','업데이트 중단됨','error',failed]];
  for(const [status,label,tone,targets] of cases){
    m.push(windowsState({selected:release('2.7.0'),unified:unified({status,message:'사유',targets})}));
    assert.equal(app.el('unified').hidden,false,status);assert.equal(app.el('unified-status').textContent,label,status);assert.equal(app.el('unified').dataset.tone,tone,status);
    assert.equal(app.el('indicator').className,tone==='error'?'error':'',status);
    assert.equal(app.el('unified-message').attributes.role,tone==='error'?'alert':'status',status);
  }
  m.push(windowsState({selected:release('2.7.0'),unified:unified({status:'partial',message:'사유',targets:failed})}));
  assert.equal(app.el('status').textContent,'일부 업데이트 실패');
  assert.deepEqual(rowTexts(rows(app)[1]),['Ubuntu','실패','설치 실패']);assert.equal(rows(app)[1].dataset.status,'failed');
});

test('blocked results stay visible outside collapsed sections and idle hides the panel',async()=>{
  const m=monitor();const app=boot(m);await flush();
  m.push(windowsState({unified:unified({status:'blocked',message:'다른 업데이트가 진행 중입니다.',targets:[utarget({status:'blocked'})]})}));
  assert.equal(app.el('unified').hidden,false);assert.equal(app.el('individual-section').open,false);assert.equal(app.el('wsl-section').open,false);
  assert.equal(app.el('unified-message').textContent,'다른 업데이트가 진행 중입니다.');
  m.push(windowsState({unified:unified()}));assert.equal(app.el('unified').hidden,true);
  m.push(windowsState());assert.equal(app.el('unified').hidden,true,'missing unified object is tolerated');
});

test('persisted state at startup uses the same renderer',async()=>{
  const state=windowsState({unified:unified({status:'partial',message:'지난 실행 결과',targets:[utarget({status:'completed'}),utarget({id:'Debian',name:'Debian',kind:'wsl',status:'failed'})]})});
  const app=boot(monitor({updateState:async()=>state}));await flush();
  assert.equal(app.el('unified-status').textContent,'일부 업데이트 실패');assert.equal(rows(app).length,2);assert.equal(app.el('unified').dataset.tone,'error');
});

test('unified text is rendered as text only and malformed input is bounded',async()=>{
  const m=monitor();const app=boot(m);await flush();
  const payload='<img src=x onerror=alert(1)>';
  const many=Array.from({length:60},(_,i)=>utarget({id:'t'+i,name:'t'+i}));
  m.push(windowsState({unified:unified({active:true,status:'running',message:payload,canCancel:true,currentTarget:{id:'<b>'},targets:[utarget({id:'<b>',name:payload,status:'<script>',message:payload,version:payload,latestVersion:'<i>'}),null,{id:42},...many]})}));
  assert.equal(app.el('unified-message').textContent,payload);assert.equal(app.el('status').textContent,payload);
  const first=rows(app)[0];assert.equal(first.children[0].textContent,payload);assert.equal(first.children[1].textContent,'확인 필요');
  assert.equal(first.children[2].textContent,`${payload.slice(0,64)} → <i> · ${payload}`);assert.equal(first.dataset.current,'true');
  assert.ok(rows(app).length<=33);assert.ok(app.el('unified-targets').all().every(node=>node.tagName!=='img'&&node.tagName!=='script'));
  m.push(windowsState({unified:{active:'yes',status:'<x>',targets:'bad'}}));
  assert.equal(app.el('unified').hidden,true);
});

test('Windows download progress stays available during a unified run',async()=>{
  const m=monitor();const app=boot(m);await flush();
  m.push(windowsState({phase:'downloading',progress:{received:5*1048576,total:10*1048576},unified:unified({active:true,status:'running',phase:'downloading',message:'Windows 다운로드 중',targets:[utarget({status:'running'})]})}));
  assert.equal(app.el('progress').hidden,false);assert.equal(app.el('progress').value,5*1048576);assert.equal(app.el('progress-label').textContent,'5 / 10 MB');
  assert.equal(app.el('update').textContent,'다운로드 중');assert.equal(app.el('status').textContent,'Windows 다운로드 중');
  m.push(windowsState({phase:'idle',unified:unified({active:true,status:'running',message:'Ubuntu 업데이트 중'})}));
  assert.equal(app.el('progress').hidden,true);
});

test('cancel button calls updateCancel',async()=>{
  const m=monitor();const app=boot(m);await flush();
  m.push(windowsState({unified:unified({active:true,status:'preflight',canCancel:true})}));
  app.el('cancel').click();assert.deepEqual(m.calls,['cancel']);
});
