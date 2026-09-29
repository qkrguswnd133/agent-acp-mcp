const $=id=>document.getElementById(id);
const resultLabels={success:'완료',blocked:'설치 보류',failed:'실패',rolled_back:'이전 버전 복구',rollback_failed:'수동 복구 필요'};
let current={};
const flow=window.createUpdateFlow(window.monitor,{
  onBusy:()=>render(current),
  onError:()=>{current={...current,error:'업데이트 요청에 실패했습니다. 다시 시도하세요.'};render(current);}
});
function historyRow(parent,title,description){const row=document.createElement('div'),name=document.createElement('strong'),detail=document.createElement('small');name.textContent=title;detail.textContent=description;row.append(name,detail);parent.append(row);}
function noteGroup(parent,title,values){const heading=document.createElement('h3'),list=document.createElement('ul');heading.textContent=title;for(const value of values||[]){const item=document.createElement('li');item.textContent=value;list.append(item);}parent.append(heading,list);}
function render(value){
  current=value||{};const phase=current.phase||'idle',release=current.selected,installed=current.installed,result=current.result;
  const newer=!!release&&(!installed?.version||release.version!==installed.version),recoveryFailed=result?.status==='rollback_failed',problem=current.blocked||current.error||(recoveryFailed?'자동 복구가 완료되지 않았습니다. 아래 백업 및 복구 안내를 확인하세요.':null);
  $('indicator').className=problem?'error':newer?'available':'';
  $('status').textContent=phase==='checking'?'릴리스 확인 중':phase==='downloading'?'다운로드 중':phase==='preparing'?'설치 준비 중':phase==='installing'?'설치 프로그램 실행 중':recoveryFailed?'수동 복구 필요':current.blocked?'수동 설치 필요':current.error?'업데이트 확인 필요':!release?current.checkedAt?'확인된 릴리스 없음':'업데이트 확인 전':newer?'업데이트 사용 가능':'최신 버전 확인됨';
  $('detail').textContent=current.checkedAt?`마지막 확인 ${new Date(current.checkedAt).toLocaleString('ko-KR')}`:'GitHub 안정 릴리스를 확인합니다.';
  $('current-release').textContent=installed?.version||'알 수 없음';$('current-gateway').textContent=current.currentComponents?.gateway||'알 수 없음';$('current-monitor').textContent=current.currentComponents?.monitor||'알 수 없음';
  $('latest-release').textContent=release?.version||'—';$('latest-gateway').textContent=release?.components?.gateway||'—';$('latest-monitor').textContent=release?.components?.monitor||'—';
  $('release-meta').textContent=release?`${new Date(release.publishedAt).toLocaleDateString('ko-KR')} · ZIP ${Math.ceil(release.size/1048576)} MB`:'';
  $('error-panel').hidden=!problem;$('error-panel').textContent=problem||'';
  $('last-result').hidden=!result?.status;$('last-result').textContent=result?.status?`최근 설치: ${resultLabels[result.status]||'확인 필요'} · ${result.message||''}`:'';
  const backups=Array.isArray(result?.backups)?result.backups.filter(item=>typeof item==='string'&&item.trim()).slice(0,10):[];
  $('recovery').hidden=!backups.length&&result?.status!=='rollback_failed';$('recovery-details').open=result?.status==='rollback_failed';$('recovery-paths').replaceChildren();
  $('recovery-action').textContent=result?.status==='rollback_failed'?'자동 복구가 완료되지 않았습니다. 앱을 종료하고 백업 폴더를 보존한 뒤 설치 폴더를 수동으로 복구하세요.':result?.status==='rolled_back'?'이전 설치로 되돌렸습니다. 백업 폴더를 보존하고 설치 상태를 확인하세요.':result?.status==='success'?'이전 설치 파일의 백업입니다. 되돌려야 할 때 아래 폴더를 사용하세요.':'설치가 완료되지 않았습니다. 백업 폴더를 보존하고 설치 상태를 확인하세요.';
  for(const backup of backups){const item=document.createElement('li');item.textContent=backup;$('recovery-paths').append(item);}
  $('feedback').hidden=!problem&&!result?.status&&$('recovery').hidden;
  $('notes').replaceChildren();if(release){noteGroup($('notes'),'Gateway',release.notes.gateway);noteGroup($('notes'),'Monitor',release.notes.monitor);}
  const active=['checking','downloading','preparing','installing'].includes(phase);
  $('check').disabled=active;$('update').disabled=active||flow.isBusy()||!newer||!!current.blocked||recoveryFailed;
  $('update').textContent=phase==='downloading'?'다운로드 중':phase==='preparing'?'검증 중':phase==='installing'?'설치 중':'업데이트';
  $('cancel').hidden=!['downloading','preparing'].includes(phase)&&!(phase==='downloaded'&&flow.isBusy());
  $('progress').hidden=phase!=='downloading';if(current.progress){$('progress').max=current.progress.total;$('progress').value=current.progress.received;$('progress-label').textContent=`${Math.floor(current.progress.received/1048576)} / ${Math.ceil(current.progress.total/1048576)} MB`;}else $('progress-label').textContent='';
  $('github-history').replaceChildren();for(const item of current.history||[])historyRow($('github-history'),item.version,`${item.publishedAt} · Gateway ${item.components.gateway} · Monitor ${item.components.monitor}`);if(!current.history?.length)$('github-history').textContent='검증된 릴리스 기록이 없습니다.';
  $('local-history').replaceChildren();if(installed?.version)historyRow($('local-history'),installed.version,installed.installedAt||'설치 시간 확인 불가');for(const item of current.localHistory||[])historyRow($('local-history'),`${item.version||'버전 확인 불가'} · ${resultLabels[item.status]||'확인 필요'}`,item.finishedAt||item.startedAt||'시간 확인 불가');if(!$('local-history').children.length)$('local-history').textContent='로컬 설치 기록이 없습니다.';
}
window.monitor.onUpdate(render);window.monitor.updateState().then(render);
$('check').addEventListener('click',()=>window.monitor.updateCheck().catch(()=>{current={...current,error:'업데이트 확인 요청에 실패했습니다.'};render(current);}));
$('update').addEventListener('click',()=>void flow.run());$('cancel').addEventListener('click',()=>flow.cancel());
