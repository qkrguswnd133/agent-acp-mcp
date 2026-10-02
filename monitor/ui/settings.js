(function(root){
  const known=value=>typeof value==='string'&&!['auto','unknown','unavailable',''].includes(value);
  const sourceLabels={parent:'Parent 선택',configured:'고정 설정'};
  const legacyAuto={model:'자동 선택 · 실행 후 확인',effort:'자동 · 실행 후 확인'};
  /** Describe one model/effort row. Selected values are never labelled as actually confirmed. */
  function describeSetting(p,axis,formatTime=value=>String(value??'확인 불가')){
    const sel=p?.lastRun?.selection?.[axis],obs=p?.lastRun?.observation?.[axis];
    if(!sel?.value&&!obs?.value){
      // Older jobs without selection/observation metadata keep the previous display.
      const value=p?.[axis],policy=p?.[`${axis}Policy`];
      return {text:known(value)?`${value} · 최근 관측`:known(policy)?`설정 ${policy} · 실행값 미확인`:legacyAuto[axis],title:`${p?.[`${axis}Source`]??''} · ${formatTime(p?.observedAt)}`,state:known(value)?'observed':'unknown',mismatch:false};
    }
    const label=sel?sourceLabels[sel.source]??sel.source:'';
    const selectionNote=sel?`${label}: ${sel.value}${sel.reason?` — ${sel.reason}`:''}`:'';
    if(!obs?.value){
      const previous=known(p?.[axis])?`이전 관측: ${p[axis]}`:'';
      return {text:`${sel.value} · ${label} · 실제 확인 불가`,title:[selectionNote,'실제 실행값 확인 불가',previous].filter(Boolean).join('\n'),state:'selected',mismatch:false};
    }
    const confirmation=obs.verified?'실제 확인':'보고값 · 미검증';
    const observedNote=`${confirmation} 출처: ${obs.source??'unavailable'} · ${formatTime(p.lastRun.at)}`;
    const mismatch=!!sel&&sel.value!==obs.value;
    if(mismatch)return {text:`${obs.value} · ${confirmation} · 선택 ${sel.value} (${label})`,title:[observedNote,selectionNote,'선택값과 실제값이 다릅니다'].join('\n'),state:'mismatch',mismatch:true};
    return {text:`${obs.value} · ${confirmation}${sel?` · ${label}`:''}`,title:[observedNote,selectionNote].filter(Boolean).join('\n'),state:obs.verified?'verified':'observed',mismatch:false};
  }
  root.describeSetting=describeSetting;
  if(typeof module==='object'&&module.exports)module.exports={describeSetting};
})(typeof window==='object'?window:globalThis);
