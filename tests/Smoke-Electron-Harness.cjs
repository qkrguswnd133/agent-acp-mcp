// Copied into a disposable installed ASAR by Smoke-Release.mjs. Never packaged
// into a published release. Instrumentation observes UI actions and substitutes
// signed GitHub bytes and WSL transport fixtures; Windows updater/install code
// stays unchanged. Never dispatch an update into a user's actual WSL distro.
(() => {
  const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
  const artifacts=process.env.AGENT_SMOKE_ARTIFACTS,events=process.env.AGENT_SMOKE_EVENTS;
  // The installed --quit helper is a second launch of this same copied ASAR.
  // WMI does not inherit the smoke environment; let Electron's normal
  // single-instance handling deliver --quit to the original process.
  if(!artifacts||!events)return;
  const raw=fs.readFileSync(path.join(artifacts,'update-manifest.json'));
  const signature=fs.readFileSync(path.join(artifacts,'update-manifest.sig'));
  const manifest=JSON.parse(raw),base=`https://github.com/${manifest.repository}/releases/download/${manifest.tag}/`;
  const archive=path.join(artifacts,manifest.asset.name);
  const assets=[{name:'update-manifest.json',size:raw.length},{name:'update-manifest.sig',size:signature.length},{name:manifest.asset.name,size:manifest.asset.size}].map(value=>({...value,browser_download_url:base+value.name}));
  const record=(event,extra={})=>{
    try{fs.appendFileSync(events,JSON.stringify({event,at:new Date().toISOString(),pid:process.pid,...extra})+'\n');}catch{}
  };
  const fetcher=async url=>{
    if(String(url).startsWith('https://api.github.com/'))return new Response(JSON.stringify([{tag_name:manifest.tag,draft:false,prerelease:false,published_at:manifest.publishedAt,assets}]));
    if(url===base+'update-manifest.json')return new Response(raw);
    if(url===base+'update-manifest.sig')return new Response(signature);
    if(url===base+manifest.asset.name)return new Response(fs.createReadStream(archive),{headers:{'content-length':String(manifest.asset.size)}});
    throw Error('Unexpected release request in isolated smoke test');
  };
  const electron=require('electron'),OriginalWindow=electron.BrowserWindow;
  let barSeen=false,barClicked=false,updateClicked=false;
  class ObservedWindow extends OriginalWindow {
    constructor(options){
      super(options);
      const isUpdates=typeof options.title==='string'&&options.title.includes('업데이트');
      const isBar=!isUpdates&&!barSeen&&options.frame===false;
      if(isBar)barSeen=true;
      if(!isBar&&!isUpdates)return;
      this.webContents.once('did-finish-load',()=>{
        record(isBar?'bar-loaded':'update-window-loaded');
        const timer=setInterval(async()=>{
          if(this.isDestroyed()){clearInterval(timer);return;}
          try{
            if(isBar){
              if(barClicked){clearInterval(timer);return;}
              const ready=await this.webContents.executeJavaScript("!!(document.querySelector('#updates') && !document.querySelector('#updates').hidden && !document.querySelector('#updates').disabled && window.monitor)");
              if(!ready)return;
              barClicked=true;clearInterval(timer);record('bar-update-click');
              // A second IPC caller must share the in-flight run, not install twice.
              await this.webContents.executeJavaScript("document.querySelector('#updates').click();void window.monitor.updateRun()");
            }else{
              if(updateClicked){clearInterval(timer);return;}
              const ready=await this.webContents.executeJavaScript("!!(document.querySelector('#update') && !document.querySelector('#update').disabled && (document.querySelector('#latest-release')||document.querySelector('#release'))?.textContent?.includes("+JSON.stringify(manifest.version)+"))");
              if(!ready)return;
              updateClicked=true;clearInterval(timer);record('update-button-click');
              await this.webContents.executeJavaScript("document.querySelector('#update').click()");
            }
          }catch(error){record('ui-observation-error',{message:String(error?.message||error).slice(0,150)});}
        },250);
        timer.unref?.();
      });
    }
  }
  const originalLoad=Module._load;
  Module._load=function(request,parent,isMain){
    const value=originalLoad.apply(this,arguments);
    if(!parent?.filename?.endsWith(path.sep+'main.cjs'))return value;
    if(request==='electron')return {...value,BrowserWindow:ObservedWindow};
    if(request==='./update/wsl.cjs')return {...value,createWslUpdates:options=>value.createWslUpdates({...options,exec:async(file,args)=>{
      if(file!=='wsl.exe')throw Error('Unexpected fixture executable');
      const answer=value=>({stdout:Buffer.from(JSON.stringify(value)+'\n')});
      if(args[0]==='--list')return {stdout:Buffer.from((args.includes('--running')?'Fixture Ubuntu':'Fixture Ubuntu\r\nFixture Empty')+'\r\n','utf16le')};
      if(!['Fixture Ubuntu','Fixture Empty'].includes(args[1]))throw Error('Real WSL access is forbidden in release smoke');
      const script=args[5];record('wsl-command',{target:args[1]});
      if(script.includes('checkReadiness')){record('wsl-preflight');return answer({ready:true});}
      if(script.includes("'--background'")){record('wsl-install');return answer({status:'started',operationId:'11111111-1111-4111-8111-111111111111'});}
      if(script.includes("'operation'")){record('wsl-finished');return answer({status:'installed',version:manifest.version,phase:'completed'});}
      if(script.includes("'--check'"))return answer({status:'available',installed:true,currentVersion:'0.0.0',latestVersion:manifest.version,canUpdate:true});
      return answer(args[1]==='Fixture Empty'?{installed:false,legacy:false}:{installed:true,legacy:false,version:'0.0.0',installRoot:'/tmp/agent-fixture/gateway',stateRoot:'/tmp/agent-fixture/state',nodeExecutable:'/usr/bin/node'});
    }})};
    if(request==='./update/service.cjs')return {...value,createUpdater:options=>{
      const updater=value.createUpdater({...options,fetcher});
      const onChange=updater.onChange.bind(updater);
      let previousState='';
      updater.onChange=callback=>onChange(state=>{
        const summary={phase:state.phase,selected:state.selected?.version||null,downloaded:!!state.downloaded,error:state.error||null};
        const key=JSON.stringify(summary);if(key!==previousState){previousState=key;record('update-state',summary);}
        callback(state);
      });
      const install=updater.install.bind(updater);
      updater.install=async()=>{const result=await install();record('install-returned',{started:!!result?.started,operationId:result?.operationId||null,reason:result?.reason||null});return result;};
      return updater;
    }};
    return value;
  };
  electron.app.on('before-quit',()=>record('monitor-before-quit'));
  record('harness-loaded',{version:manifest.version});
})();
