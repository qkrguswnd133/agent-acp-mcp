import readline from 'node:readline';
import {loadMonitor} from './monitor.mjs';

const monitor=await loadMonitor();
const input=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
input.on('line',async line=>{
  let request;try{if(line.length>4096)throw Error();request=JSON.parse(line);}catch{process.stdout.write(JSON.stringify({id:null,error:'invalid_request'})+'\n');return;}
  const id=typeof request?.id==='string'||typeof request?.id==='number'?request.id:null;
  if(request?.method!=='status'){process.stdout.write(JSON.stringify({id,error:'unsupported_method'})+'\n');return;}
  try{process.stdout.write(JSON.stringify({id,result:await monitor.status()})+'\n');}catch{process.stdout.write(JSON.stringify({id,error:'status_unavailable'})+'\n');}
});
// Only this worker and its read-only helper children belong to the monitor.
// No gateway instance or persistent gateway job is stopped on monitor close.
input.on('close',()=>process.exit(0));
