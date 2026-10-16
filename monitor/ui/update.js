const $=id=>document.getElementById(id);
const resultLabels={success:'완료',blocked:'설치 보류',failed:'실패',rolled_back:'이전 버전 복구',rollback_failed:'수동 복구 필요'};
let current={};
const flowHooks={
  onBusy:()=>render(current),
  onError:()=>{current={...current,error:'업데이트 요청에 실패했습니다. 다시 시도하세요.'};render(current);}
};
const flow=window.createUpdateFlow(window.monitor,flowHooks);
const windowsFlow=window.createUpdateFlow({updateRun:()=>window.monitor.updateWindows(),updateCancel:()=>window.monitor.updateCancel()},flowHooks);
const flowBusy=()=>flow.isBusy()||windowsFlow.isBusy();
let wslReady=false;
const unifiedStatusLabels={idle:'대기 중',preflight:'업데이트 대상 확인 중',running:'업데이트 진행 중',awaiting_windows:'Windows 설치 대기 중',completed:'전체 업데이트 완료',partial:'일부 업데이트 실패',blocked:'업데이트 보류',cancelled:'업데이트 취소됨',interrupted:'업데이트 중단됨'};
const unifiedTargetLabels={pending:'대기',checking:'확인 중',ready:'준비됨',running:'업데이트 중',completed:'완료',up_to_date:'최신 버전',skipped:'건너뜀',failed:'실패',blocked:'보류',cancelled:'취소됨'};
const unifiedErrorTargets=['failed','blocked'];
function unifiedText(value,max=300){return typeof value==='string'?value.trim().slice(0,max):'';}
function normalizeUnified(value){
  if(!value||typeof value!=='object')return null;
  const status=Object.hasOwn(unifiedStatusLabels,value.status)?value.status:'idle',active=value.active===true;
  const targets=(Array.isArray(value.targets)?value.targets:[]).filter(item=>item&&typeof item.id==='string'&&item.id).slice(0,33).map(item=>({id:item.id,name:unifiedText(item.name,80)||item.id.slice(0,80),kind:item.kind==='wsl'?'wsl':'windows',status:Object.hasOwn(unifiedTargetLabels,item.status)?item.status:'unknown',version:unifiedText(item.version,64),latestVersion:unifiedText(item.latestVersion,64),message:unifiedText(item.message)}));
  const currentId=typeof value.currentTarget==='string'?value.currentTarget:typeof value.currentTarget?.id==='string'?value.currentTarget.id:'';
  const partial=status==='completed'&&targets.some(item=>[...unifiedErrorTargets,'cancelled'].includes(item.status));
  return {active,status,outcome:partial?'partial':status,message:unifiedText(value.message),canCancel:active&&value.canCancel===true,targets,currentId};
}
const unifiedFailure=unified=>!!unified&&!unified.active&&['partial','blocked','interrupted'].includes(unified.outcome);
function renderUnified(unified){
  const panel=$('unified');if(!panel)return;
  panel.hidden=!unified||(!unified.active&&unified.status==='idle');if(panel.hidden)return;
  const tone=unifiedFailure(unified)?'error':unified.outcome==='completed'?'success':'neutral';
  panel.dataset.tone=tone;panel.dataset.status=unified.outcome;
  $('unified-status').textContent=unifiedStatusLabels[unified.outcome];
  $('unified-message').textContent=unified.message;$('unified-message').setAttribute('role',tone==='error'?'alert':'status');
  const list=$('unified-targets');list.replaceChildren();
  for(const item of unified.targets){
    const row=document.createElement('li'),name=document.createElement('strong'),state=document.createElement('span');
    row.className='unified-target';row.dataset.status=item.status;row.dataset.kind=item.kind;if(item.id===unified.currentId){row.dataset.current='true';row.setAttribute('aria-current','true');}
    name.textContent=item.name;state.textContent=unifiedTargetLabels[item.status]||'확인 필요';row.append(name,state);
    const versions=item.version||item.latestVersion?`${item.version||'알 수 없음'} → ${item.latestVersion||'알 수 없음'}`:'',detail=[versions,item.message].filter(Boolean).join(' · ');
    if(detail){const small=document.createElement('small');small.textContent=detail;row.append(small);}
    list.append(row);
  }
}
function historyRow(parent,title,description){const row=document.createElement('div'),name=document.createElement('strong'),detail=document.createElement('small');name.textContent=title;detail.textContent=description;row.append(name,detail);parent.append(row);}
function noteGroup(parent,title,values){const heading=document.createElement('h3'),list=document.createElement('ul');heading.textContent=title;for(const value of values||[]){const item=document.createElement('li');item.textContent=value;list.append(item);}parent.append(heading,list);}
function render(value){
  current=value||{};const phase=current.phase||'idle',release=current.selected,installed=current.installed,result=current.result,unified=normalizeUnified(current.unified),action=current.updateAction,unifiedActive=unified?.active===true;
  const newer=!!release&&(!installed?.version||release.version!==installed.version),recoveryFailed=result?.status==='rollback_failed',problem=current.blocked||current.error||(recoveryFailed?'자동 복구가 완료되지 않았습니다. 아래 백업 및 복구 안내를 확인하세요.':null);
  $('indicator').className=problem||unifiedFailure(unified)?'error':newer||action?.canStart===true?'available':'';
  $('status').textContent=unifiedActive?unified.message||unifiedStatusLabels[unified.status]:recoveryFailed?'수동 복구 필요':unifiedFailure(unified)||(unified?.outcome==='cancelled')?unifiedStatusLabels[unified.outcome]:phase==='checking'?'릴리스 확인 중':phase==='downloading'?'다운로드 중':phase==='preparing'?'설치 준비 중':phase==='installing'?'설치 프로그램 실행 중':recoveryFailed?'수동 복구 필요':current.blocked?'수동 설치 필요':current.error?'업데이트 확인 필요':!release?current.checkedAt?'확인된 릴리스 없음':'업데이트 확인 전':newer?'업데이트 사용 가능':'최신 버전 확인됨';
  $('detail').textContent=current.checkedAt?`마지막 확인 ${new Date(current.checkedAt).toLocaleString('ko-KR')}`:'GitHub 안정 릴리스를 확인합니다.';
  $('current-release').textContent=installed?.version||'알 수 없음';$('current-gateway').textContent=current.currentComponents?.gateway||'알 수 없음';$('current-monitor').textContent=current.currentComponents?.monitor||'알 수 없음';
  $('latest-release').textContent=release?.version||'—';$('latest-gateway').textContent=release?.components?.gateway||'—';$('latest-monitor').textContent=release?.components?.monitor||'—';
  $('release-meta').textContent=release?`${new Date(release.publishedAt).toLocaleDateString('ko-KR')} · ZIP ${Math.ceil(release.size/1048576)} MB`:'';
  $('error-panel').hidden=!problem;$('error-panel').textContent=problem||'';
  $('last-result').hidden=!result?.status;$('last-result').textContent=result?.status?`최근 Windows 설치: ${resultLabels[result.status]||'확인 필요'} · ${result.message||''}`:'';
  const backups=Array.isArray(result?.backups)?result.backups.filter(item=>typeof item==='string'&&item.trim()).slice(0,10):[];
  $('recovery').hidden=!backups.length&&result?.status!=='rollback_failed';$('recovery-details').open=result?.status==='rollback_failed';$('recovery-paths').replaceChildren();
  $('recovery-action').textContent=result?.status==='rollback_failed'?'자동 복구가 완료되지 않았습니다. 앱을 종료하고 백업 폴더를 보존한 뒤 설치 폴더를 수동으로 복구하세요.':result?.status==='rolled_back'?'이전 설치로 되돌렸습니다. 백업 폴더를 보존하고 설치 상태를 확인하세요.':result?.status==='success'?'이전 설치 파일의 백업입니다. 되돌려야 할 때 아래 폴더를 사용하세요.':'설치가 완료되지 않았습니다. 백업 폴더를 보존하고 설치 상태를 확인하세요.';
  for(const backup of backups){const item=document.createElement('li');item.textContent=backup;$('recovery-paths').append(item);}
  $('feedback').hidden=!problem&&!result?.status&&$('recovery').hidden;
  $('notes').replaceChildren();if(release){noteGroup($('notes'),'Gateway',release.notes.gateway);noteGroup($('notes'),'Monitor',release.notes.monitor);}
  const active=['checking','downloading','preparing','installing'].includes(phase)||unifiedActive,busy=flowBusy(),startable=action?action.canStart===true:newer&&!current.blocked&&!recoveryFailed;
  $('check').disabled=active;$('update').disabled=active||busy||!startable;
  $('update').textContent=phase==='downloading'?'다운로드 중':phase==='preparing'?'검증 중':phase==='installing'?'설치 중':unifiedActive?'업데이트 중':'전체 업데이트';
  const windowsApi=typeof window.monitor?.updateWindows==='function';$('individual-section').hidden=!windowsApi;
  $('update-windows').disabled=!windowsApi||active||busy||!newer||!!current.blocked||recoveryFailed;
  $('cancel').hidden=unifiedActive?!unified.canCancel:!['downloading','preparing'].includes(phase)&&!(phase==='downloaded'&&busy);
  renderUnified(unified);if(wslReady)renderWsl();
  $('progress').hidden=phase!=='downloading'&&!(unifiedActive&&current.progress);if(current.progress){$('progress').max=current.progress.total;$('progress').value=current.progress.received;$('progress-label').textContent=current.progress.unit==='percent'?`${Math.round(current.progress.received/current.progress.total*100)}%`:`${Math.floor(current.progress.received/1048576)} / ${Math.ceil(current.progress.total/1048576)} MB`;}else $('progress-label').textContent='';
  $('github-history').replaceChildren();for(const item of current.history||[])historyRow($('github-history'),item.version,`${item.publishedAt} · Gateway ${item.components.gateway} · Monitor ${item.components.monitor}`);if(!current.history?.length)$('github-history').textContent='검증된 릴리스 기록이 없습니다.';
  $('local-history').replaceChildren();if(installed?.version)historyRow($('local-history'),installed.version,installed.installedAt||'설치 시간 확인 불가');for(const item of current.localHistory||[])historyRow($('local-history'),`${item.version||'버전 확인 불가'} · ${resultLabels[item.status]||'확인 필요'}`,item.finishedAt||item.startedAt||'시간 확인 불가');if(!$('local-history').children.length)$('local-history').textContent='로컬 설치 기록이 없습니다.';
}
window.monitor.onUpdate(render);window.monitor.updateState().then(render);
$('check').addEventListener('click',()=>window.monitor.updateCheck().catch(()=>{current={...current,error:'업데이트 확인 요청에 실패했습니다.'};render(current);}));
$('update').addEventListener('click',()=>void flow.run());$('update-windows').addEventListener('click',()=>void windowsFlow.run());$('cancel').addEventListener('click',()=>flow.cancel());
const wslStatuses=['unavailable','disabled','empty','available','error'];
const wslPhaseLabels={idle:'대기 중',stopped:'중지됨',checking:'확인 중',checked:'확인 완료',starting:'배포판 시작 중',downloading:'다운로드 중',verifying:'검증 중',installing:'설치 중',updating:'업데이트 중',done:'완료',complete:'완료',completed:'완료',current:'최신 버전',up_to_date:'최신 버전',available:'업데이트 있음',ready:'준비됨',installed:'설치됨',not_installed:'미설치',blocked:'설치 보류',success:'완료',rolled_back:'복구 완료',rollback_failed:'수동 복구 필요',failed:'실패',error:'오류',cancelled:'취소됨'};
const wslSettled=['','idle','stopped','checked','done','complete','completed','current','up_to_date','available','ready','installed','not_installed','blocked','success','rolled_back','rollback_failed','failed','error','cancelled'];
const wslProgressPhases=['starting','preparing','downloading','verifying','installing','updating'];
const wslNotices={unavailable:'WSL을 찾을 수 없습니다. WSL이 설치되어 있지 않거나 사용할 수 없습니다. 이 창에서는 WSL을 자동으로 설치하지 않습니다.',disabled:'WSL 기능이 꺼져 있습니다. Windows에서 WSL을 직접 켠 뒤 목록을 새로고침하세요.',empty:'설치된 WSL 배포판이 없습니다. 배포판을 직접 설치한 뒤 목록을 새로고침하세요. 자동으로 설치하지 않습니다.',error:'WSL 상태를 확인하지 못했습니다. 다시 시도하세요.'};
const wsl={state:null,pending:false,error:'',lastKey:null,buttons:new Map(),unsubscribe:null};
const wslApi=()=>typeof window.monitor?.wslState==='function';
function wslText(value,max=300){return typeof value==='string'?value.trim().slice(0,max):'';}
function normalizeWslTarget(target){
  const progress=target.progress,total=Number(progress?.total),received=Number(progress?.received);
  return {id:target.id,name:wslText(target.name,80)||target.id.slice(0,80),running:target.running===true,installed:typeof target.installed==='boolean'?target.installed:null,version:wslText(target.version,64)||null,latestVersion:wslText(target.latestVersion,64)||null,phase:wslText(target.phase,32).toLowerCase(),
    progress:Number.isFinite(total)&&total>0&&Number.isFinite(received)&&received>=0?{received:Math.min(received,total),total,unit:progress?.unit==='percent'?'percent':'bytes'}:null,error:wslText(target.error)||null,message:wslText(target.message)||null,canUpdate:target.canUpdate===true,gatewayVersion:wslText(target.gatewayVersion,64)||null};
}
function normalizeWslState(value){
  if(!value||typeof value!=='object')return null;
  let status=wslStatuses.includes(value.status)?value.status:value.available===false?'unavailable':'error';
  const targets=['available','error'].includes(status)&&Array.isArray(value.targets)?value.targets.filter(target=>target&&typeof target.id==='string'&&target.id).slice(0,32).map(normalizeWslTarget):[];
  if(status==='available'&&!targets.length)status='empty';
  return {status,message:wslText(value.message)||null,targets,busy:value.busy===true};
}
function wslBusy(){return wsl.pending||wsl.state?.busy===true||current.unified?.active===true;}
function wslButton(label,aria,key,disabled,handler,title){
  const button=document.createElement('button');button.type='button';button.textContent=label;button.setAttribute('aria-label',aria);button.disabled=disabled;button.dataset.wslKey=key;if(title)button.title=title;
  button.addEventListener('click',handler);wsl.buttons.set(key,button);return button;
}
function wslLine(parent,className,text){const line=document.createElement('p');line.className=className;line.textContent=text;parent.append(line);return line;}
function wslTargetRow(target,busy){
  const row=document.createElement('li'),head=document.createElement('div'),name=document.createElement('strong'),state=document.createElement('span');
  row.className='wsl-target';head.className='wsl-head';name.textContent=target.name;state.className=target.running?'wsl-state running':'wsl-state';state.textContent=target.running?'실행 중':'중지됨';head.append(name,state);row.append(head);
  const install=target.installed===true?'Gateway 설치됨':target.installed===false?'Gateway 설치되지 않음':'Gateway 설치 여부 확인 전';
  wslLine(row,'wsl-meta',`${install} · 현재 ${target.version||'알 수 없음'} · 최신 ${target.latestVersion||'알 수 없음'}`);
  if(target.gatewayVersion)wslLine(row,'wsl-meta',`MCP Gateway ${target.gatewayVersion}`);
  const phase=target.phase,active=!wslSettled.includes(phase);
  if(phase&&phase!=='idle')wslLine(row,'wsl-phase',wslPhaseLabels[phase]||phase);
  if(target.progress&&wslProgressPhases.includes(phase)){const bar=document.createElement('progress');bar.className='wsl-progress';bar.max=target.progress.total;bar.value=target.progress.received;bar.setAttribute('aria-label',`${target.name} 진행률`);row.append(bar);wslLine(row,'wsl-meta',target.progress.unit==='percent'?`${Math.round(target.progress.received)}%`:`${Math.floor(target.progress.received/1048576)} / ${Math.ceil(target.progress.total/1048576)} MB`);}
  if(target.error)wslLine(row,'wsl-error',target.error);
  if(target.message)wslLine(row,'wsl-meta',target.message);
  if(target.installed===false)wslLine(row,'wsl-meta','Gateway를 자동으로 설치하지 않습니다. 직접 설치한 뒤 다시 확인하세요.');
  else if(!target.running)wslLine(row,'wsl-meta','배포판이 중지되어 있습니다. 확인하려면 직접 시작해야 합니다.');
  const actions=document.createElement('div');actions.className='wsl-actions';
  const disabled=busy||active,key='probe:'+target.id;
  actions.append(wslButton(target.running?'확인':'시작하고 확인',target.running?`${target.name} Gateway 상태 확인`:`${target.name} 배포판을 시작하고 Gateway 상태 확인`,key,disabled,()=>void wslRun(key,'wslProbe',target.id),target.running?'':'중지된 배포판을 시작합니다'));
  if(target.installed===true){const updateKey='update:'+target.id;actions.append(wslButton('업데이트',`${target.name} Gateway 업데이트`,updateKey,disabled||!target.running||!target.canUpdate,()=>void wslRun(updateKey,'wslUpdate',target.id)));}
  row.append(actions);return row;
}
function renderWsl(){
  const section=$('wsl-section');if(!section)return;
  section.hidden=!wslApi();if(section.hidden)return;
  wsl.buttons=new Map();const state=wsl.state,busy=wslBusy();
  $('wsl-badge').textContent=!state?'확인 중':state.status==='available'?`배포판 ${state.targets.length}개 · 실행 ${state.targets.filter(target=>target.running).length}`:state.status==='unavailable'?'WSL 없음':state.status==='disabled'?'WSL 꺼짐':state.status==='empty'?'배포판 없음':'오류';
  $('wsl-message').textContent=wsl.error||(!state?'WSL 상태를 확인하는 중입니다.':state.message||wslNotices[state.status]||'');
  $('wsl-targets').replaceChildren();for(const target of state?.targets||[])$('wsl-targets').append(wslTargetRow(target,busy));
  wsl.buttons.set('refresh',$('wsl-refresh'));$('wsl-refresh').disabled=busy;
}
async function wslRun(key,method,...args){
  const fn=window.monitor?.[method];if(wsl.pending||typeof fn!=='function')return;
  wsl.pending=true;wsl.lastKey=key;wsl.error='';renderWsl();
  try{const next=normalizeWslState(await fn.apply(window.monitor,args));if(next)wsl.state=next;else wsl.error='WSL 응답을 해석하지 못했습니다.';}
  catch{wsl.error='WSL 요청에 실패했습니다. 다시 시도하세요.';}
  finally{
    wsl.pending=false;renderWsl();
    const button=wsl.buttons.get(wsl.lastKey),active=document.activeElement;if(button&&!button.disabled&&(!active||active===document.body))button.focus();
  }
}
if(wslApi()){
  $('wsl-refresh').addEventListener('click',()=>void wslRun('refresh','wslRefresh'));
  if(typeof window.monitor.onWslUpdate==='function'){const unsubscribe=window.monitor.onWslUpdate(value=>{const next=normalizeWslState(value);if(next){wsl.state=next;renderWsl();}});if(typeof unsubscribe==='function')wsl.unsubscribe=unsubscribe;}
  window.addEventListener?.('pagehide',()=>wsl.unsubscribe?.());
  wslReady=true;renderWsl();void wslRun('state','wslState');
}
