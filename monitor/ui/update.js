const $=id=>document.getElementById(id);
let current={};
function line(parent,title,sub){const row=document.createElement('div'),name=document.createElement('strong'),small=document.createElement('small');name.textContent=title;small.textContent=sub;row.append(name,small);parent.append(row);}
function notes(parent,title,values){const heading=document.createElement('h3'),list=document.createElement('ul');heading.textContent=title;for(const value of values||[]){const li=document.createElement('li');li.textContent=value;list.append(li);}parent.append(heading,list);}
function render(state){current=state||{};const phase=current.phase||'idle',release=current.selected,installed=current.installed;
  $('indicator').className=current.error||current.blocked?'error':release&&(!installed?.version||release.version!==installed.version)?'available':'';
  $('status').textContent=phase==='checking'?'릴리스 확인 중':phase==='downloading'?'다운로드 중':phase==='preparing'?'설치 파일 확인 중':phase==='installing'?'설치 프로그램 시작됨':current.blocked?'수동 설치 필요':current.error?'확인 필요':release&&(!installed?.version||release.version!==installed.version)?'업데이트 사용 가능':'최신 릴리스 확인됨';
  $('detail').textContent=current.blocked||current.error||(current.checkedAt?`마지막 확인: ${new Date(current.checkedAt).toLocaleString('ko-KR')}`:'GitHub 안정 릴리스를 확인합니다.');
  $('installed').textContent=`릴리스 ${installed?.version||'설치 기록 없음'} · 현재 Gateway ${current.currentComponents?.gateway||'확인 불가'} · 현재 Monitor ${current.currentComponents?.monitor||'확인 불가'}`;
  const result=current.result;$('last-result').textContent=result?.status?`최근 설치: ${result.status} · ${result.message||''}`:'';
  $('release').textContent=release?`${release.version} · Gateway ${release.components.gateway} · Monitor ${release.components.monitor}`:'확인된 릴리스가 없습니다.';
  $('notes').replaceChildren();if(release){notes($('notes'),'Gateway',release.notes.gateway);notes($('notes'),'Monitor',release.notes.monitor);}
  const active=['checking','downloading','preparing','installing'].includes(phase),newer=release&&(!installed?.version||release.version!==installed.version);
  $('check').disabled=active;$('download').disabled=active||!newer||!!current.blocked||current.downloaded;$('cancel').hidden=phase!=='downloading';$('install').disabled=active||!current.downloaded||!!current.blocked;
  $('progress').hidden=phase!=='downloading';if(current.progress){$('progress').max=current.progress.total;$('progress').value=current.progress.received;$('progress-label').textContent=`${Math.floor(current.progress.received/1048576)} / ${Math.ceil(current.progress.total/1048576)} MB`;}else $('progress-label').textContent='';
  $('github-history').replaceChildren();for(const item of current.history||[])line($('github-history'),item.version,`${item.publishedAt} · Gateway ${item.components.gateway} · Monitor ${item.components.monitor}`);if(!current.history?.length)$('github-history').textContent='검증된 릴리스 기록이 없습니다.';
  $('local-history').replaceChildren();if(installed?.version)line($('local-history'),installed.version,installed.installedAt||'설치 시간 확인 불가');for(const item of current.localHistory||[])line($('local-history'),`${item.version||'버전 확인 불가'} · ${item.status}`,item.finishedAt||item.startedAt||'시간 확인 불가');if(!$('local-history').children.length)$('local-history').textContent='로컬 설치 기록이 없습니다.';
}
window.monitor.onUpdate(render);window.monitor.updateState().then(render);
$('check').addEventListener('click',()=>window.monitor.updateCheck());$('download').addEventListener('click',()=>window.monitor.updateDownload());$('cancel').addEventListener('click',()=>window.monitor.updateCancel());$('install').addEventListener('click',()=>window.monitor.updateInstall());
