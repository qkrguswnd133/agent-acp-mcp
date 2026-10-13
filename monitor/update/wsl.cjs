const fs=require('node:fs'),path=require('node:path');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const execute=promisify(execFile);
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const progressPhases=new Set(['starting','preparing','downloading','verifying','installing','updating']);
const version=value=>typeof value==='string'&&/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value)?value:null;
const message=value=>typeof value==='string'?value.slice(0,2000):undefined;
function decode(value){if(!Buffer.isBuffer(value))return String(value??'').replace(/\0/g,'');const wide=value.length>1&&(value[0]===255&&value[1]===254||value.subarray(0,100).includes(0));return value.toString(wide?'utf16le':'utf8').replace(/^\uFEFF/,'').replace(/\0/g,'');}
function distroNames(value){return [...new Set(decode(value).split(/\r?\n/).map(s=>s.trim()).filter(s=>s&&s.length<=128&&!/[\x00-\x1f\x7f]/.test(s)&&!s.startsWith('-')))];}
function parseOutput(value){let last;for(const line of decode(value).split(/\r?\n/)){try{const parsed=JSON.parse(line);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))last=parsed;}catch{}}if(!last)throw Error('WSL 업데이터의 JSON 응답을 확인할 수 없습니다.');return last;}
// Only a static shell program is executed. Distro names are separate argv,
// never interpolated into shell syntax. No login profiles or Windows Node shim.
const legacyProbe=`const fs=require('node:fs'),path=require('node:path'),os=require('node:os');const root=path.join(process.env.XDG_DATA_HOME||path.join(os.homedir(),'.local','share'),'agent-acp-mcp');let pkg;try{pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'))}catch{}console.log(JSON.stringify({installed:!!pkg,version:null,gatewayVersion:pkg?.version||null,legacy:!!pkg,canUpdate:false,message:pkg?'Linux 설치 프로그램을 한 번 실행하여 업데이트 기능을 등록하세요.':'Gateway가 설치되어 있지 않습니다.'}));`;
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
const probeScript=`if [ -x "$HOME/.local/bin/agent-acp" ]; then exec "$HOME/.local/bin/agent-acp" status --json; elif command -v node >/dev/null 2>&1; then exec node -e ${quote(legacyProbe)}; else if [ -f "\${XDG_DATA_HOME:-$HOME/.local/share}/agent-acp-mcp/package.json" ]; then printf '%s\\n' '{"installed":true,"legacy":true,"canUpdate":false,"message":"Linux 설치 프로그램으로 업데이트 기능을 등록하세요."}'; else printf '%s\\n' '{"installed":false,"canUpdate":false,"message":"Gateway가 설치되어 있지 않습니다."}'; fi; fi`;
function cliScript(args){return `if [ ! -x "$HOME/.local/bin/agent-acp" ]; then printf '%s\\n' '{"status":"blocked","error":"Linux 설치 프로그램을 먼저 실행하세요."}'; exit 0; fi; exec "$HOME/.local/bin/agent-acp" ${args.map(quote).join(' ')}`;}
function createWslUpdates({platform=process.platform,exec=execute,stateDir,blocked=()=>false,timers=globalThis}={}){
 let state={available:false,status:'unavailable',message:'WSL 확인 전',targets:[],busy:false},busy=false,closed=false,polling=false,timer;
 let listener=()=>{};const operations=new Map();
 const journal=stateDir&&path.join(stateDir,'wsl-operations.json');
 if(journal)try{const stat=fs.statSync(journal);if(stat.size<65536){const saved=JSON.parse(fs.readFileSync(journal,'utf8'));for(const [name,id] of Object.entries(saved))if(typeof name==='string'&&name.length<=128&&typeof id==='string'&&uuid.test(id))operations.set(name,id);}}catch{}
 const save=()=>{if(journal)try{fs.mkdirSync(stateDir,{recursive:true});const tmp=journal+'.tmp';fs.writeFileSync(tmp,JSON.stringify(Object.fromEntries(operations)));fs.renameSync(tmp,journal);}catch{}};
 const getState=()=>structuredClone({...state,busy:busy||operations.size>0});
 const completedRefresh=()=>({...getState(),busy:operations.size>0});
 const publish=()=>{try{listener(getState());}catch{}};
 const patch=(id,fields)=>{if(fields.phase&&!progressPhases.has(fields.phase))fields={...fields,progress:null};state.targets=state.targets.map(target=>target.id===id?{...target,...fields}:target);publish();};
 const command=async(args,timeout=12000)=>exec('wsl.exe',args,{windowsHide:true,shell:false,timeout,maxBuffer:1024*1024,encoding:'buffer'});
 const inDistro=async(id,script,timeout=45000)=>{try{return parseOutput((await command(['--distribution',id,'--exec','sh','-c',script],timeout)).stdout);}catch(error){if(error.stdout){const value=parseOutput(error.stdout);if(['error','blocked','cancelled'].includes(value.status))return value;}throw error;}};
 const target=id=>{if(typeof id!=='string'||!state.targets.some(t=>t.id===id))throw Error('확인된 WSL 배포판을 선택하세요.');return state.targets.find(t=>t.id===id);};
 const apply=(id,value)=>{
  const current=target(id),fields={running:true,error:message(value.error),message:message(value.message),phase:value.phase||value.status||'idle'};
  if(typeof value.installed==='boolean')fields.installed=value.installed;
  if('version' in value||'currentVersion' in value)fields.version=version(value.currentVersion??value.version);
  if(value.gatewayVersion)fields.gatewayVersion=version(value.gatewayVersion);
  if(value.latestVersion||value.latest?.version||value.selected?.version)fields.latestVersion=version(value.latestVersion??value.latest?.version??value.selected?.version);
  if(typeof value.legacy==='boolean')fields.legacy=value.legacy;
  if(typeof value.canUpdate==='boolean')fields.canUpdate=value.canUpdate&&!!(fields.latestVersion??current.latestVersion)&&(fields.latestVersion??current.latestVersion)!==(fields.version??current.version)&&!(fields.legacy??current.legacy);
  else if(fields.latestVersion)fields.canUpdate=(fields.latestVersion!==(fields.version??current.version))&&(fields.installed??current.installed)===true&&!value.blocked;
  if(value.status==='blocked'||value.blocked){fields.canUpdate=false;fields.error=message(value.error??value.message??value.blocked)||'진행 중인 작업 또는 환경 상태로 업데이트가 보류됐습니다.';}
  if(value.progress&&Number.isFinite(value.progress.received)&&Number.isFinite(value.progress.total)&&value.progress.total>0)fields.progress={received:Math.max(0,value.progress.received),total:value.progress.total};
  else if(typeof value.progress==='number'&&Number.isFinite(value.progress))fields.progress={received:Math.max(0,Math.min(100,value.progress)),total:100,unit:'percent'};
  patch(id,fields);
 };
 async function refresh(){
  if(busy)return getState();busy=true;publish();
  try{
   if(platform!=='win32'){state={available:false,status:'unavailable',message:'Linux에서는 agent-acp update 명령을 사용하세요.',targets:[],busy:false};return completedRefresh();}
   let listed;
   try{listed=await command(['--list','--quiet']);}catch(error){state={available:false,status:error.code==='ENOENT'?'unavailable':'disabled',message:error.code==='ENOENT'?'WSL이 설치되어 있지 않습니다.':'WSL을 사용할 수 없거나 배포판 목록을 읽지 못했습니다.',targets:[],busy:false};return completedRefresh();}
   const names=distroNames(listed.stdout);let running;
   try{running=new Set(distroNames((await command(['--list','--running','--quiet'])).stdout));}catch{state={available:true,status:'error',message:'배포판 실행 상태를 확인하지 못했습니다. 자동으로 시작하지 않습니다.',targets:names.map(name=>({id:name,name,running:false,message:'실행 상태 확인 불가'})),busy:false};return completedRefresh();}
   const previous=new Map(state.targets.map(t=>[t.id,t]));state={available:true,status:names.length?'available':'empty',message:names.length?undefined:'설치된 WSL 배포판이 없습니다.',targets:names.map(name=>({...previous.get(name),id:name,name,running:running.has(name)})),busy:false};
   for(const item of state.targets){if(!item.running){patch(item.id,{phase:'stopped',message:'시작하고 확인을 누르면 이 배포판을 시작합니다.'});continue;}
    if(operations.has(item.id))continue;
    try{const status=await inDistro(item.id,probeScript);apply(item.id,status);if(status.installed&&!status.legacy)apply(item.id,await inDistro(item.id,cliScript(['update','--check','--json']),60000));}catch{patch(item.id,{error:'Gateway 상태 확인에 실패했습니다.',phase:'error'});}
   }
   schedule();return completedRefresh();
  }finally{busy=false;publish();}
 }
 async function probe(id){target(id);if(busy||operations.size||blocked())return getState();busy=true;patch(id,{phase:'checking',error:null});
  try{const status=await inDistro(id,probeScript);apply(id,status);if(status.installed&&!status.legacy)apply(id,await inDistro(id,cliScript(['update','--check','--json']),60000));}
  catch{patch(id,{phase:'error',error:'WSL Gateway 확인에 실패했습니다. 배포판과 Linux 설치 상태를 확인하세요.'});}
  finally{busy=false;publish();}return getState();
 }
 async function update(id){const item=target(id);if(busy||operations.size||blocked())return getState();if(!item.installed||item.legacy){patch(id,{error:'Linux 설치 프로그램을 먼저 실행하여 업데이트 기능을 등록하세요.'});return getState();}
  busy=true;patch(id,{phase:'preparing',error:null,progress:null});
  try{const result=await inDistro(id,cliScript(['update','--background','--json']),20000);apply(id,result);if(result.status==='started'&&uuid.test(result.operationId)){operations.set(id,result.operationId);save();patch(id,{phase:'downloading',message:'Linux 업데이터가 실행 중입니다. Monitor를 닫아도 계속 진행합니다.'});schedule();}}
  catch{patch(id,{phase:'error',error:'업데이터 시작을 확인하지 못했습니다. Linux에서 agent-acp status --json으로 확인하세요.'});}
  finally{busy=false;publish();}return getState();
 }
 function schedule(){if(closed||timer||!operations.size)return;timer=timers.setTimeout(()=>{timer=undefined;void poll();},2000);timer?.unref?.();}
 async function poll(){if(polling||closed)return;polling=true;
  try{for(const [id,operationId] of operations){if(!state.targets.some(t=>t.id===id&&t.running))continue;
   try{const value=await inDistro(id,cliScript(['operation',operationId,'--json']),12000);apply(id,value);
    if(['installed','up_to_date','error','success','failed','blocked','rolled_back','rollback_failed','cancelled'].includes(value.status)){operations.delete(id);save();if(['installed','success','up_to_date'].includes(value.status))patch(id,{canUpdate:false,message:value.status==='up_to_date'?'이미 최신 버전입니다.':'업데이트 완료. 해당 WSL 환경의 MCP를 재연결하세요.'});}
   }catch{patch(id,{message:'Linux 업데이트 결과를 아직 확인하지 못했습니다. 작업을 다시 실행하지 마세요.'});}
  }}finally{polling=false;publish();schedule();}
 }
 return {refresh,probe,update,poll,getState,onChange(fn){listener=fn;},isBusy:()=>busy||operations.size>0,isDispatching:()=>busy,close(){closed=true;if(timer)timers.clearTimeout(timer);}};
}
module.exports={createWslUpdates,decode,distroNames,parseOutput,probeScript,cliScript};
