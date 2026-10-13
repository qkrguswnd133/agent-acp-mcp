const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ui=name=>fs.readFileSync(path.join(__dirname,'..','ui',name),'utf8');
const html=ui('update.html');

class El{
  constructor(tag,id=''){this.tagName=tag;this.id=id;this.children=[];this.listeners={};this.attributes={};this.dataset={};this.textContent='';this.className='';this.hidden=false;this.disabled=false;this.open=false;this.focused=false;}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=[...nodes];}
  setAttribute(name,value){this.attributes[name]=String(value);}
  addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);}
  click(){if(this.disabled)return;for(const fn of this.listeners.click||[])fn();}
  focus(){this.focused=true;this.ownerDocument.activeElement=this;}
  all(){return this.children.flatMap(child=>[child,...child.all()]);}
  texts(){return this.all().map(node=>node.textContent).filter(Boolean);}
}
function boot(monitor){
  const elements=new Map();
  const document={body:new El('body'),activeElement:null,getElementById:id=>elements.get(id)||null,createElement:tag=>{const el=new El(tag);el.ownerDocument=document;return el;}};
  document.activeElement=document.body;
  for(const [,id] of html.matchAll(/\sid="([^"]+)"/g)){const el=document.createElement('div');el.id=id;elements.set(id,el);}
  if(/<details id="wsl-section"[^>]*\shidden/.test(html))elements.get('wsl-section').hidden=true;
  const windowListeners={};
  const context={document,console,Date,Number,Math,Map,Array,Object,Promise,setTimeout,addEventListener:(type,fn)=>{windowListeners[type]=fn;}};
  context.window=context;context.monitor=monitor;vm.createContext(context);
  vm.runInContext(ui('update-flow.js'),context);vm.runInContext(ui('update.js'),context);
  return {context,windowListeners,el:id=>elements.get(id),document};
}
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function baseMonitor(extra={}){
  const calls=[];
  return {calls,onUpdate:()=>()=>{},updateState:async()=>({}),updateCheck:async()=>{},updateRun:async()=>({started:true}),updateCancel(){},
    ...extra};
}
const state=(patch={})=>({available:true,status:'available',targets:[],...patch});
const target=(patch={})=>({id:'Ubuntu',name:'Ubuntu',running:true,installed:true,version:'2.5.3',latestVersion:'2.5.4',canUpdate:true,...patch});
const buttons=app=>app.el('wsl-targets').all().filter(node=>node.tagName==='button');
const button=(app,key)=>buttons(app).find(node=>node.dataset.wslKey===key);

test('actual updater settled phases allow rechecking and numeric progress displays percent',async()=>{
 for(const phase of ['stopped','checked','complete','blocked','up_to_date','error']){
  const app=boot(baseMonitor({wslState:async()=>state({targets:[target({phase,running:phase!=='stopped',progress:{received:50,total:100,unit:'percent'}})]})}));await flush();
  assert.equal(button(app,'probe:Ubuntu').disabled,false,phase);assert.ok(app.el('wsl-targets').all().some(node=>node.textContent==='50%'));
 }
});

test('markup ships a hidden collapsible section with explicit controls and no remote content',()=>{
  assert.match(html,/<details id="wsl-section"[^>]*\shidden/);
  assert.match(html,/id="wsl-refresh"[^>]*aria-label="/);
  assert.match(html,/<ul id="wsl-targets"[^>]*aria-label=/);
  assert.match(html,/id="wsl-message"[^>]*role="status"/);
  assert.doesNotMatch(html,/<details id="wsl-section"[^>]*\sopen/);
  const css=ui('update.css');
  assert.match(css,/prefers-reduced-motion/);assert.match(css,/forced-colors/);assert.match(css,/:focus-visible/);
});

test('missing WSL APIs hide the section and leave the Windows update window working',async()=>{
  const monitor=baseMonitor({updateState:async()=>({phase:'idle',installed:{version:'1.0.0'},selected:{version:'1.1.0',publishedAt:'2026-01-01',size:2097152,components:{gateway:'2',monitor:'1'},notes:{gateway:['a'],monitor:['b']}}})});
  const app=boot(monitor);await flush();
  assert.equal(app.el('wsl-section').hidden,true);
  assert.equal(app.el('status').textContent,'업데이트 사용 가능');assert.equal(app.el('update').disabled,false);
});

test('absent, disabled and empty WSL states render honest guidance without actions',async()=>{
  for(const [status,expected] of [['unavailable','설치되어 있지 않거나'],['disabled','꺼져 있습니다'],['empty','배포판이 없습니다']]){
    const app=boot(baseMonitor({wslState:async()=>state({available:status!=='unavailable',status,targets:[target()]})}));await flush();
    assert.equal(app.el('wsl-section').hidden,false);
    assert.match(app.el('wsl-message').textContent,new RegExp(expected));assert.equal(app.el('wsl-targets').children.length,0);
    assert.match(app.el('wsl-message').textContent,/자동으로 설치하지 않습니다|직접/);
  }
});

test('available state with no targets is reported as empty',async()=>{
  const app=boot(baseMonitor({wslState:async()=>state()}));await flush();
  assert.equal(app.el('wsl-badge').textContent,'배포판 없음');
});

test('stopped distro is never woken by passive calls and needs the explicit start-and-check action',async()=>{
  const calls=[];
  const app=boot(baseMonitor({wslState:async()=>{calls.push('state');return state({targets:[target({running:false,installed:null,version:null,latestVersion:null})]});},wslRefresh:async()=>{calls.push('refresh');return state({targets:[target({running:false,installed:null})]});},wslProbe:async id=>{calls.push('probe:'+id);return state({targets:[target({running:true,installed:true})]});},wslUpdate:async()=>{calls.push('update');return state();}}));
  await flush();
  assert.deepEqual(calls,['state']);
  const probe=button(app,'probe:Ubuntu');
  assert.equal(probe.textContent,'시작하고 확인');assert.match(probe.attributes['aria-label'],/시작하고/);assert.equal(probe.disabled,false);
  assert.equal(button(app,'update:Ubuntu'),undefined);
  assert.ok(app.el('wsl-targets').texts().some(text=>text.includes('설치 여부 확인 전')&&text.includes('알 수 없음')));
  app.el('wsl-refresh').click();await flush();assert.deepEqual(calls,['state','refresh']);
  button(app,'probe:Ubuntu').click();await flush();assert.deepEqual(calls,['state','refresh','probe:Ubuntu']);
  assert.equal(button(app,'probe:Ubuntu').textContent,'확인');assert.ok(button(app,'update:Ubuntu'));
});

test('stopped installed distro cannot be updated and not-installed distro gets guidance only',async()=>{
  const app=boot(baseMonitor({wslState:async()=>state({targets:[target({id:'A',name:'A',running:false,installed:true,canUpdate:true}),target({id:'B',name:'B',installed:false,version:null,latestVersion:null,canUpdate:true})]}),wslUpdate:async()=>state()}));await flush();
  assert.equal(button(app,'update:A').disabled,true);
  assert.equal(button(app,'update:B'),undefined);
  assert.ok(app.el('wsl-targets').texts().some(text=>text.includes('자동으로 설치하지 않습니다')));
  assert.equal(button(app,'probe:B').textContent,'확인');
});

test('update requires backend canUpdate and invokes the fixed method with the original id exactly once',async()=>{
  const calls=[];let release;
  const app=boot(baseMonitor({wslState:async()=>state({targets:[target({id:'Ubuntu-24.04',name:'<b>x</b>',canUpdate:false}),target({id:'Debian',name:'Debian'})]}),wslUpdate:id=>{calls.push(id);return new Promise(resolve=>{release=resolve;});}}));
  await flush();
  assert.equal(button(app,'update:Ubuntu-24.04').disabled,true);
  assert.equal(app.el('wsl-targets').children[0].children[0].children[0].textContent,'<b>x</b>');
  const update=button(app,'update:Debian');assert.equal(update.disabled,false);assert.match(update.attributes['aria-label'],/Debian Gateway 업데이트/);
  update.click();await flush();
  assert.deepEqual(calls,['Debian']);
  assert.ok(buttons(app).every(node=>node.disabled),'every conflicting WSL action is disabled while one runs');
  assert.equal(app.el('wsl-refresh').disabled,true);
  release(state({targets:[target({id:'Debian',name:'Debian',version:'2.5.4',canUpdate:true})]}));await flush();
  assert.deepEqual(calls,['Debian']);assert.equal(app.el('wsl-refresh').disabled,false);
  assert.equal(app.document.activeElement,button(app,'update:Debian'),'focus returns to the action that was used');
});

test('backend progress events render phase, bounded progress and errors via text only',async()=>{
  let push;
  const app=boot(baseMonitor({wslState:async()=>state({targets:[target()]}),onWslUpdate:callback=>{push=callback;return ()=>{push=null;};}}));await flush();
  push(state({busy:true,targets:[target({phase:'downloading',progress:{received:5*1048576,total:10*1048576},error:'오류 <img src=x>'})]}));
  const bar=app.el('wsl-targets').all().find(node=>node.tagName==='progress');
  assert.equal(bar.max,10*1048576);assert.equal(bar.value,5*1048576);assert.match(bar.attributes['aria-label'],/진행률/);
  const texts=app.el('wsl-targets').texts();
  assert.ok(texts.includes('다운로드 중'));assert.ok(texts.includes('5 / 10 MB'));assert.ok(texts.includes('오류 <img src=x>'));
  assert.ok(buttons(app).every(node=>node.disabled),'backend busy disables all target actions');
  push(state({targets:[target({progress:{received:99,total:0}})]}));
  assert.equal(app.el('wsl-targets').all().some(node=>node.tagName==='progress'),false);
  assert.equal(button(app,'probe:Ubuntu').disabled,false);
});

test('rejected or malformed WSL responses show a retryable error and never throw',async()=>{
  const app=boot(baseMonitor({wslState:async()=>{throw new Error('ipc');},wslRefresh:async()=>null}));await flush();
  assert.match(app.el('wsl-message').textContent,/실패/);assert.equal(app.el('wsl-refresh').disabled,false);
  app.el('wsl-refresh').click();await flush();
  assert.match(app.el('wsl-message').textContent,/해석하지 못했습니다/);
});

test('unsubscribes on pagehide when the backend returns an unsubscribe function',async()=>{
  let unsubscribed=0;
  const app=boot(baseMonitor({wslState:async()=>state(),onWslUpdate:()=>()=>{unsubscribed++;}}));await flush();
  assert.equal(unsubscribed,0);app.windowListeners.pagehide();assert.equal(unsubscribed,1);
});
