(()=>{
const doc=document;
const $=id=>doc.getElementById(id);
const api=()=>window.monitor;
const providerNames={grok:'Grok',claude:'Claude',codex:'Codex'};
const statusLabels={available:'업데이트 가능',current:'최신 버전',manual:'수동 업데이트 필요',missing:'설치되지 않음',error:'확인 실패',checking:'확인 중',updating:'업데이트 중',verifying:'검증 중',updated:'업데이트 완료',blocked:'보류됨',unknown:'확인 필요'};
const activeStatuses=['checking','updating','verifying'];
const cli={state:null,pending:false,error:'',seq:0,external:false,expanded:new Set(),controls:new Map(),rows:new Map(),focusRequest:null,prefer:null,unsubscribers:[],ready:false};
const apiReady=()=>typeof api()?.cliState==='function';
const text=(value,max=300)=>typeof value==='string'?value.trim().slice(0,max):'';
const providerName=provider=>providerNames[provider]||provider;
function normalize(value){
  if(!value||typeof value!=='object'||!Array.isArray(value.targets))return null;
  const targets=value.targets.filter(target=>target&&typeof target.id==='string'&&target.id).slice(0,33).map(target=>({
    id:target.id,name:text(target.name,80)||target.id.slice(0,80),running:target.running===true,
    rows:(Array.isArray(target.rows)?target.rows:[]).filter(row=>row&&typeof row.provider==='string'&&text(row.provider,32)).slice(0,8).map(row=>({
      provider:text(row.provider,32).toLowerCase(),currentVersion:text(row.currentVersion,64)||null,latestVersion:text(row.latestVersion,64)||null,
      path:text(row.path,500)||null,method:text(row.method,160)||null,status:Object.hasOwn(statusLabels,row.status)?row.status:'unknown',message:text(row.message)||null,lastResult:row.lastResult,retryable:row.retryable===true
    }))
  }));
  return {busy:value.busy===true,targets};
}
const isWsl=target=>target.id.startsWith('wsl:');
const offered=row=>row.status==='available'||(row.status==='blocked'&&row.retryable);
const rowActive=row=>activeStatuses.includes(row.status);
function busy(){return cli.pending||cli.external||cli.state?.busy===true||!!cli.state?.targets.some(target=>target.rows.some(rowActive));}
function summarize(state){
  const total={available:0,manual:0,error:0,active:0};
  for(const target of state.targets)for(const row of target.rows){
    if(offered(row)&&target.running)total.available++;
    else if(row.status==='manual')total.manual++;
    else if(['error','blocked','unknown'].includes(row.status))total.error++;
    else if(rowActive(row))total.active++;
  }
  return total;
}
function el(tag,className,content){const node=doc.createElement(tag);if(className)node.className=className;if(content!==undefined)node.textContent=content;return node;}
function control(label,aria,key,disabled,handler,className='cli-button'){
  const button=el('button',className,label);button.type='button';button.setAttribute('aria-label',aria);button.disabled=disabled;button.dataset.cliKey=key;
  button.addEventListener('click',()=>{cli.prefer=key;handler();});cli.controls.set(key,button);return button;
}
function detailLine(list,label,value,className=''){
  const wrap=el('div','cli-detail-line'),term=el('dt','',label),desc=el('dd',className,value);wrap.append(term,desc);list.append(wrap);
}
function versionText(row){return `현재 ${row.currentVersion||'알 수 없음'} · 최신 ${row.latestVersion||'알 수 없음'}`;}
function renderRow(target,row,index,disabled){
  const rowKey=`${target.id}|${row.provider}`,expanded=cli.expanded.has(rowKey),detailId=`cli-detail-${cli.targetIndex}-${index}`,name=providerName(row.provider);
  const item=el('li','cli-row');item.tabIndex=-1;item.dataset.status=row.status;item.dataset.provider=row.provider;item.dataset.cliKey=`${rowKey}|row`;cli.controls.set(item.dataset.cliKey,item);
  if(target.id==='windows')cli.rows.set(row.provider,item);
  const main=el('div','cli-main');
  main.append(el('strong','cli-provider',name),el('span','cli-version',versionText(row)),el('span','cli-status',statusLabels[row.status]));
  const actions=el('div','cli-row-actions');
  const toggle=control(expanded?'접기':'상세',`${target.name} ${name} 경로와 업데이트 방식 ${expanded?'접기':'펼치기'}`,`${rowKey}|detail`,false,()=>{if(cli.expanded.has(rowKey))cli.expanded.delete(rowKey);else cli.expanded.add(rowKey);render();});
  toggle.setAttribute('aria-expanded',String(expanded));toggle.setAttribute('aria-controls',detailId);actions.append(toggle);
  if(offered(row))actions.append(control(row.retryable?'다시 시도':'업데이트',`${target.name} ${name} 업데이트`,`${rowKey}|update`,disabled||!target.running,()=>void invoke('cliRun',target.id,row.provider)));
  main.append(actions);item.append(main);
  const detail=el('dl','cli-detail');detail.id=detailId;detail.hidden=!expanded;
  detailLine(detail,'경로',row.path||'확인 불가','cli-path');detailLine(detail,'업데이트 방식',row.method||'확인 불가');
  if(row.lastResult?.status&&statusLabels[row.lastResult.status]){
    const last=row.lastResult;
    detailLine(detail,'지난 업데이트',[statusLabels[last.status],last.previousVersion&&last.currentVersion?last.previousVersion+' → '+last.currentVersion:'',text(last.message)].filter(Boolean).join(' · '));
  }
  if(row.message)detailLine(detail,'메시지',row.message,['error','blocked'].includes(row.status)?'cli-error':'');
  item.append(detail);return item;
}
function renderTarget(target,index,disabled){
  cli.targetIndex=index;
  const item=el('li','cli-target'),head=el('div','cli-target-head'),title=el('h3','',target.name);
  head.append(title);
  if(isWsl(target)){const state=el('span',target.running?'cli-state running':'cli-state',target.running?'실행 중':'중지됨');head.append(state);}
  item.append(head);
  const list=el('ul','cli-rows');list.setAttribute('aria-label',`${target.name} Agent CLI 목록`);
  target.rows.forEach((row,rowIndex)=>list.append(renderRow(target,row,rowIndex,disabled)));
  if(target.rows.length)item.append(list);
  else item.append(el('p','cli-note',target.running?'확인된 Agent CLI가 없습니다.':'확인된 Agent CLI 정보가 없습니다.'));
  if(!target.running)item.append(el('p','cli-note','배포판이 중지되어 있습니다. 확인하려면 직접 시작해야 합니다.'));
  const tools=el('div','cli-target-actions'),stopped=!target.running;
  const check=control(stopped?'시작하고 확인':'확인',stopped?`${target.name} 배포판을 시작하고 Agent CLI 상태 확인`:`${target.name} Agent CLI 상태 확인`,`${target.id}||refresh`,disabled,()=>void invoke('cliRefresh',target.id));
  if(stopped)check.title='중지된 배포판을 시작합니다';
  tools.append(check);
  item.append(tools);return item;
}
function messageFor(state,summary){
  if(cli.error)return cli.error;
  if(!state)return 'Agent CLI 상태를 확인하는 중입니다.';
  if(!state.targets.length)return 'Agent CLI 환경을 찾지 못했습니다.';
  if(busy())return 'Agent CLI 작업을 진행하는 중입니다.';
  const parts=[];if(summary.available)parts.push(`업데이트 가능 ${summary.available}개`);if(summary.manual)parts.push(`수동 업데이트 ${summary.manual}개`);if(summary.error)parts.push(`확인 필요 ${summary.error}개`);
  return parts.length?parts.join(' · '):'업데이트할 CLI가 없습니다.';
}
function badgeFor(state,summary){
  if(!state)return '확인 중';if(busy()&&(summary.active||state.busy))return '진행 중';
  return summary.available?`업데이트 ${summary.available}개`:summary.manual?`수동 ${summary.manual}개`:summary.error?'확인 필요':state.targets.length?'확인 완료':'환경 없음';
}
function render(){
  const section=$('cli-section');if(!section)return;
  section.hidden=!apiReady();if(section.hidden)return;
  const active=doc.activeElement,keepKey=active?.dataset?.cliKey;
  cli.controls=new Map();cli.rows=new Map();
  const state=cli.state,disabled=busy(),summary=state?summarize(state):{available:0,manual:0,error:0,active:0};
  $('cli-badge').textContent=badgeFor(state,summary);
  const message=$('cli-message');message.textContent=messageFor(state,summary);message.setAttribute('role',cli.error?'alert':'status');
  const list=$('cli-targets');list.replaceChildren();
  (state?.targets||[]).forEach((target,index)=>list.append(renderTarget(target,index,disabled)));
  const refresh=$('cli-refresh'),runAll=$('cli-run-all');
  refresh.dataset.cliKey='||refresh';refresh.disabled=disabled;cli.controls.set('||refresh',refresh);
  runAll.dataset.cliKey='||all';runAll.textContent=`CLI 모두 업데이트 (${summary.available})`;runAll.setAttribute('aria-label',`업데이트 가능한 Agent CLI ${summary.available}개 모두 업데이트`);
  runAll.disabled=disabled||summary.available===0;cli.controls.set('||all',runAll);
  restoreFocus(keepKey);applyFocus();
}
function restoreFocus(key){
  if(!key||doc.activeElement===cli.controls.get(key))return;
  const rowOf=value=>value.slice(0,value.lastIndexOf('|')),candidates=[key];
  if(cli.prefer&&key!==cli.prefer&&rowOf(key)===rowOf(cli.prefer))candidates.unshift(cli.prefer);
  if(!key.includes('||'))candidates.push(`${rowOf(key)}|detail`,`${rowOf(key)}|row`);
  for(const candidate of candidates){const node=cli.controls.get(candidate);if(node&&!node.disabled){node.focus();return;}}
}
function applyFocus(){
  const provider=cli.focusRequest;if(!provider)return;
  const section=$('cli-section');if(section.hidden)return;
  section.open=true;
  if(!cli.state)return;
  cli.focusRequest=null;
  const row=cli.rows.get(provider);
  if(row){row.focus();row.scrollIntoView?.({block:'center'});}
  else $('cli-summary')?.focus?.();
}
async function invoke(method,...args){
  const fn=api()?.[method];if(cli.pending||typeof fn!=='function')return;
  const seq=cli.seq;cli.pending=true;cli.error='';render();
  try{const next=normalize(await fn.apply(api(),args));if(next&&cli.seq===seq)cli.state=next;}
  catch{cli.error='Agent CLI 요청에 실패했습니다. 다시 시도하세요.';}
  finally{cli.pending=false;render();}
}
function receive(value){const next=normalize(value);if(!next)return;cli.seq++;cli.state=next;cli.error='';render();}
async function load(){
  const seq=cli.seq;
  try{const next=normalize(await api().cliState());if(next&&cli.seq===seq)cli.state=next;else if(!next&&cli.seq===seq)cli.error='Agent CLI 응답을 해석하지 못했습니다.';}
  catch{if(cli.seq===seq)cli.error='Agent CLI 상태를 가져오지 못했습니다. 다시 시도하세요.';}
  render();
}
function focusProvider(provider){if(typeof provider!=='string'||!provider)return;cli.focusRequest=provider.toLowerCase();if(cli.ready)render();}
window.cliUpdate={setExternalBusy(value){const next=value===true;if(cli.external===next)return;cli.external=next;if(cli.ready)render();},focusProvider};
if(apiReady()){
  $('cli-refresh').addEventListener('click',()=>{cli.prefer='||refresh';void invoke('cliRefresh');});
  $('cli-run-all').addEventListener('click',()=>{cli.prefer='||all';void invoke('cliRun');});
  if(typeof api().onCliState==='function'){const off=api().onCliState(receive);if(typeof off==='function')cli.unsubscribers.push(off);}
  window.addEventListener?.('pagehide',()=>{for(const off of cli.unsubscribers.splice(0))off();});
  cli.ready=true;render();
  if(typeof api().onCliFocus==='function'){const off=api().onCliFocus(focusProvider);if(typeof off==='function')cli.unsubscribers.push(off);}
  void load();
}
})();
