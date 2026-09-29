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
const updateButton=document.querySelector('#updates'),progressSection=document.querySelector('#update-progress'),stage=document.querySelector('#update-stage'),percent=document.querySelector('#update-percent'),meter=document.querySelector('#update-meter'),cancelButton=document.querySelector('#update-cancel'),closeButton=document.querySelector('#update-close');
let latestUpdateState=null,localFlowError=null,closeTimer;
const flow=window.createUpdateFlow(window.monitor,{onBusy:()=>renderUpdate(latestUpdateState),onError:()=>{localFlowError='업데이트 요청에 실패했습니다. 업데이트 창에서 상태를 확인하세요.';renderUpdate(latestUpdateState);}});
function renderUpdate(value){
  latestUpdateState=value||{};const action=value?.updateAction||{},phase=value?.phase,result=value?.result,open=value?.barProgressOpen===true,active=action.active===true||flow.isBusy();
  updateButton.hidden=action.available!==true;updateButton.disabled=action.active===true||flow.isBusy();updateButton.setAttribute('aria-expanded',String(open));
  updateButton.title=active?'업데이트 진행 중':action.canStart===false||value?.blocked||result?.status==='rollback_failed'?'업데이트 문제 확인':`${value?.selected?.version||''} 다운로드 및 설치`;updateButton.setAttribute('aria-label',updateButton.title);
  document.body.dataset.updateOpen=String(open);clearTimeout(closeTimer);
  if(open)progressSection.hidden=false;
  else{if(!progressSection.hidden)closeTimer=setTimeout(()=>{if(document.body.dataset.updateOpen==='false')progressSection.hidden=true;},matchMedia('(prefers-reduced-motion: reduce)').matches?0:180);return;}
  if(['downloading','preparing','installing'].includes(phase)||result?.status==='success')localFlowError=null;
  const error=localFlowError||value?.blocked||value?.error;
  let label,mode='progress';
  if(phase==='downloading')label='업데이트 다운로드 중';
  else if(phase==='preparing')label='다운로드 검증 · 설치 준비 중';
  else if(phase==='installing')label='설치 중 · 다시 시작합니다';
  else if(error){label=error;mode='error';}
  else if(result?.status==='success'){label='업데이트 완료';mode='success';}
  else if(result?.status==='rollback_failed'){label='수동 복구 필요 · 업데이트 창을 확인하세요';mode='error';}
  else if(result?.status==='rolled_back'){label='이전 버전으로 복구됨';mode='error';}
  else if(result?.status==='blocked'||result?.status==='failed'){label=result.message||'업데이트를 완료하지 못했습니다.';mode='error';}
  else if(phase==='downloaded')label='다운로드 검증 완료 · 설치 준비 중';
  else label='업데이트 상태 확인 중';
  stage.textContent=label;stage.title=label;progressSection.dataset.mode=mode;
  const downloading=phase==='downloading',received=value?.progress?.received,total=value?.progress?.total,hasProgress=downloading&&Number.isFinite(received)&&Number.isFinite(total)&&total>0;
  percent.hidden=!hasProgress;if(hasProgress){const used=Math.max(0,Math.min(100,Math.floor(received/total*100)));percent.textContent=`${used}%`;meter.value=used;meter.setAttribute('value',String(used));}
  else{percent.textContent='';meter.removeAttribute('value');}
  meter.hidden=mode==='error'||(!active&&mode!=='success');if(mode==='success'){meter.value=100;meter.setAttribute('value','100');}
  cancelButton.hidden=!['downloading','preparing'].includes(phase)&&!(phase==='downloaded'&&active);
  closeButton.hidden=active||mode!=='error';
}
updateButton.addEventListener('click',()=>{const action=latestUpdateState?.updateAction;if(action?.available!==true||action.active===true||flow.isBusy())return;if(action.canStart===false){window.monitor.openUpdates();return;}localFlowError=null;void flow.run();});
cancelButton.addEventListener('click',()=>flow.cancel());closeButton.addEventListener('click',()=>window.monitor.dismissUpdateProgress());
window.monitor.onUpdate(renderUpdate);window.monitor.updateState().then(renderUpdate);

