'use strict';
const fs = require('node:fs');
const {randomUUID} = require('node:crypto');
const {createTransport} = require('./cli-transport.cjs');

function writeState(file, value) {
  const temp = file+'.'+randomUUID()+'.tmp';
  fs.writeFileSync(temp,JSON.stringify(value),{mode:0o600});
  fs.renameSync(temp,file);
}

// A batch outlives the monitor window. Each environment's Gateway serializes
// operations with its own CLI users and rechecks ownership before replacement.
async function runBatch(items, command, publish, interval=1500) {
  const state = {busy:true, workerPid:process.pid, items:structuredClone(items)};
  publish(state);
  for (const item of state.items) {
    const {id,provider,currentVersion,path,latestVersion} = item;
    const operationId = randomUUID();
    item.status = 'checking';
    publish(state);
    let poll, inFlight = false, finished = false;
    try {
      poll = setInterval(async () => {
        if (inFlight) return;
        inFlight = true;
        try {
          const result = await command(id,['status','--operation-id',operationId]);
          const row = result.rows.find(r => r.provider === provider);
          if (!finished && result.operationId === operationId && row && ['checking','updating','verifying'].includes(row.status)) {
            item.status = row.status;
            publish(state);
          }
        } catch { /* The terminal result comes from the update process. */ }
        finally { inFlight = false; }
      }, interval);
      const result = await command(id,['update',provider,'--operation-id',operationId,'--expected-path',path,'--expected-version',currentVersion,'--expected-latest',latestVersion],{updating:true});
      const row = result.rows.find(r=>r.provider===provider);
      if (result.operationId !== operationId || !row || result.busy || !['updated','current','blocked','error','manual','missing'].includes(row.status))
        throw Error('업데이트 결과를 확인할 수 없습니다. 새로고침으로 설치 버전을 확인하세요.');
      Object.assign(item,row,{id,provider,previousVersion:currentVersion});
    } catch (error) {
      item.status='error';
      item.message=error.message;
    } finally {
      finished=true;
      clearInterval(poll);
      publish(state);
    }
  }
  state.busy=false;
  publish(state);
  return state;
}

if (require.main===module) {
  const [file,monitorDirectory]=process.argv.slice(2);
  const {items}=JSON.parse(fs.readFileSync(file,'utf8'));
  runBatch(items,createTransport(monitorDirectory),state=>writeState(file,state)).catch(()=>{process.exitCode=1;});
}
module.exports={runBatch,writeState};

