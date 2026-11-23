'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const {createTransport,discover}=require('./cli-transport.cjs');
const {writeState}=require('./cli-batch.cjs');
const providers=['grok','claude','codex'];
const uuid=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
function cliOffered(row){
  return row.status==='available'||(row.status==='blocked'&&row.retryable===true);
}
function read(file) {
  try {return JSON.parse(fs.readFileSync(file,'utf8'));} catch {return null;}
}
async function launch(file,monitorDirectory) {
  const child=spawn(process.execPath,[path.join(__dirname,'cli-batch.cjs'),file,monitorDirectory],{detached:true,windowsHide:true,stdio:'ignore',env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
  await new Promise((resolve,reject)=>{child.once('error',reject);child.once('spawn',resolve);});
  child.unref();
  return child.pid;
}
function createCliUpdates({stateDir,monitorDirectory,listTargets=discover,command=createTransport(monitorDirectory),start=launch,blocked=()=>false,onChange=()=>{},onFinish=()=>{}}) {
  const dir=path.join(stateDir,'provider-cli');
  const pointer=path.join(dir,'latest.json');
  let targets=[],checking=false,starting=false,timer=null,operation=null,closed=false;
  const snapshot=()=>structuredClone({busy:checking||starting||!!operation?.busy,targets});
  const emit=()=>{if(!closed)onChange(snapshot());};
  function applyJournal() {
    for(const item of operation?.items??[]) {
      const row=targets.find(t=>t.id===item.id)?.rows.find(r=>r.provider===item.provider);
      if(!row)continue;
      // Keep a newly discovered upgrade actionable while retaining the previous result.
      row.lastResult={status:item.status,previousVersion:item.previousVersion??item.currentVersion,currentVersion:item.currentVersion,message:item.message};
      if(operation.busy || (row.status==='current' && row.currentVersion===item.currentVersion && item.status==='updated'))Object.assign(row,item);
    }
  }
  function poll() {
    const record=read(pointer);
    if(!uuid.test(record?.id??''))return;
    const file=path.join(dir,record.id+'.json');
    const saved=read(file);
    if(!saved||!Array.isArray(saved.items))return;
    if(saved.busy) {
      let interrupted=false;
      const pid=saved.workerPid??record.pid;
      if(Number.isSafeInteger(pid)&&pid>0){
        try {process.kill(pid,0);} catch(error) {interrupted=error.code==='ESRCH';}
      }else interrupted=Date.now()-record.startedAt>60000;
      if(interrupted){
        saved.busy=false;
        for(const item of saved.items)if(['available','checking','updating','verifying'].includes(item.status))Object.assign(item,{status:'error',message:'업데이트 도우미의 실행을 확인할 수 없습니다. 새로고침으로 버전을 확인하세요.'});
        writeState(file,saved);
      }
    }
    const wasBusy=operation?.busy;
    operation=saved;
    applyJournal();
    if(wasBusy&&!saved.busy){
      for(const item of saved.items){
        const row=targets.find(t=>t.id===item.id)?.rows.find(r=>r.provider===item.provider);
        if(row)Object.assign(row,item);
      }
      onFinish();
    }
    if(saved.busy&&!timer&&!closed){timer=setInterval(()=>{poll();emit();},1500);timer.unref?.();}
    else if(!saved.busy&&timer){clearInterval(timer);timer=null;}
  }
  async function refresh(id) {
    if(checking||starting||closed)return snapshot();
    checking=true;emit();
    try {
      const inventory=await listTargets();
      if(id!==undefined && !inventory.some(t=>t.id===id))return snapshot();
      targets=inventory.map(t=>({...t,rows:targets.find(old=>old.id===t.id)?.rows??[]}));
      poll();
      await Promise.all(targets.map(async t=>{
        if(id!==undefined && t.id!==id)return;
        if(!t.running && t.id!==id){t.rows=[];return;}
        if(operation?.busy && operation.items.some(i=>i.id===t.id)){
          if(!t.rows.length)t.rows=operation.items.filter(i=>i.id===t.id).map(i=>({...i}));
          return;
        }
        try {
          const result=await command(t.id,['list'],{start:t.id===id});
          t.rows=result.rows.filter(r=>providers.includes(r.provider));
          t.running=true;
        } catch(error) {
          t.rows=providers.map(provider=>({provider,status:'error',message:error.message}));
        }
      }));
      applyJournal();
    } finally {checking=false;emit();}
    return snapshot();
  }
  async function run(id,provider) {
    if(checking||starting||operation?.busy||blocked()||closed)return snapshot();
    if((id!==undefined||provider!==undefined)&&(!providers.includes(provider)||!targets.some(t=>t.id===id)))return snapshot();
    const items=targets.filter(t=>t.running&&(id===undefined||id===t.id)).flatMap(t=>t.rows
      .filter(r=>cliOffered(r)&&(provider===undefined||provider===r.provider)&&r.path&&r.currentVersion&&r.latestVersion)
      .map(r=>({id:t.id,name:t.name,provider:r.provider,path:r.path,method:r.method,
        currentVersion:r.currentVersion,latestVersion:r.latestVersion,status:'available',retryable:false})));
    if(!items.length)return snapshot();
    starting=true;emit();
    const operationId=randomUUID(),file=path.join(dir,operationId+'.json');
    let launched=false;
    try{
      fs.mkdirSync(dir,{recursive:true});
      operation={busy:true,items};
      writeState(file,operation);
      const intent={id:operationId,startedAt:Date.now()};
      writeState(pointer,intent);
      const pid=await start(file,monitorDirectory);
      launched=true;
      // The worker also publishes its PID; closing Monitor during spawn cannot lose the operation.
      try{writeState(pointer,{...intent,pid});}catch{}
      poll();
    }catch(error){
      if(launched)throw error;
      operation={busy:false,items:items.map(i=>({...i,status:'error',message:error.message}))};
      try{writeState(file,operation);}catch{}
      for(const item of operation.items)Object.assign(targets.find(t=>t.id===item.id).rows.find(r=>r.provider===item.provider),item);
    }finally{starting=false;emit();}
    return snapshot();
  }
  poll();
  return {refresh,run,snapshot,isBusy:()=>starting||!!operation?.busy,close(){closed=true;clearInterval(timer);}};
}
module.exports={createCliUpdates,cliOffered};

