const path=require('node:path');
const LABEL='Windows 로그인 시 자동 실행';
// Electron joins Windows login args unquoted, so quote each value per CommandLineToArgvW rules.
function quoteArg(value){return /[\s"]/.test(value)||value.endsWith('\\')?'"'+value.replace(/(\\*)"/g,'$1$1\\"').replace(/(\\+)$/,'$1$1')+'"':value;}
const unquote=value=>{const text=String(value),quoted=/^"(.*)"$/s.exec(text);return quoted?quoted[1].replace(/(\\+)\1$/,'$1'):text;};
const samePath=(a,b)=>typeof a==='string'&&typeof b==='string'&&path.win32.normalize(unquote(a)).toLowerCase()===path.win32.normalize(b).toLowerCase();
// OS login-item state is the only source of truth; nothing is persisted or registered implicitly.
function createLoginItem({loginApi,platform,packaged,execPath,dataDir,notify=()=>{}}){
  const unavailable=platform!=='win32'?'Windows 전용':!packaged||path.win32.basename(execPath||'').toLowerCase()!=='agent monitor.exe'?'설치된 앱에서만 사용 가능':null;
  const rawArgs=dataDir?['--data-dir='+dataDir]:[];
  const options=()=>({path:execPath,args:rawArgs.map(quoteArg)});
  function read(){
    if(unavailable)return {available:false,enabled:false,registered:false,reason:unavailable};
    // Electron 44 parses this lookup path as a command line. Quote spaces for
    // lookup only; registration still receives the plain executable path.
    let settings;try{settings=loginApi.get({...options(),path:quoteArg(execPath)});}catch(error){return {available:true,enabled:false,registered:false,error:`자동 실행 상태를 확인하지 못했습니다: ${error?.message??error}`};}
    const registered=settings?.openAtLogin===true;
    const matches=(Array.isArray(settings?.launchItems)?settings.launchItems:[]).filter(item=>samePath(item.path,execPath)&&(item.args??[]).map(unquote).join('\0')===rawArgs.join('\0'));
    const approved=matches.length?matches.some(item=>item.enabled!==false):settings?.executableWillLaunchAtLogin===true;
    return {available:true,registered,enabled:registered&&approved,blocked:registered&&!approved};
  }
  function setEnabled(value){
    if(unavailable)throw Error(`자동 실행을 변경할 수 없습니다: ${unavailable}`);
    try{loginApi.set(value?{...options(),openAtLogin:true,enabled:true}:{...options(),openAtLogin:false});}
    catch(error){throw Error(`자동 실행 설정을 변경하지 못했습니다: ${error?.message??error}`);}
    const after=read();
    if(after.error)throw Error(after.error);
    if(after.enabled!==value)throw Error(value?(after.blocked?'Windows 시작 앱 설정 또는 정책에서 자동 실행이 꺼져 있습니다.':'자동 실행 등록이 Windows에 반영되지 않았습니다.'):'자동 실행 해제가 Windows에 반영되지 않았습니다.');
    return after;
  }
  function menuItem(){
    const current=read();
    const suffix=current.reason?` (${current.reason})`:current.error?' (상태 확인 실패)':current.blocked?' (Windows 시작 앱에서 꺼짐)':'';
    return {label:LABEL+suffix,type:'checkbox',checked:current.enabled,enabled:current.available,click:()=>{try{setEnabled(!current.enabled);}catch(error){notify(error.message);}}};
  }
  return {read,setEnabled,menuItem,options};
}
module.exports={createLoginItem,quoteArg,LABEL};
