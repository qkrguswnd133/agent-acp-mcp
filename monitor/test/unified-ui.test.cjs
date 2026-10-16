const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ui=name=>fs.readFileSync(path.join(__dirname,'..','ui',name),'utf8');

class El{
  constructor(){this.children=[];this.listeners={};this.attributes={};this.dataset={};this.textContent='';this.title='';this.hidden=false;this.disabled=false;this.value=0;}
  setAttribute(name,value){this.attributes[name]=String(value);}
  removeAttribute(name){delete this.attributes[name];}
  addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);}
  click(){if(this.disabled)return;for(const fn of this.listeners.click||[])fn();}
}
function bootBar(extra={}){
  const els={};for(const id of ['#pin','#menu','#updates','#update-progress','#update-stage','#update-percent','#update-meter','#update-cancel','#update-close'])els[id]=new El();
  els['#update-progress'].hidden=true;
  const calls=[],handlers={};
  const document={body:new El(),querySelectorAll:()=>[],querySelector:selector=>els[selector],addEventListener(){}};
  const monitor={open(){},onState(){},onProvider(){},state:async()=>({}),menu(){},togglePin(){},close(){},
    onUpdate:callback=>{handlers.update=callback;},updateState:async()=>({}),updateRun:async()=>{calls.push('run');return {started:true};},updateCancel:()=>{calls.push('cancel');},openUpdates:()=>calls.push('open'),dismissUpdateProgress:()=>calls.push('dismiss'),...extra};
  const context={document,console,Date,Number,Math,Array,Object,Promise,setTimeout:fn=>{fn();return 0;},clearTimeout(){},matchMedia:()=>({matches:true})};
  context.window=context;context.monitor=monitor;vm.createContext(context);
  vm.runInContext(ui('update-flow.js'),context);vm.runInContext(ui('bar.js'),context);
  return {els,calls,document,push:value=>handlers.update(value),el:id=>els['#'+id]};
}
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
const unified=(patch={})=>({active:false,status:'idle',phase:'idle',message:'',canCancel:false,targets:[],...patch});
const state=(patch={})=>({phase:'idle',barProgressOpen:true,installed:{version:'2.7.0'},selected:{version:'2.7.0'},updateAction:{available:true,canStart:true,active:false},...patch});

test('bar shows the update icon for WSL-only updates and starts the unified action',async()=>{
  const app=bootBar();await flush();
  app.push(state());
  assert.equal(app.el('updates').hidden,false);assert.equal(app.el('updates').disabled,false);assert.equal(app.el('updates').title,'전체 업데이트');
  app.el('updates').click();await flush();assert.deepEqual(app.calls,['run']);
  app.push(state({updateAction:{available:false,canStart:false,active:false}}));assert.equal(app.el('updates').hidden,true);
});

test('bar progress uses unified.message, keeps download progress and follows canCancel',async()=>{
  const app=bootBar();await flush();
  app.push(state({phase:'downloading',progress:{received:50,total:100},updateAction:{available:true,canStart:false,active:true},unified:unified({active:true,status:'running',phase:'downloading',message:'Windows 다운로드 중',canCancel:true})}));
  assert.equal(app.el('update-stage').textContent,'Windows 다운로드 중');assert.equal(app.el('update-percent').textContent,'50%');assert.equal(app.el('update-meter').value,50);
  assert.equal(app.el('update-meter').hidden,false);assert.equal(app.el('update-cancel').hidden,false);assert.equal(app.el('updates').disabled,true);
  app.push(state({phase:'idle',updateAction:{available:true,canStart:false,active:true},unified:unified({active:true,status:'running',message:'Ubuntu 업데이트 중',canCancel:false})}));
  assert.equal(app.el('update-stage').textContent,'Ubuntu 업데이트 중');assert.equal(app.el('update-percent').hidden,true);
  assert.equal(app.el('update-meter').hidden,false,'meter stays available (indeterminate) while WSL runs');assert.equal(app.el('update-cancel').hidden,true);
  assert.equal(app.el('update-close').hidden,true);
});

test('bar never presents partial, blocked, cancelled or interrupted results as success',async()=>{
  const app=bootBar();await flush();
  const failed=[{id:'windows',status:'completed'},{id:'Ubuntu',status:'failed'}];
  for(const [status,message,targets] of [['partial','Ubuntu 업데이트 실패',failed],['completed','',failed],['blocked','업데이트 보류',[{id:'windows',status:'blocked'}]],['cancelled','',[]],['interrupted','',[]]]){
    app.push(state({unified:unified({status,message,targets})}));
    assert.equal(app.el('update-progress').dataset.mode,'error',status);assert.equal(app.el('update-meter').hidden,true,status);
    assert.equal(app.el('update-close').hidden,false,status);assert.notEqual(app.el('update-stage').textContent,'전체 업데이트 완료',status);assert.notEqual(app.el('update-stage').textContent,'업데이트 완료',status);
  }
  app.push(state({unified:unified({status:'partial',message:'Ubuntu 업데이트 실패',targets:failed})}));assert.equal(app.el('update-stage').textContent,'Ubuntu 업데이트 실패');
  app.push(state({unified:unified({status:'completed',message:'',targets:[{id:'windows',status:'completed'},{id:'Ubuntu',status:'up_to_date'}]})}));
  assert.equal(app.el('update-progress').dataset.mode,'success');assert.equal(app.el('update-stage').textContent,'전체 업데이트 완료');
});

test('bar handles missing or malformed unified data and stays text-only',async()=>{
  const app=bootBar();await flush();
  app.push(state());assert.equal(app.el('update-stage').textContent,'업데이트 상태 확인 중');
  app.push(state({unified:{active:'yes',status:'<x>',targets:'bad',message:{}}}));assert.equal(app.el('update-stage').textContent,'업데이트 상태 확인 중');
  const payload='<img src=x onerror=alert(1)>';
  app.push(state({unified:unified({active:true,status:'running',message:payload})}));assert.equal(app.el('update-stage').textContent,payload);
  assert.equal(app.el('update-stage').children.length,0);
});

test('bar cancel button calls updateCancel',async()=>{
  const app=bootBar();await flush();
  app.push(state({updateAction:{available:true,canStart:false,active:true},unified:unified({active:true,status:'preflight',canCancel:true,message:'확인 중'})}));
  app.el('update-cancel').click();assert.deepEqual(app.calls,['cancel']);
});
