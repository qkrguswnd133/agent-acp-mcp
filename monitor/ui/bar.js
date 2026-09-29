const buttons=[...document.querySelectorAll('[data-agent]')];
const validPercent=value=>typeof value==='number'&&Number.isFinite(value);
const tone=(value,unavailable)=>unavailable||!validPercent(value)?'unknown':value>=90?'limited':value>=70?'warning':'ready';
function render(state){const pin=document.querySelector('#pin');pin.setAttribute('aria-pressed',String(state.pinned!==false));pin.title=state.pinned!==false?'항상 위에 표시 켜짐 · 클릭하여 해제':'항상 위에 표시 꺼짐 · 클릭하여 고정';for(const button of buttons){
  const provider=state.snapshot?.providers?.find(p=>p.provider===button.dataset.agent),quota=provider?.quota??{};
  const missing=quota.unavailableReason==='missing_percentage';
  const old=!!(state.error||quota.stale||state.snapshot?.generatedAt&&Date.now()-Date.parse(state.snapshot.generatedAt)>150000);
  const unavailable=old||!provider||provider.enabled===false||provider.available===false||provider.authenticated===false||quota.state==='unknown';
  const windows=(quota.windows??[]).filter(w=>['five_hour','seven_day'].includes(w.id)).sort((a,b)=>(a.id==='five_hour'?0:1)-(b.id==='five_hour'?0:1));
  const entries=button.dataset.agent==='claude'?['five_hour','seven_day','seven_day_fable'].map(id=>{const w=quota.windows?.find(w=>w.id===id);return {id,label:id==='five_hour'?'5시간':id==='seven_day'?'주간 전체':'주간 Fable',used:w?.usedPercent,expired:w?.resetsAt&&Date.parse(w.resetsAt)<=Date.now()};}):windows.length?windows.map(w=>({label:w.id==='five_hour'?'5시간':'주간',used:w.usedPercent})): [{label:button.dataset.agent==='grok'?'주간':null,used:quota.usedPercent}];
  const values=button.querySelector('.quota-values');values.replaceChildren();
  const descriptions=[];
  entries.forEach((entry,index)=>{
    if(index){const separator=document.createElement('span');separator.className='quota-separator';separator.textContent='/';values.append(separator);}
    const number=document.createElement('b');number.className='quota-number';number.dataset.window=entry.id??'';number.dataset.usage=tone(entry.used,unavailable||entry.expired);
    number.textContent=validPercent(entry.used)?`${entry.used}%`:missing?'미제공':'—';
    number.title=`${entry.label??'사용량'} · ${validPercent(entry.used)?`${entry.used}% 사용`:missing?'사용률 미제공':'사용률 확인 불가'}`;
    values.append(number);descriptions.push(`${entry.label?entry.label+' ':''}${validPercent(entry.used)?`${entry.used}% 사용`:missing?'사용률 미제공':'사용률 확인 불가'}`);
  });
  const highest=windows.length?Math.max(...windows.map(w=>w.usedPercent).filter(validPercent)):quota.usedPercent;
  button.dataset.state=old?'stale':!provider?'loading':provider.enabled===false?'disabled':provider.available===false||provider.authenticated===false?'error':quota.state==='exhausted'?'limited':tone(highest,unavailable);
  button.title=`${button.dataset.agent} · ${descriptions.join(' / ')}${old?' · 마지막 확인값':''}`;
}}
for(const button of buttons){const open=()=>window.monitor.open(button.dataset.agent);button.addEventListener('mouseenter',open);button.addEventListener('focus',open);button.addEventListener('click',open);}
window.monitor.onState(render);window.monitor.onProvider(provider=>buttons.forEach(b=>b.classList.toggle('active',b.dataset.agent===provider)));window.monitor.state().then(render);document.querySelector('#menu').addEventListener('click',()=>window.monitor.menu());document.addEventListener('keydown',event=>{if(event.key==='Escape')window.monitor.close();});

document.querySelector('#pin').addEventListener('click',()=>window.monitor.togglePin());
const updateButton=document.querySelector('#updates');updateButton.addEventListener('click',()=>window.monitor.openUpdates());
function renderUpdate(value){const installed=value?.installed?.version,latest=value?.selected?.version;updateButton.hidden=!latest||latest===installed||!!value?.blocked;updateButton.title=`${latest||''} 업데이트 사용 가능`;}
window.monitor.onUpdate(renderUpdate);window.monitor.updateState().then(renderUpdate);

