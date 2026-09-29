const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('monitor',{
  state:()=>ipcRenderer.invoke('state'),
  open:provider=>ipcRenderer.send('open-detail',provider),
  close:()=>ipcRenderer.send('close-detail'),
  refresh:()=>ipcRenderer.send('refresh'),
  menu:()=>ipcRenderer.send('menu'),
  togglePin:()=>ipcRenderer.send('toggle-pin'),
  updateState:()=>ipcRenderer.invoke('update-state'),
  updateRun:()=>ipcRenderer.invoke('update-run'),
  updateCheck:()=>ipcRenderer.invoke('update-check'),
  updateDownload:()=>ipcRenderer.invoke('update-download'),
  updateCancel:()=>ipcRenderer.send('update-cancel'),
  updateInstall:()=>ipcRenderer.invoke('update-install'),
  openUpdates:()=>ipcRenderer.send('open-updates'),
  dismissUpdateProgress:()=>ipcRenderer.send('dismiss-update-progress'),
  onUpdate:callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('update-state',listener);return ()=>ipcRenderer.removeListener('update-state',listener);},
  onState:callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('state',listener);return ()=>ipcRenderer.removeListener('state',listener);},
  onProvider:callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('provider',listener);return ()=>ipcRenderer.removeListener('provider',listener);}
});
