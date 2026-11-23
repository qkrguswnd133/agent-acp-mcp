const {contextBridge,ipcRenderer}=require('electron');
let cliFocusListener=null,cliFocusPending;
ipcRenderer.on('cli-focus',(_event,provider)=>{if(typeof provider!=='string')return;if(cliFocusListener)cliFocusListener(provider);else cliFocusPending=provider;});
contextBridge.exposeInMainWorld('monitor',{
  state:()=>ipcRenderer.invoke('state'),
  open:provider=>ipcRenderer.send('open-detail',provider),
  close:()=>ipcRenderer.send('close-detail'),
  refresh:()=>ipcRenderer.send('refresh'),
  menu:()=>ipcRenderer.send('menu'),
  togglePin:()=>ipcRenderer.send('toggle-pin'),
  updateState:()=>ipcRenderer.invoke('update-state'),
  updateRun:()=>ipcRenderer.invoke('update-run'),
  updateWindows:()=>ipcRenderer.invoke('update-windows'),
  updateCheck:()=>ipcRenderer.invoke('update-check'),
  wslState:()=>ipcRenderer.invoke('wsl-state'),
  wslRefresh:()=>ipcRenderer.invoke('wsl-refresh'),
  wslProbe:id=>ipcRenderer.invoke('wsl-probe',id),
  wslUpdate:id=>ipcRenderer.invoke('wsl-update',id),
  onWslUpdate:callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('wsl-update-state',listener);return ()=>ipcRenderer.removeListener('wsl-update-state',listener);},
  cliState:()=>ipcRenderer.invoke('cli-state'),
  cliRefresh:id=>id===undefined?ipcRenderer.invoke('cli-refresh'):ipcRenderer.invoke('cli-refresh',id),
  cliRun:(id,provider)=>id===undefined&&provider===undefined?ipcRenderer.invoke('cli-run'):ipcRenderer.invoke('cli-run',id,provider),
  onCliState:callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('cli-state-changed',listener);return ()=>ipcRenderer.removeListener('cli-state-changed',listener);},
  onCliFocus:callback=>{cliFocusListener=callback;if(cliFocusPending!==undefined){const provider=cliFocusPending;cliFocusPending=undefined;callback(provider);}return ()=>{if(cliFocusListener===callback)cliFocusListener=null;};},
  openCliUpdates:provider=>ipcRenderer.send('open-cli-updates',provider),
  updateDownload:()=>ipcRenderer.invoke('update-download'),
  updateCancel:()=>ipcRenderer.send('update-cancel'),
  updateInstall:()=>ipcRenderer.invoke('update-install'),
  openUpdates:()=>ipcRenderer.send('open-updates'),
  dismissUpdateProgress:()=>ipcRenderer.send('dismiss-update-progress'),
  onUpdate:callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('update-state',listener);return ()=>ipcRenderer.removeListener('update-state',listener);},
  onState:callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('state',listener);return ()=>ipcRenderer.removeListener('state',listener);},
  onProvider:callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('provider',listener);return ()=>ipcRenderer.removeListener('provider',listener);}
});
