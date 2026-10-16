const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {updateAction}=require('./action.cjs');
const terminalSuccess=new Set(['installed','success','completed','up_to_date']);
function createUnifiedUpdates({stateDir,windows,wsl,checkWindows,installWindows,onChange=()=>{},clock=Date.now}={}){
 const file=path.join(stateDir,'unified-update.json');
 let state={schemaVersion:1,active:false,status:'idle',phase:'idle',message:'',targets:[],canCancel:false},runPromise,cancelled=false,closing=false;
 const getState=()=>structuredClone(state);
 function publish(){onChange(getState());}
 function save(){fs.mkdirSync(stateDir,{recursive:true});const temp=file+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify(state));fs.renameSync(temp,file);}
 function set(fields,persist=true){state={...state,...fields};if(persist)save();publish();}
 function target(id,fields){set({targets:state.targets.map(item=>item.id===id?{...item,...fields}:item)});}
 function settle(status,message){set({active:false,status,phase:'idle',message,canCancel:false,currentTarget:null,progress:null,finishedAt:new Date(clock()).toISOString()});return {started:false,status,unified:getState()};}
 function failed(id,message){target(id,{status:'failed',message});return settle(state.targets.some(t=>t.status==='completed')?'partial':'blocked',message);}
 function observeWindows(value){
  if(state.status!=='awaiting_windows')return;
  const pending=value.pending;
  if(pending&&pending.version===state.targets.find(t=>t.id==='windows')?.latestVersion&&Date.parse(pending.startedAt)>=Date.parse(state.startedAt)&&state.windowsOperationId!==pending.operationId)set({windowsOperationId:pending.operationId,canCancel:false,phase:'installing'});
  const result=value.result;
  if(!state.windowsOperationId||result?.operationId!==state.windowsOperationId||!['success','blocked','failed','rolled_back','rollback_failed'].includes(result.status))return;
  const ok=result.status==='success';target('windows',{status:ok?'completed':'failed',message:result.message||result.status});
  settle(ok?'completed':state.targets.some(t=>t.kind==='wsl'&&t.status==='completed')?'partial':'blocked',ok?'Windows · WSL 업데이트 완료. MCP를 다시 연결하세요.':`Windows 업데이트 ${result.status}: ${result.message||'결과를 확인하세요.'}`);
 }
 function load(){
  try{const stat=fs.statSync(file);if(stat.size>131072)throw Error('통합 업데이트 기록 크기가 올바르지 않습니다.');const value=JSON.parse(fs.readFileSync(file,'utf8'));if(value.schemaVersion!==1||!Array.isArray(value.targets))throw Error('통합 업데이트 기록이 올바르지 않습니다.');state=value;
   if(state.active){if(state.status==='awaiting_windows'){observeWindows(windows.getState());if(state.active&&!windows.getState().pending)settle('interrupted','Windows 설치 결과를 확인하지 못했습니다. 상태를 확인한 뒤 다시 시도하세요.');}
    else settle('interrupted','Monitor가 종료되어 전체 업데이트 순서를 중단했습니다. 실행된 WSL 작업의 결과를 확인한 뒤 다시 시도하세요.');}
  }catch(error){if(error.code!=='ENOENT')state={...state,active:false,status:'blocked',phase:'idle',canCancel:false,message:error.message};}
  publish();return getState();
 }
 async function execute(){
  if(windows.getState().pending||wsl.isBusy())return {started:false,reason:'다른 업데이트 또는 조회가 진행 중입니다.'};
  cancelled=false;closing=false;
  set({schemaVersion:1,id:crypto.randomUUID(),startedAt:new Date(clock()).toISOString(),finishedAt:null,windowsOperationId:null,active:true,status:'preflight',phase:'checking',message:'설치된 Windows · WSL 대상 확인 중',targets:[],canCancel:true,progress:null});
  try{
   await windows.check(false);
   const discovered=await wsl.discoverForUpdate();
   if(closing)return;
   if(cancelled)return settle('cancelled','전체 업데이트를 취소했습니다.');
   if(discovered.status==='error'||discovered.status==='disabled'&&!discovered.safeToSkip)return settle('blocked',discovered.message||'WSL 상태를 확인하지 못해 설치를 시작하지 않았습니다.');
   const win=windows.getState(),winAction=updateAction(win);
   const targets=[{id:'windows',kind:'windows',name:'Windows Gateway · Monitor',version:win.installed?.version,latestVersion:win.selected?.version,status:winAction.available?'pending':'up_to_date'},...(discovered.targets||[]).map(t=>({id:t.id,kind:'wsl',name:`WSL · ${t.name||t.id}`,version:t.version,latestVersion:t.latestVersion,status:t.error||t.legacy||t.installed!==true&&t.installed!==false?'blocked':t.installed===false?'skipped':t.canUpdate?'pending':'up_to_date',message:t.error||(t.legacy?'Linux 업데이트 기능 등록이 필요합니다.':t.installed===false?'Gateway 미설치':'')}))];
   set({targets});
   if(winAction.available&&(win.blocked||win.error||win.result?.status==='rollback_failed'))target('windows',{status:'blocked',message:win.blocked||win.error||'Windows 복구 상태를 먼저 확인하세요.'});
   // Even an up-to-date installed target must be idle before any target installs.
   if(!win.selected?.version&&win.error)target('windows',{status:'blocked',message:win.error});
   for(const item of state.targets.filter(t=>t.status!=='skipped'&&t.status!=='blocked')){
    if(cancelled)return settle('cancelled','설치 시작 전에 전체 업데이트를 취소했습니다.');
    set({currentTarget:item.id,message:`${item.name} · 실행 중인 작업 확인`});
    const ready=item.kind==='windows'?await checkWindows():await wsl.preflight(item.id);
    if(closing)return;
    if(!ready?.ready)target(item.id,{status:'blocked',message:ready?.reason||'작업 상태 확인 불가'});
    else if(item.status==='pending')target(item.id,{status:'ready'});
   }
   const blocked=state.targets.filter(t=>t.status==='blocked');
   if(blocked.length)return settle('blocked',blocked.map(t=>`${t.name}: ${t.message}`).join(' / '));
   if(cancelled)return settle('cancelled','설치 시작 전에 전체 업데이트를 취소했습니다.');
   const queue=state.targets.filter(t=>t.status==='ready').sort((a,b)=>(a.kind==='windows'?1:0)-(b.kind==='windows'?1:0));
   if(!queue.length)return settle('completed','설치된 Windows · WSL Gateway가 모두 최신 버전입니다.');
   for(const item of queue){
    if(closing)return;
    if(cancelled)return settle(state.targets.some(t=>t.status==='completed')?'partial':'cancelled','남은 대상 업데이트를 취소했습니다. 완료된 대상은 유지됩니다.');
    // Repeat readiness immediately before dispatch; installers retain their own
    // transactional idle checks to close races after this advisory preflight.
    const ready=item.kind==='windows'?await checkWindows():await wsl.preflight(item.id);
    if(!ready?.ready)return failed(item.id,`${item.name}: ${ready?.reason||'작업이 시작되어 설치를 보류했습니다.'}`);
    target(item.id,{status:'running',message:''});
    set({status:'running',phase:item.kind==='windows'?'downloading':'installing',currentTarget:item.id,message:`${item.name} 업데이트 중`,canCancel:true,progress:null});
    if(item.kind==='wsl'){
     const result=await wsl.updateAndWait(item.id,{onProgress:value=>{if(closing)return;set({phase:['downloading','preparing','installing'].includes(value.phase)?value.phase:'installing',message:`${item.name} · ${value.message||'업데이트 중'}`,progress:value.progress||null},false);}});
     if(closing)return;
     const status=result?.result?.status||result?.status||result?.phase;
     if(!terminalSuccess.has(status))return failed(item.id,`${item.name}: ${result?.error||result?.message||'업데이트 결과를 확인하지 못했습니다.'}`);
     target(item.id,{status:status==='up_to_date'?'up_to_date':'completed',version:result.version||item.latestVersion,message:'MCP 재연결 필요'});
    }else{
     const downloaded=await windows.download();
     if(closing)return;
     if(cancelled)return settle(state.targets.some(t=>t.status==='completed')?'partial':'cancelled','Windows 설치 전에 취소했습니다. 완료된 WSL 업데이트는 유지됩니다.');
     if(downloaded.phase!=='downloaded'||!downloaded.downloaded||downloaded.error||downloaded.blocked)return failed(item.id,downloaded.error||downloaded.blocked||'Windows 다운로드 검증 실패');
     set({status:'awaiting_windows',phase:'preparing',message:'Windows 설치 준비 · 완료 후 Monitor를 다시 시작합니다',canCancel:true});
     const result=await installWindows();
     if(closing)return result;
     if(!result?.started){if(cancelled)return settle(state.targets.some(t=>t.status==='completed')?'partial':'cancelled','Windows 설치 전에 취소했습니다.');return failed(item.id,result?.reason||'Windows 설치를 시작하지 못했습니다.');}
     set({windowsOperationId:result.operationId,phase:'installing',message:'Windows 설치 중 · Monitor를 다시 시작합니다',canCancel:false});
     observeWindows(windows.getState());return {started:true,operationId:result.operationId,unified:getState()};
    }
   }
   return settle('completed','Windows · WSL 업데이트 완료. 해당 MCP를 다시 연결하세요.');
  }catch(error){if(closing)return;return settle(state.targets.some(t=>t.status==='completed')?'partial':'blocked',error.message||'전체 업데이트를 진행하지 못했습니다.');}
 }
 return {getState,load,observeWindows,isBusy:()=>!!runPromise||state.active,run(){if(state.active&&!runPromise)return Promise.resolve({started:false,reason:'설치 결과 확인 중입니다.'});if(!runPromise){runPromise=execute().finally(()=>{runPromise=undefined;});}return runPromise;},cancel(){if(!state.active||!state.canCancel)return;cancelled=true;windows.cancel();set({message:state.currentTarget&&state.targets.find(t=>t.id===state.currentTarget)?.kind==='wsl'?'현재 WSL 설치를 마친 뒤 나머지 업데이트를 중단합니다.':'업데이트 취소 중'});},close(){closing=true;}};
}
module.exports={createUnifiedUpdates};
