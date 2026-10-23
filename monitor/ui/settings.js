(function(root){
  const known=value=>typeof value==='string'&&!['auto','unknown','unavailable',''].includes(value);
  const sourceLabels={parent:'Parent 선택',configured:'고정 설정',default:'기본 설정'};
  const legacyAuto={model:'자동 선택 · 실행 후 확인',effort:'자동 · 실행 후 확인'};
  const legacyAutoPrimary={model:'자동 선택',effort:'자동'};
  const speedLabels={fast:'Fast',standard:'Standard',ultrafast:'Ultrafast'};
  const speedKey=value=>{const key=typeof value==='string'?value.trim().toLowerCase():'';return Object.hasOwn(speedLabels,key)?key:null;};
  const sourceLabel=source=>sourceLabels[source]??String(source??'');
  /** Describe one model/effort row. Selected values are never labelled as actually confirmed.
   *  Besides the legacy text/title/state, `primary` is the value to scan, `status` the one-line secondary
   *  label, `detail` the multi-line tooltip/disclosure text and `compare` the requested/actual pair on mismatch. */
  function describeSetting(p,axis,formatTime=value=>String(value??'확인 불가')){
    const run=p?.lastRun,sel=run?.selection?.[axis],obs=run?.observation?.[axis];
    if(!sel?.value&&!obs?.value){
      // Same-run legacy string when a run exists; the provider-level value is only a last-known value without one.
      const value=run?run[axis]:p?.[axis],policy=run?null:p?.[`${axis}Policy`];
      const when=formatTime(run?run.at:p?.observedAt),origin=run?'':p?.[`${axis}Source`]??'';
      const note=known(value)?[run?`최근 실행 보고값 · 미검증 · ${when}`:`마지막 관측값 · ${when}`,origin&&`출처: ${origin}`]:known(policy)?[`설정값: ${policy}`,'실행값 미확인']:[run?'이 실행에서 확인된 값 없음':'아직 실행 기록 없음'];
      const detail=note.filter(Boolean).join('\n');
      if(known(value))return {text:`${value} · 최근 관측`,title:`${origin} · ${when}`,state:'observed',mismatch:false,primary:value,status:run?'보고값 · 미검증':'최근 관측 · 마지막 확인값',detail,compare:null};
      if(known(policy))return {text:`설정 ${policy} · 실행값 미확인`,title:`${origin} · ${when}`,state:'unknown',mismatch:false,primary:policy,status:'설정값 · 실행값 미확인',detail,compare:null};
      return {text:run?'확인 불가':legacyAuto[axis],title:`${origin} · ${when}`,state:'unknown',mismatch:false,primary:run?'확인 불가':legacyAutoPrimary[axis],status:run?'이 실행에서 확인 불가':'실행 후 확인',detail,compare:null};
    }
    const label=sel?sourceLabel(sel.source):'';
    const selectionNote=sel?`${label}: ${sel.value}${sel.reason?` — ${sel.reason}`:''}`:'';
    if(!obs?.value){
      return {text:`${sel.value} · ${label} · 실제 확인 불가`,title:[selectionNote,'실제 실행값 확인 불가'].filter(Boolean).join('\n'),state:'selected',mismatch:false,primary:sel.value,status:'설정값 · 실제 확인 불가',detail:[`요청: ${sel.value} (${label})`,sel.reason&&`이유: ${sel.reason}`,'실제 실행값 확인 불가'].filter(Boolean).join('\n'),compare:null};
    }
    const confirmation=obs.verified?'실제 확인':'보고값 · 미검증';
    const observedNote=`${confirmation} 출처: ${obs.source??'unavailable'} · ${formatTime(run.at)}`;
    const mismatch=!!sel&&sel.value!==obs.value;
    const detail=[`실제: ${obs.value} (${observedNote})`,sel&&`요청: ${sel.value} (${label})`,sel?.reason&&`이유: ${sel.reason}`,mismatch&&'요청값과 실제값이 다릅니다'].filter(Boolean).join('\n');
    if(mismatch)return {text:`${obs.value} · ${confirmation} · 선택 ${sel.value} (${label})`,title:[observedNote,selectionNote,'선택값과 실제값이 다릅니다'].join('\n'),state:'mismatch',mismatch:true,primary:obs.value,status:`${confirmation} · 요청과 다름`,detail,compare:{requested:sel.value,requestedSource:label,actual:obs.value}};
    return {text:`${obs.value} · ${confirmation}${sel?` · ${label}`:''}`,title:[observedNote,selectionNote].filter(Boolean).join('\n'),state:obs.verified?'verified':'observed',mismatch:false,primary:obs.value,status:obs.verified?'실제 확인':'보고값 · 미검증',detail,compare:null};
  }
  /** Describe execution speed of the latest run only. Requested/default speed is never presented as actual. */
  function describeSpeed(p,formatTime=value=>String(value??'확인 불가')){
    const run=p?.lastRun,es=run?.executionSpeed;
    const unknown=(status,detail)=>({text:`확인 불가 · ${status}`,title:detail,state:'unknown',mismatch:false,primary:'확인 불가',status,detail,compare:null,value:null,basis:'none'});
    if(!run)return unknown('최근 실행 속도 정보 없음','최근 실행 기록이 없어 속도를 확인할 수 없습니다');
    if(!es||typeof es!=='object')return unknown('이 실행의 속도 정보 없음','이 실행에서 속도 정보가 보고되지 않았습니다');
    const requested=speedKey(es.requested),observed=speedKey(es.observed),effective=speedKey(es.effective);
    const reqLabel=requested?speedLabels[requested]:null,origin=es.settingSource?sourceLabel(es.settingSource):'';
    // Effective speed is only trusted when it belongs to the same thread/turn as the run.
    const sameTurn=(a,b)=>typeof a==='string'&&a.length>0&&a===b;
    const effectiveOk=p?.provider==='codex'&&effective&&es.effectiveVerified===true&&sameTurn(es.threadId,run.sessionId)&&sameTurn(es.turnId,run.turnId)&&['app_server.thread/start','app_server.thread/resume','app_server.thread/settings/updated'].includes(es.effectiveSource);
    const when=formatTime(run.at);
    const requestedLine=reqLabel&&`요청: ${reqLabel}${origin?` (${origin})`:''}`;
    let actual=null,status,basis,line;
    if(observed&&es.verified===true){actual=observed;status='실행 확인';basis='observation';line=`실제: ${speedLabels[observed]} (실행 확인 · 출처: ${es.observationSource??'unavailable'} · ${when})`;}
    else if(effectiveOk){actual=effective;status='CLI 적용 확인';basis='effective';line=`실제: ${speedLabels[effective]} (CLI 적용 확인 · Codex CLI effective · 출처: ${es.effectiveSource??'unavailable'} · ${when})`;}
    else if(observed){actual=observed;status='보고값 · 미검증';basis='reported';line=`보고값: ${speedLabels[observed]} (미검증 · 출처: ${es.observationSource??'unavailable'} · ${when})`;}
    if(actual){
      const mismatch=!!requested&&requested!==actual;
      const detail=[line,requestedLine,mismatch&&'요청값과 실제값이 다릅니다'].filter(Boolean).join('\n');
      const verified=basis!=='reported';
      return {text:`${speedLabels[actual]} · ${status}`,title:detail,state:mismatch?'mismatch':verified?'verified':'observed',mismatch,primary:speedLabels[actual],status:mismatch?`${status} · 요청과 다름`:status,detail,compare:mismatch?{requested:reqLabel,requestedSource:origin,actual:speedLabels[actual]}:null,value:actual,basis};
    }
    if(requested){
      const detail=[requestedLine,'실제 적용 속도 확인 불가'].join('\n');
      return {text:`${reqLabel} · 설정값 · 실제 확인 불가`,title:detail,state:'selected',mismatch:false,primary:reqLabel,status:'설정값 · 실제 확인 불가',detail,compare:null,value:requested,basis:'requested'};
    }
    return unknown('이 실행의 속도 정보 없음','이 실행에서 확인된 속도 정보가 없습니다');
  }
  root.describeSetting=describeSetting;root.describeSpeed=describeSpeed;
  if(typeof module==='object'&&module.exports)module.exports={describeSetting,describeSpeed};
})(typeof window==='object'?window:globalThis);
