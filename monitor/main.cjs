const {app,BrowserWindow,ipcMain,screen,Tray,Menu,nativeImage}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn,execFile}=require('node:child_process'),readline=require('node:readline');
const {barBounds,detailBounds,contains}=require('./geometry.cjs');
const {createUpdater,resolveGatewayRoot}=require('./update/service.cjs');
const appVersion=app.getVersion();
const smoke=process.argv.includes('--smoke');
const verifyLive=process.argv.includes('--verify-live');
if(smoke)app.disableHardwareAcceleration();
const dataArg=process.argv.find(arg=>arg.startsWith('--data-dir='));
const configuredDataDir=dataArg!==undefined?dataArg.slice('--data-dir='.length):process.env.AGENT_MONITOR_DATA_DIR;
if(configuredDataDir!==undefined&&(!configuredDataDir||!path.isAbsolute(configuredDataDir)))throw Error('Monitor data directory must be an absolute path.');
const stateDir=smoke||verifyLive?path.join(os.tmpdir(),`agent-monitor-check-${process.pid}`):configuredDataDir?path.resolve(configuredDataDir):path.join(app.getPath('appData'),'Agent Monitor');
app.setPath('userData',stateDir);fs.mkdirSync(stateDir,{recursive:true});
let bar,panel,updates,tray,backend,pending=new Map(),sequence=0,selected='grok',hideAt=0,moveTimer,refreshTimer,updateTimer,releaseTimer,hoverTimer,quitting=false,installing=false;
const monitorDirectory=path.dirname(process.execPath);
const gatewayRoot=resolveGatewayRoot(monitorDirectory);
const updater=createUpdater({stateDir,monitorDirectory,gatewayDirectory:fs.existsSync(gatewayRoot)?gatewayRoot:undefined,appVersion});
updater.onChange(value=>{for(const win of [bar,updates])if(win&&!win.isDestroyed())win.webContents.send('update-state',value);});
let state={snapshot:null,refreshing:false,error:null,lastAttempt:null};
let stoppedBackend;
function stopBackend(){
  const child=backend;backend=undefined;
  if(!child||child.exitCode!==null||child.signalCode!==null)return stoppedBackend??Promise.resolve();
  // Only descendants of this app's own read-only worker are terminated.
  stoppedBackend=new Promise(resolve=>{
    if(process.platform==='win32')execFile('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:5000},()=>resolve());
    else{child.kill();resolve();}
  });return stoppedBackend;
}
const settingsFile=path.join(stateDir,'window.json');
let pinned=true;try{pinned=JSON.parse(fs.readFileSync(settingsFile,'utf8')).pinned!==false;}catch{}
function applyPin(){for(const win of [bar,panel])if(win&&!win.isDestroyed())win.setAlwaysOnTop(pinned,'screen-saver');}
function togglePin(){pinned=!pinned;applyPin();savePosition();broadcast();}
function loadPosition(){try{const s=JSON.parse(fs.readFileSync(settingsFile,'utf8'));return Number.isFinite(s.x)&&Number.isFinite(s.y)?s:undefined;}catch{return undefined;}}
function savePosition(){if(!bar||bar.isDestroyed())return;const {x,y}=bar.getBounds();try{fs.writeFileSync(settingsFile,JSON.stringify({x,y,pinned}));}catch{}}
function broadcast(){for(const win of [bar,panel])if(win&&!win.isDestroyed())win.webContents.send('state',{...state,pinned});}
function areaFor(bounds){return screen.getDisplayMatching(bounds).workArea;}
function popupBounds(bounds){return detailBounds(bounds,areaFor(bounds),bounds.width/2,selected==='claude'?536:452);}
function reposition(){if(!bar||bar.isDestroyed())return;const bounds=bar.getBounds();const clamped=barBounds(bounds,areaFor(bounds));if(bounds.x!==clamped.x||bounds.y!==clamped.y)bar.setBounds(clamped);if(panel?.isVisible())panel.setBounds(popupBounds(clamped));savePosition();}
function closePanel(){panel?.hide();hideAt=0;bar?.webContents.send('provider',null);}
function hoverStep(point,now=Date.now()){
  if(!panel.isVisible())return;
  if(contains(bar.getBounds(),point)||contains(panel.getBounds(),point)){hideAt=0;return;}
  if(!hideAt)hideAt=now+320;if(now>=hideAt)closePanel();
}
function openPanel(provider){if(!['grok','claude','codex'].includes(provider))return;selected=provider;const bounds=bar.getBounds();hideAt=0;panel.setBounds(popupBounds(bounds));panel.webContents.send('provider',selected);bar.webContents.send('provider',selected);panel.showInactive();}
function show(){if(!bar||bar.isDestroyed())return;bar.showInactive();reposition();}
function openUpdates(){if(!updates||updates.isDestroyed()){updates=new BrowserWindow({width:620,height:700,minWidth:520,minHeight:500,show:false,title:'Agent ACP MCP 업데이트',backgroundColor:'#171a24',webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});updates.setMenu(null);updates.webContents.setWindowOpenHandler(()=>({action:'deny'}));updates.webContents.on('will-navigate',event=>event.preventDefault());updates.loadFile(path.join(__dirname,'ui','update.html'));}updates.show();updates.focus();}
function menu(){Menu.buildFromTemplate([
  {label:bar.isVisible()?'상태 바 숨기기':'상태 바 표시',click:()=>{if(bar.isVisible()){closePanel();bar.hide();}else show();}},
  {label:'지금 새로고침',click:()=>refresh()},
  {label:'업데이트 확인',click:()=>{openUpdates();void updater.check(true);}},
  {label:'정보 · 버전',click:openUpdates},
  {label:'위치 초기화',click:()=>{closePanel();bar.setBounds(barBounds(undefined,screen.getPrimaryDisplay().workArea));savePosition();show();}},
  {type:'separator'}, {label:'Agent Monitor 종료',click:()=>app.quit()}
]).popup({window:bar});}
function failPending(message){for(const item of pending.values()){clearTimeout(item.timer);item.reject(Error(message));}pending.clear();}
function startBackend(){
  if(backend&&!backend.killed)return;
  backend=spawn(process.execPath,[path.join(__dirname,'backend','worker.mjs')],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,stdio:['pipe','pipe','pipe']});
  const child=backend;
  child.stderr.on('data',()=>{});
  readline.createInterface({input:child.stdout}).on('line',line=>{try{const value=JSON.parse(line),item=pending.get(value.id);if(!item)return;pending.delete(value.id);clearTimeout(item.timer);value.error?item.reject(Error(typeof value.error==='string'?value.error:'상태 조회 실패')):item.resolve(value.result);}catch{}});
  child.on('error',()=>{if(backend===child)backend=undefined;failPending('상태 조회 프로세스를 시작하지 못했습니다.');});
  child.on('exit',()=>{if(backend===child){backend=undefined;failPending('상태 조회 연결이 종료되었습니다. 다음 갱신에서 다시 연결합니다.');}});
}
function query(){startBackend();return new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(async()=>{pending.delete(id);await stopBackend();reject(Error('상태 조회 시간이 초과되었습니다. 마지막 확인값을 표시합니다.'));},90000);pending.set(id,{resolve,reject,timer});backend.stdin.write(JSON.stringify({id,method:'status'})+'\n',error=>{if(error){pending.delete(id);clearTimeout(timer);reject(error);}});});}
async function refresh(){if(state.refreshing||smoke||installing)return;state={...state,refreshing:true,error:null,lastAttempt:new Date().toISOString()};broadcast();try{const snapshot=await query();state={snapshot,refreshing:false,error:null,lastAttempt:state.lastAttempt};try{fs.writeFileSync(path.join(stateDir,'latest-status.json'),JSON.stringify(snapshot,null,2));}catch{}}catch(error){state={...state,refreshing:false,error:error.message};}broadcast();}
function createWindow(file,options){const win=new BrowserWindow({frame:false,transparent:true,resizable:false,maximizable:false,minimizable:false,fullscreenable:false,skipTaskbar:true,alwaysOnTop:true,show:false,hasShadow:false,backgroundColor:'#00000000',...options,webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});win.setMenu(null);win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',event=>event.preventDefault());win.loadFile(path.join(__dirname,'ui',file));return win;}
function trusted(event){return [bar,panel,updates].some(w=>w&&!w.isDestroyed()&&w.webContents===event.sender);}
function updateTrusted(event){return updates&&!updates.isDestroyed()&&event.sender===updates.webContents;}
ipcMain.handle('state',event=>trusted(event)?{...state,selected,pinned}:null);
ipcMain.on('toggle-pin',event=>{if(bar&&!bar.isDestroyed()&&event.sender===bar.webContents)togglePin();});
ipcMain.on('open-detail',(event,...args)=>{if(trusted(event))openPanel(...args);});
ipcMain.on('close-detail',event=>{if(trusted(event))closePanel();});
ipcMain.on('refresh',event=>{if(trusted(event))void refresh();});
ipcMain.on('menu',event=>{if(trusted(event))menu();});
ipcMain.on('open-updates',event=>{if(trusted(event))openUpdates();});
ipcMain.handle('update-state',event=>trusted(event)?updater.getState():null);
ipcMain.handle('update-check',event=>updateTrusted(event)?updater.check(true):null);
ipcMain.handle('update-download',event=>updateTrusted(event)?updater.download():null);
ipcMain.on('update-cancel',event=>{if(updateTrusted(event))updater.cancel();});
ipcMain.handle('update-install',async event=>{if(!updateTrusted(event))return null;if(updater.getState().pending)return {started:false,reason:'설치가 이미 진행 중입니다.'};installing=true;clearInterval(refreshTimer);refreshTimer=undefined;await stopBackend();const result=await updater.install();if(!result.started){installing=false;void refresh();refreshTimer=setInterval(()=>void refresh(),60000);}return result;});
if(!smoke&&!verifyLive&&!app.requestSingleInstanceLock())app.quit();else{
  app.on('second-instance',(_event,argv)=>argv.includes('--quit')?app.quit():show());
  app.whenReady().then(async()=>{
    const saved=loadPosition();const area=saved?screen.getDisplayNearestPoint(saved).workArea:screen.getPrimaryDisplay().workArea;
    bar=createWindow('bar.html',barBounds(saved,area));panel=createWindow('detail.html',{width:382,height:452});
    applyPin();
    bar.on('move',()=>{if(panel?.isVisible())panel.setBounds(popupBounds(bar.getBounds()));clearTimeout(moveTimer);moveTimer=setTimeout(reposition,250);});
    bar.on('close',event=>{if(!quitting){event.preventDefault();closePanel();bar.hide();}});
    panel.on('close',event=>{if(!quitting){event.preventDefault();closePanel();}});
    screen.on('display-removed',reposition);screen.on('display-metrics-changed',reposition);
    const icon=nativeImage.createFromPath(path.join(__dirname,'assets','tray.png'));tray=new Tray(icon);tray.setToolTip('Agent Monitor · 사용량 모니터');tray.on('click',()=>bar.isVisible()?(closePanel(),bar.hide()):show());tray.on('right-click',menu);
    await Promise.all([bar,panel].map(win=>win.webContents.isLoading()?new Promise(resolve=>win.webContents.once('did-finish-load',resolve)):Promise.resolve()));
    show();
    if(!smoke&&!verifyLive){await updater.load();installing=!!updater.getState().pending;void updater.check();releaseTimer=setInterval(()=>void updater.check(),6*60*60*1000);updateTimer=setInterval(async()=>{try{const pending=updater.getState().pending;await updater.pollResult();const current=updater.getState();if(pending&&!current.pending&&!(current.result?.operationId===pending.operationId&&current.result.status==='success')){installing=false;void refresh();if(!refreshTimer)refreshTimer=setInterval(()=>void refresh(),60000);}}catch{}},2000);}
    hoverTimer=setInterval(()=>hoverStep(screen.getCursorScreenPoint()),80);
    if(smoke){clearInterval(hoverTimer);await runSmoke();}
    else if(verifyLive){
      clearInterval(hoverTimer);await refresh();if(state.error||!Array.isArray(state.snapshot?.providers))throw Error(state.error||'No live snapshot');
      const out=process.env.AGENT_MONITOR_SMOKE_DIR||path.join(__dirname,'work');fs.mkdirSync(out,{recursive:true});
      openPanel('claude',285);await new Promise(resolve=>setTimeout(resolve,200));
      fs.writeFileSync(path.join(out,'live-status.json'),JSON.stringify(state.snapshot,null,2));
      fs.writeFileSync(path.join(out,'live-bar.png'),(await bar.webContents.capturePage()).toPNG());
      fs.writeFileSync(path.join(out,'live-detail.png'),(await panel.webContents.capturePage()).toPNG());
      console.log('MONITOR_LIVE_OK');app.quit();
    }else if(!installing){void refresh();refreshTimer=setInterval(()=>void refresh(),60000);}
  }).catch(error=>{console.error(error);app.exit(1);});
}
app.on('before-quit',event=>{if(quitting)return;event.preventDefault();quitting=true;clearInterval(refreshTimer);clearInterval(updateTimer);clearInterval(releaseTimer);clearInterval(hoverTimer);clearTimeout(moveTimer);savePosition();failPending('앱 종료');tray?.destroy();void stopBackend().finally(()=>app.quit());});
async function runSmoke(){
  const assert=require('node:assert/strict');const out=process.env.AGENT_MONITOR_SMOKE_DIR||path.join(__dirname,'work');fs.mkdirSync(out,{recursive:true});
  try{
    assert.equal(bar.isAlwaysOnTop(),true);assert.equal(panel.isAlwaysOnTop(),true);await bar.webContents.executeJavaScript("document.querySelector('#pin').click()");await new Promise(r=>setTimeout(r,80));assert.equal(bar.isAlwaysOnTop(),false);assert.equal(panel.isAlwaysOnTop(),false);assert.equal(loadPosition().pinned,false);assert.equal(await bar.webContents.executeJavaScript("document.querySelector('#pin').getAttribute('aria-pressed')"),'false');togglePin();assert.equal(bar.isAlwaysOnTop(),true);assert.equal(panel.isAlwaysOnTop(),true);assert.equal(loadPosition().pinned,true);
    const now=new Date().toISOString();state={refreshing:false,error:null,snapshot:{generatedAt:now,providers:['grok','claude','codex'].map((provider,i)=>({provider,enabled:true,available:true,authenticated:true,account:{status:'authenticated',email:`${provider}@example.com`,organization:i===0?'Sample Team':null,source:'fixture',observedAt:now},version:'fixture',model:i===0?'grok-4.7':'auto',effort:i===0?'xhigh':'auto',quota:{state:i===1?'unknown':'available',usedPercent:i===1?undefined:i===0?89:13,remainingPercent:i===1?undefined:i===0?11:87,source:i===1?'unknown':'fixture',resetsAt:new Date(Date.now()+3600000).toISOString(),observedAt:now}})),jobs:[]}};broadcast();
    await new Promise(r=>setTimeout(r,180));
    assert.equal(await bar.webContents.executeJavaScript("document.querySelectorAll('[data-agent]').length"),3);
    state.snapshot.jobs=['grok','claude','codex'].map(provider=>({project:'sample-project',isolated:true,originalCwd:'C:/dev/sample-project',cwd:'C:/Temp/fixture/sample-project',status:'completed',providers:[{provider}]}));broadcast();
    for(const provider of ['grok','claude','codex']){openPanel(provider);await new Promise(r=>setTimeout(r,40));assert.equal(await panel.webContents.executeJavaScript("document.querySelector('.job-name').textContent"),'sample-project · 격리 작업');assert.match(await panel.webContents.executeJavaScript("document.querySelector('.job-name').title"),/C:\/dev\/sample-project[\s\S]*C:\/Temp\/fixture\/sample-project/);}
    fs.writeFileSync(path.join(out,'project-detail.png'),(await panel.webContents.capturePage()).toPNG());closePanel();

    await bar.webContents.executeJavaScript("document.querySelector('[data-agent=grok]').dispatchEvent(new MouseEvent('mouseenter'))");
    await new Promise(r=>setTimeout(r,160));assert.equal(panel.isVisible(),true);assert.equal(selected,'grok');
    assert.match(await panel.webContents.executeJavaScript('document.body.innerText'),/89/);
    assert.equal(await panel.webContents.executeJavaScript("document.querySelector('#account').textContent"),'grok@example.com');assert.equal(await panel.webContents.executeJavaScript("document.querySelector('#organization').textContent"),'Sample Team');
    fs.writeFileSync(path.join(out,'bar.png'),(await bar.webContents.capturePage()).toPNG());fs.writeFileSync(path.join(out,'detail.png'),(await panel.webContents.capturePage()).toPNG());
    await bar.webContents.executeJavaScript("document.querySelector('[data-agent=claude]').dispatchEvent(new MouseEvent('mouseenter'))");await new Promise(r=>setTimeout(r,80));assert.match(await panel.webContents.executeJavaScript('document.body.innerText'),/확인 불가/);assert.equal(await panel.webContents.executeJavaScript("document.querySelector('#account').textContent"),'claude@example.com');
    state.snapshot.providers[1].quota={state:'available',usedPercent:93,remainingPercent:7,source:'fixture',selectedWindow:'five_hour',windows:[{id:'five_hour',label:'5시간',usedPercent:93,remainingPercent:7,resetsAt:new Date(Date.now()+3600000).toISOString()},{id:'seven_day',label:'주간',usedPercent:35,remainingPercent:65,resetsAt:new Date(Date.now()+86400000).toISOString()}]};
    state.snapshot.providers[1].quota.windows.push({id:'seven_day_fable',label:'주간 · Fable',usedPercent:0,remainingPercent:100,resetsAt:new Date(Date.now()+86400000).toISOString()});
    state.snapshot.providers[2].quota={state:'available',usedPercent:75,remainingPercent:25,source:'fixture',selectedWindow:'seven_day',windows:[{id:'five_hour',label:'5시간',usedPercent:13,remainingPercent:87,resetsAt:new Date(Date.now()+3600000).toISOString()},{id:'seven_day',label:'주간',usedPercent:75,remainingPercent:25,resetsAt:new Date(Date.now()+86400000).toISOString()}]};
    broadcast();await new Promise(r=>setTimeout(r,80));const details=await panel.webContents.executeJavaScript('document.body.innerText');assert.match(details,/93% 사용/);assert.match(details,/35% 사용/);assert.match(details,/5시간/);assert.match(details,/주간/);
    const dual=await bar.webContents.executeJavaScript("Object.fromEntries(['claude','codex'].map(name=>{const button=document.querySelector('[data-agent='+name+']');return [name,{values:[...button.querySelectorAll('.quota-number')].map(node=>[node.textContent,getComputedStyle(node).color]),title:button.title}]}))");
    assert.deepEqual(dual.claude.values,[['93%','rgb(237, 133, 140)'],['35%','rgb(138, 201, 180)'],['0%','rgb(180, 166, 245)']]);assert.match(dual.claude.title,/5시간 93% 사용 \/ 주간 전체 35% 사용 \/ 주간 Fable 0% 사용/);
    assert.deepEqual(dual.codex.values,[['13%','rgb(138, 201, 180)'],['75%','rgb(239, 201, 110)']]);assert.match(dual.codex.title,/5시간 13% 사용 \/ 주간 75% 사용/);
    fs.writeFileSync(path.join(out,'dual-bar.png'),(await bar.webContents.capturePage()).toPNG());
    openPanel('claude');await new Promise(r=>setTimeout(r,60));
    assert.match(await panel.webContents.executeJavaScript("document.querySelector('[data-window=seven_day_fable]').innerText"),/0% 사용/);
    fs.writeFileSync(path.join(out,'fable-detail.png'),(await panel.webContents.capturePage()).toPNG());
    for(const [used,color] of [[70,'rgb(239, 201, 110)'],[95,'rgb(237, 133, 140)']]){state.snapshot.providers[1].quota.windows[2].usedPercent=used;broadcast();await new Promise(r=>setTimeout(r,30));assert.equal(await bar.webContents.executeJavaScript("getComputedStyle(document.querySelector('[data-agent=claude] [data-window=seven_day_fable]')).color"),color);assert.equal(await panel.webContents.executeJavaScript("getComputedStyle(document.querySelector('[data-window=seven_day_fable] b')).color"),color);}
    state.snapshot.providers[1].quota.windows.pop();broadcast();await new Promise(r=>setTimeout(r,30));assert.equal(await bar.webContents.executeJavaScript("document.querySelector('[data-agent=claude] [data-window=seven_day_fable]').textContent"),'—');assert.match(await panel.webContents.executeJavaScript("document.querySelector('[data-window=seven_day_fable]').innerText"),/확인 불가/);

    state.snapshot.providers[2].quota.stale=true;broadcast();await new Promise(r=>setTimeout(r,40));assert.deepEqual(await bar.webContents.executeJavaScript("[...document.querySelectorAll('[data-agent=codex] .quota-number')].map(node=>getComputedStyle(node).color)"),['rgb(145, 150, 170)','rgb(145, 150, 170)']);openPanel('codex');await new Promise(r=>setTimeout(r,30));assert.equal(await panel.webContents.executeJavaScript("document.querySelector('#account').textContent"),'codex@example.com');state.snapshot.providers[2].quota.stale=false;broadcast();await new Promise(r=>setTimeout(r,40));
    state.snapshot.providers[1].authenticated=false;state.snapshot.providers[1].account={status:'unauthenticated',email:'old@example.com'};broadcast();openPanel('claude');await new Promise(r=>setTimeout(r,30));assert.equal(await panel.webContents.executeJavaScript("document.querySelector('#account').textContent"),'로그인 필요');assert.equal(await panel.webContents.executeJavaScript("document.querySelector('#organization-row').hidden"),true);state.snapshot.providers[1].authenticated=true;state.snapshot.providers[1].account={status:'unknown',email:'old@example.com'};broadcast();await new Promise(r=>setTimeout(r,30));assert.equal(await panel.webContents.executeJavaScript("document.querySelector('#account').textContent"),'확인 불가');state.snapshot.providers[1].account={status:'authenticated',email:'claude@example.com',source:'fixture',observedAt:now};broadcast();
    const colors=await bar.webContents.executeJavaScript("Object.fromEntries([...document.querySelectorAll('[data-agent]')].map(b=>[b.dataset.agent,getComputedStyle(b.querySelector('b')).color]))");assert.equal(colors.grok,'rgb(239, 201, 110)');assert.equal(colors.claude,'rgb(237, 133, 140)');assert.equal(colors.codex,'rgb(138, 201, 180)');assert.equal(bar.getBounds().width,460);
    state.snapshot.providers[1].quota.usedPercent=100;broadcast();await new Promise(r=>setTimeout(r,50));assert.equal(await bar.webContents.executeJavaScript("document.querySelector('[data-agent=claude]').dataset.state"),'limited');
    for(const provider of ['grok','claude','codex']){openPanel(provider);const b=bar.getBounds(),p=panel.getBounds();assert.equal(p.x+p.width/2,b.x+b.width/2);}
    for(const [percent,color] of [[0,'rgb(138, 201, 180)'],[69,'rgb(138, 201, 180)'],[70,'rgb(239, 201, 110)'],[89,'rgb(239, 201, 110)'],[90,'rgb(237, 133, 140)'],[100,'rgb(237, 133, 140)']]){
      for(const p of state.snapshot.providers)p.quota={state:'available',usedPercent:percent,remainingPercent:100-percent,stale:false,windows:[{id:'five_hour',label:'5시간',usedPercent:percent},{id:'seven_day',label:'주간',usedPercent:percent}]};broadcast();await new Promise(r=>setTimeout(r,40));
      for(const provider of ['grok','claude','codex']){
        assert.equal(await bar.webContents.executeJavaScript(`document.querySelector('[data-agent=${provider}] b').textContent`),`${percent}%`);
        assert.equal(await bar.webContents.executeJavaScript(`getComputedStyle(document.querySelector('[data-agent=${provider}] b')).color`),color);
        openPanel(provider);await new Promise(r=>setTimeout(r,20));assert.equal(await panel.webContents.executeJavaScript("getComputedStyle(document.querySelector('#fill')).backgroundColor"),color);
      }
    }
    state.snapshot.providers[0].quota={state:'unknown',usedPercent:null,remainingPercent:null,unavailableReason:'missing_percentage',note:'공식 Grok 응답에서 사용률 값이 제공되지 않았습니다.',stale:false};broadcast();openPanel('grok');await new Promise(r=>setTimeout(r,50));
    assert.equal(await bar.webContents.executeJavaScript("document.querySelector('[data-agent=grok] b').textContent"),'미제공');assert.equal(await panel.webContents.executeJavaScript("document.querySelector('#used').textContent"),'미제공');assert.match(await panel.webContents.executeJavaScript("document.querySelector('#notice').textContent"),/제공되지/);
    const outside={x:-100000,y:-100000};hoverStep(outside,1000);const card=panel.getBounds();hoverStep({x:card.x+20,y:card.y+20},1200);assert.equal(panel.isVisible(),true);hoverStep(outside,1400);hoverStep(outside,1721);assert.equal(panel.isVisible(),false);
    const bounds=bar.getBounds();bar.setPosition(bounds.x+25,bounds.y+25);reposition();assert.deepEqual(loadPosition(),{x:bar.getBounds().x,y:bar.getBounds().y,pinned});
    openUpdates();await new Promise(resolve=>updates.webContents.isLoading()?updates.webContents.once('did-finish-load',resolve):resolve());
    const fixtureUpdate={phase:'idle',installed:{version:'2.1.0',components:{gateway:'2.1.0',monitor:'1.1.0'}},currentComponents:{gateway:'2.1.0',monitor:'1.1.0'},selected:{version:'2.2.0',components:{gateway:'2.2.0',monitor:'1.1.0'},notes:{gateway:['<img src=x onerror=alert(1)>'],monitor:['업데이트 UI 확인']},publishedAt:now},history:[],localHistory:[],downloaded:false};
    updates.webContents.send('update-state',fixtureUpdate);bar.webContents.send('update-state',fixtureUpdate);await new Promise(r=>setTimeout(r,80));
    assert.equal(await updates.webContents.executeJavaScript("document.querySelector('#notes li').textContent"),'<img src=x onerror=alert(1)>');
    assert.equal(await updates.webContents.executeJavaScript("document.querySelector('#notes img')"),null);
    assert.equal(await bar.webContents.executeJavaScript("document.querySelector('#updates').hidden"),false);
    fixtureUpdate.selected.notes.gateway=['Gateway 최신 릴리스 정보'];updates.webContents.send('update-state',fixtureUpdate);await new Promise(r=>setTimeout(r,40));
    assert.match(await updates.webContents.executeJavaScript("document.querySelector('#installed').textContent"),/현재 Gateway 2\.1\.0 · 현재 Monitor 1\.1\.0/);
    fs.writeFileSync(path.join(out,'update-window.png'),(await updates.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(out,'smoke.json'),JSON.stringify({passed:true,checks:['three agents','hover expands','unknown quota','panel crossing remains open','outside delay collapses','position persisted'],stateDir}));console.log('MONITOR_SMOKE_OK');app.quit();
  }catch(error){console.error(error);app.exit(1);}
}

