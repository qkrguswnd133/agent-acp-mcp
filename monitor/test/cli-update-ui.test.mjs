import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read=name=>fs.readFileSync(new URL(`../${name}`,import.meta.url),'utf8');
const ui=name=>read(`ui/${name}`);
const html=ui('update.html');

class El{
  constructor(tag,id=''){this.tagName=tag;this.id=id;this.children=[];this.listeners={};this.attributes={};this.dataset={};this.textContent='';this.className='';this.hidden=false;this.disabled=false;this.open=false;this.tabIndex=0;this.title='';this.scrolled=false;}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=[...nodes];}
  setAttribute(name,value){this.attributes[name]=String(value);}
  addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);}
  click(){if(this.disabled)return;this.focus();for(const fn of this.listeners.click||[])fn();}
  focus(){this.ownerDocument.activeElement=this;}
  scrollIntoView(){this.scrolled=true;}
  all(){return this.children.flatMap(child=>[child,...child.all()]);}
  texts(){return this.all().map(node=>node.textContent).filter(Boolean);}
}
function boot(monitor){
  const elements=new Map();
  const document={body:new El('body'),activeElement:null,getElementById:id=>elements.get(id)||null,createElement:tag=>{const el=new El(tag);el.ownerDocument=document;return el;}};
  document.body.ownerDocument=document;document.activeElement=document.body;
  for(const [,id] of html.matchAll(/\sid="([^"]+)"/g)){const el=document.createElement('div');el.id=id;elements.set(id,el);}
  for(const id of ['wsl-section','cli-section','individual-section'])if(new RegExp(`id="${id}"[^>]*\\shidden`).test(html))elements.get(id).hidden=true;
  const windowListeners={};
  const context={document,console,Date,Number,Math,Map,Set,Array,Object,Promise,setTimeout,addEventListener:(type,fn)=>{windowListeners[type]=fn;}};
  context.window=context;context.monitor=monitor;vm.createContext(context);
  for(const file of ['update-flow.js','update.js','cli-update.js'])vm.runInContext(ui(file),context);
  return {context,windowListeners,el:id=>elements.get(id),document};
}
const flush=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
function baseMonitor(extra={}){return {onUpdate:()=>()=>{},updateState:async()=>({}),updateCheck:async()=>{},updateRun:async()=>({started:true}),updateCancel(){},...extra};}
const row=(patch={})=>({provider:'claude',currentVersion:'1.0.0',latestVersion:'1.1.0',path:'C:\\Tools\\claude.cmd',method:'npm',status:'available',...patch});
const win=(rows,patch={})=>({id:'windows',name:'Windows',running:true,rows,...patch});
const wsl=(rows,patch={})=>({id:'wsl:Ubuntu',name:'Ubuntu',running:true,rows,...patch});
const snap=(targets,patch={})=>({busy:false,targets,...patch});
const buttons=app=>app.el('cli-targets').all().filter(node=>node.tagName==='button'&&!node.dataset.cliKey.endsWith('|detail'));
const byKey=(app,key)=>app.el('cli-targets').all().find(node=>node.dataset.cliKey===key)||(key.startsWith('|')?app.el(key==='||all'?'cli-run-all':'cli-refresh'):undefined);
const rowNode=(app,id,provider)=>app.el('cli-targets').all().find(node=>node.dataset.cliKey===`${id}|${provider}|row`);

test('markup ships a hidden, collapsed, labelled section loaded after update.js with no remote content',()=>{
  assert.match(html,/<details id="cli-section"[^>]*\shidden/);assert.doesNotMatch(html,/<details id="cli-section"[^>]*\sopen/);
  assert.match(html,/id="cli-message"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html,/<ul id="cli-targets"[^>]*aria-label=/);assert.match(html,/id="cli-refresh"[^>]*aria-label="/);
  assert.ok(html.indexOf('src="update.js"')<html.indexOf('src="cli-update.js"'));
  assert.doesNotMatch(html,/https?:\/\//);
  const css=ui('update.css');for(const token of ['.cli-row:focus','forced-colors','prefers-reduced-motion','.cli-detail[hidden]'])assert.ok(css.includes(token),token);
  assert.doesNotMatch(ui('cli-update.js'),/innerHTML|outerHTML|insertAdjacentHTML/);
});

test('missing CLI API leaves the section hidden and the Windows update window working',async()=>{
  const app=boot(baseMonitor({updateState:async()=>({phase:'idle',installed:{version:'1.0.0'},selected:{version:'1.1.0',publishedAt:'2026-01-01',size:2097152,components:{gateway:'2',monitor:'1'},notes:{gateway:['a'],monitor:['b']}}})}));await flush();
  assert.equal(app.el('cli-section').hidden,true);assert.equal(app.el('status').textContent,'업데이트 사용 가능');
});

test('initial load renders compact rows per environment with Korean status, counts and batch count',async()=>{
  const app=boot(baseMonitor({cliState:async()=>snap([win([row(),row({provider:'codex',status:'current',currentVersion:'2.0.0',latestVersion:'2.0.0'}),row({provider:'grok',status:'manual'})]),wsl([row({status:'error',message:'<img src=x>'}),row({provider:'codex',status:'missing',currentVersion:null,latestVersion:null})])])}));await flush();
  assert.equal(app.el('cli-section').hidden,false);
  const targets=app.el('cli-targets').children;assert.equal(targets.length,2);
  assert.deepEqual(targets.map(node=>node.children[0].children[0].textContent),['Windows','Ubuntu']);
  const texts=app.el('cli-targets').texts();
  for(const label of ['업데이트 가능','최신 버전','수동 업데이트 필요','확인 실패','설치되지 않음','현재 1.0.0 · 최신 1.1.0','현재 알 수 없음 · 최신 알 수 없음','실행 중'])assert.ok(texts.includes(label),label);
  assert.equal(app.el('cli-run-all').textContent,'CLI 모두 업데이트 (1)');assert.equal(app.el('cli-run-all').disabled,false);
  assert.equal(app.el('cli-badge').textContent,'업데이트 1개');
  assert.equal(app.el('cli-message').textContent,'업데이트 가능 1개 · 수동 업데이트 1개 · 확인 필요 1개');
  assert.equal(app.el('cli-targets').children[0].children[1].attributes['aria-label'],'Windows Agent CLI 목록');
  assert.ok(byKey(app,'windows|claude|update').attributes['aria-label'].includes('Windows Claude'));
  assert.equal(byKey(app,'windows|codex|update'),undefined,'only available rows get an action');
});

test('detail path and method stay collapsed until toggled with aria-expanded and survive re-render',async()=>{
  let push;const app=boot(baseMonitor({cliState:async()=>snap([win([row({message:'확인 <b>필요</b>',status:'blocked'})])]),onCliState:callback=>{push=callback;return ()=>{};}}));await flush();
  const toggle=byKey(app,'windows|claude|detail'),detail=app.el('cli-targets').all().find(node=>node.tagName==='dl');
  assert.equal(toggle.attributes['aria-expanded'],'false');assert.equal(detail.hidden,true);assert.equal(toggle.attributes['aria-controls'],detail.id);
  assert.ok(detail.texts().includes('C:\\Tools\\claude.cmd'));assert.ok(detail.texts().includes('npm'));assert.ok(detail.texts().includes('확인 <b>필요</b>'));
  toggle.click();
  const open=byKey(app,'windows|claude|detail');assert.equal(open.attributes['aria-expanded'],'true');assert.equal(app.el('cli-targets').all().find(node=>node.tagName==='dl').hidden,false);
  assert.equal(app.document.activeElement,open,'focus returns to the rebuilt toggle');
  push(snap([win([row({status:'blocked'})])]));
  assert.equal(app.el('cli-targets').all().find(node=>node.tagName==='dl').hidden,false,'expansion persists across state events');
  assert.equal(app.document.activeElement,byKey(app,'windows|claude|detail'));
});

test('individual update passes environment id and provider exactly once and locks every action meanwhile',async()=>{
  const calls=[];let release;
  const app=boot(baseMonitor({cliState:async()=>snap([win([row()]),wsl([row({provider:'codex'})])]),cliRun:(...args)=>{calls.push(args);return new Promise(resolve=>{release=resolve;});}}));await flush();
  const update=byKey(app,'wsl:Ubuntu|codex|update');update.click();update.click();await flush();
  assert.deepEqual(calls,[['wsl:Ubuntu','codex']]);
  assert.ok(buttons(app).every(node=>node.disabled),'every update/check action is disabled while running (detail toggles stay usable)');
  assert.equal(app.el('cli-refresh').disabled,true);assert.equal(app.el('cli-run-all').disabled,true);
  release(snap([win([row()]),wsl([row({provider:'codex',status:'updated',currentVersion:'1.1.0'})])]));await flush();
  assert.deepEqual(calls,[['wsl:Ubuntu','codex']]);
  assert.equal(app.el('cli-run-all').textContent,'CLI 모두 업데이트 (1)');assert.equal(app.el('cli-refresh').disabled,false);
  assert.equal(app.document.activeElement,byKey(app,'wsl:Ubuntu|codex|detail'),'focus stays within the row after the action button disappears');
});

test('batch action calls cliRun with no arguments and refresh calls cliRefresh with none',async()=>{
  const calls=[];
  const app=boot(baseMonitor({cliState:async()=>snap([win([row(),row({provider:'codex'})])]),cliRun:async(...args)=>{calls.push(['run',...args]);return null;},cliRefresh:async(...args)=>{calls.push(['refresh',...args]);return null;}}));await flush();
  assert.equal(app.el('cli-run-all').textContent,'CLI 모두 업데이트 (2)');
  app.el('cli-run-all').click();await flush();app.el('cli-refresh').click();await flush();
  assert.deepEqual(calls,[['run'],['refresh']]);
  assert.equal(app.el('cli-message').attributes.role,'status','a non-snapshot acknowledgement is not an error');
  assert.equal(app.el('cli-run-all').textContent,'CLI 모두 업데이트 (2)');
});

test('no available rows disables the batch action; stopped WSL is never woken passively',async()=>{
  const calls=[];
  const app=boot(baseMonitor({cliState:async()=>{calls.push('state');return snap([win([row({status:'current'})]),wsl([row()],{running:false})]);},cliRefresh:async(...args)=>{calls.push(['refresh',...args]);return snap([win([row({status:'current'})]),wsl([row()])]);}}));await flush();
  assert.deepEqual(calls,['state']);
  assert.equal(app.el('cli-run-all').textContent,'CLI 모두 업데이트 (0)');assert.equal(app.el('cli-run-all').disabled,true,'rows of a stopped distro are not counted');
  assert.equal(byKey(app,'wsl:Ubuntu|claude|update').disabled,true);
  const start=byKey(app,'wsl:Ubuntu||refresh');assert.equal(start.textContent,'시작하고 확인');assert.match(start.attributes['aria-label'],/시작하고/);
  assert.ok(app.el('cli-targets').texts().some(text=>text.includes('직접 시작')));assert.ok(app.el('cli-targets').texts().includes('중지됨'));
  assert.match(html,/id="cli-refresh"[^>]*aria-label="[^"]*시작하지 않음/);
  app.el('cli-refresh').click();await flush();assert.deepEqual(calls,['state',['refresh']]);
  start.click();await flush();assert.deepEqual(calls,['state',['refresh'],['refresh','wsl:Ubuntu']]);
  assert.equal(byKey(app,'wsl:Ubuntu||refresh').textContent,'확인');
  assert.equal(app.el('cli-run-all').textContent,'CLI 모두 업데이트 (1)','the started distro now counts');
});

test('state-changed events win over stale invoke results and busy/progress disables actions',async()=>{
  let push,releaseState;
  const app=boot(baseMonitor({cliState:()=>new Promise(resolve=>{releaseState=resolve;}),onCliState:callback=>{push=callback;return ()=>{};}}));await flush();
  assert.equal(app.el('cli-badge').textContent,'확인 중');assert.equal(app.el('cli-message').textContent,'Agent CLI 상태를 확인하는 중입니다.');
  push(snap([win([row({status:'updating'})])],{busy:true}));
  releaseState(snap([win([row({status:'current'})])]));await flush();
  assert.ok(app.el('cli-targets').texts().includes('업데이트 중'),'the older initial response does not overwrite the newer event');
  assert.equal(app.el('cli-badge').textContent,'진행 중');assert.ok(buttons(app).every(node=>node.disabled));assert.equal(app.el('cli-refresh').disabled,true);
  for(const status of ['checking','verifying'])push(snap([win([row({status})])]),{}),assert.ok(app.el('cli-targets').texts().includes(status==='checking'?'확인 중':'검증 중'));
  push(snap([win([row({status:'updated'})])]));assert.ok(app.el('cli-targets').texts().includes('업데이트 완료'));assert.equal(app.el('cli-refresh').disabled,false);
  push({bogus:true});assert.ok(app.el('cli-targets').texts().includes('업데이트 완료'),'malformed events are ignored');
});

test('backend busy and the app-wide update flow both lock CLI actions',async()=>{
  let push,updatePush;
  const app=boot(baseMonitor({onUpdate:callback=>{updatePush=callback;return ()=>{};},cliState:async()=>snap([win([row()])]),onCliState:callback=>{push=callback;return ()=>{};}}));await flush();
  assert.equal(app.el('cli-run-all').disabled,false);
  push(snap([win([row()])],{busy:true}));assert.equal(app.el('cli-run-all').disabled,true);assert.ok(buttons(app).every(node=>node.disabled));
  push(snap([win([row()])]));assert.equal(app.el('cli-run-all').disabled,false);
  updatePush({unified:{active:true,status:'running',message:'진행',targets:[]}});
  assert.equal(app.el('cli-run-all').disabled,true);assert.equal(app.el('cli-refresh').disabled,true);
  updatePush({unified:{active:false,status:'idle',targets:[]}});assert.equal(app.el('cli-run-all').disabled,false);
});

test('rejected or malformed responses show a retryable alert and never throw',async()=>{
  const app=boot(baseMonitor({cliState:async()=>{throw new Error('ipc');},cliRefresh:async()=>{throw new Error('ipc');}}));await flush();
  assert.match(app.el('cli-message').textContent,/가져오지 못했습니다/);assert.equal(app.el('cli-message').attributes.role,'alert');assert.equal(app.el('cli-refresh').disabled,false);
  app.el('cli-refresh').click();await flush();assert.match(app.el('cli-message').textContent,/실패/);assert.equal(app.el('cli-refresh').disabled,false);
  const malformed=boot(baseMonitor({cliState:async()=>({nope:1})}));await flush();
  assert.match(malformed.el('cli-message').textContent,/해석하지 못했습니다/);
});

test('empty snapshot and hostile values render as text only with bounded fields',async()=>{
  const empty=boot(baseMonitor({cliState:async()=>snap([])}));await flush();
  assert.equal(empty.el('cli-message').textContent,'Agent CLI 환경을 찾지 못했습니다.');assert.equal(empty.el('cli-badge').textContent,'환경 없음');
  const app=boot(baseMonitor({cliState:async()=>snap([win([row({status:'weird',currentVersion:'x'.repeat(500)}),{provider:'',status:'available'},null])])}));await flush();
  assert.equal(app.el('cli-targets').all().filter(node=>node.className==='cli-row').length,1);
  assert.ok(app.el('cli-targets').texts().includes('확인 필요'));
  assert.ok(app.el('cli-targets').texts().some(text=>text.includes('x'.repeat(64))&&!text.includes('x'.repeat(65))));
});

test('cli-focus opens the section and focuses the Windows provider row, also when it arrives before the first load',async()=>{
  let focus,releaseState;
  const app=boot(baseMonitor({cliState:()=>new Promise(resolve=>{releaseState=resolve;}),onCliFocus:callback=>{focus=callback;return ()=>{};}}));await flush();
  focus('codex');assert.equal(app.el('cli-section').open,true,'section opens immediately');assert.notEqual(app.document.activeElement?.dataset?.provider,'codex');
  releaseState(snap([wsl([row({provider:'codex'})]),win([row(),row({provider:'codex'})])]));await flush();
  const target=rowNode(app,'windows','codex');assert.equal(app.document.activeElement,target,'Windows row is focused, not the WSL one');assert.equal(target.scrolled,true);
  const wslRow=rowNode(app,'wsl:Ubuntu','codex');assert.notEqual(app.document.activeElement,wslRow);
  focus('claude');assert.equal(app.document.activeElement,rowNode(app,'windows','claude'));
  focus('unknown');assert.equal(app.document.activeElement,app.el('cli-summary')||app.document.body);
});

test('focus survives later state events and unsubscribes happen on pagehide',async()=>{
  let push,focus;const offs=[];
  const app=boot(baseMonitor({cliState:async()=>snap([win([row()])]),onCliState:callback=>{push=callback;return ()=>offs.push('state');},onCliFocus:callback=>{focus=callback;return ()=>offs.push('focus');}}));await flush();
  focus('claude');assert.equal(app.document.activeElement,rowNode(app,'windows','claude'));
  push(snap([win([row({latestVersion:'1.2.0'})])]));assert.equal(app.document.activeElement,rowNode(app,'windows','claude'),'focus is restored on the rebuilt row');
  assert.deepEqual(offs,[]);app.windowListeners.pagehide();assert.deepEqual(offs.sort(),['focus','state']);
});

test('preload exposes the CLI contract and buffers cli-focus until the renderer subscribes',()=>{
  const invoked=[],sent=[],handlers=new Map();let exposed;
  const electron={contextBridge:{exposeInMainWorld:(_name,api)=>{exposed=api;}},ipcRenderer:{invoke:(...args)=>{invoked.push(args);return Promise.resolve(null);},send:(...args)=>sent.push(args),on:(channel,fn)=>{handlers.set(channel,fn);},removeListener:(channel,fn)=>{if(handlers.get(channel)===fn)handlers.delete(channel);}}};
  new Function('require',read('preload.cjs'))(name=>name==='electron'?electron:undefined);
  exposed.cliState();exposed.cliRefresh();exposed.cliRefresh('wsl:Ubuntu');exposed.cliRun();exposed.cliRun('windows','claude');exposed.openCliUpdates('codex');
  assert.deepEqual(invoked,[['cli-state'],['cli-refresh'],['cli-refresh','wsl:Ubuntu'],['cli-run'],['cli-run','windows','claude']]);
  assert.deepEqual(sent,[['open-cli-updates','codex']]);
  handlers.get('cli-focus')({},'claude');handlers.get('cli-focus')({},'codex');handlers.get('cli-focus')({},42);
  const received=[];const off=exposed.onCliFocus(provider=>received.push(provider));
  assert.deepEqual(received,['codex'],'only the latest valid pending focus is replayed once');
  handlers.get('cli-focus')({},'grok');assert.deepEqual(received,['codex','grok']);
  off();handlers.get('cli-focus')({},'claude');assert.deepEqual(received,['codex','grok']);
  const states=[];const offState=exposed.onCliState(value=>states.push(value));handlers.get('cli-state-changed')({},{busy:false,targets:[]});assert.equal(states.length,1);
  offState();assert.equal(handlers.has('cli-state-changed'),false);
});

test('detail panel manage link opens the per-provider CLI update view',()=>{
  const detailHtml=ui('detail.html'),detailJs=ui('detail.js');
  assert.match(detailHtml,/<button id="manage-cli"[^>]*type="button"/);
  assert.match(detailJs,/\$\('manage-cli'\)\.addEventListener\('click',\(\)=>window\.monitor\.openCliUpdates\?\.\(selected\)\)/);
  assert.match(detailJs,/manage-cli'\)\.setAttribute\('aria-label'/);
  assert.match(ui('style.css'),/\.link-button/);
});
