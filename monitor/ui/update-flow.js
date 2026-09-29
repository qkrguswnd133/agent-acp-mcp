(function(root){
  function createUpdateFlow(api,{onBusy=()=>{},onError=()=>{}}={}){
    let busy=false,cancelled=false;
    return {
      isBusy:()=>busy,
      cancel(){cancelled=true;api.updateCancel();},
      async run(){
        if(busy)return {started:false,reason:'busy'};
        busy=true;cancelled=false;onBusy(true);
        try{
          if(typeof api.updateRun==='function')return await api.updateRun();
          const downloaded=await api.updateDownload();
          const latest=await api.updateState();
          if(cancelled||downloaded?.phase!=='downloaded'||!downloaded.downloaded||latest?.phase!=='downloaded'||!latest.downloaded||latest.blocked||latest.error)return {started:false,reason:cancelled?'cancelled':'download_not_verified'};
          return await api.updateInstall();
        }catch(error){onError(error);return {started:false,reason:'request_failed'};}
        finally{busy=false;onBusy(false);}
      }
    };
  }
  root.createUpdateFlow=createUpdateFlow;
  if(typeof module==='object'&&module.exports)module.exports={createUpdateFlow};
})(typeof window==='object'?window:globalThis);
