import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import manager from '../update/cli-manager.cjs';
import batch from '../update/cli-batch.cjs';

const windows={id:'windows',name:'Windows',running:true};
const ubuntu={id:'wsl:Ubuntu',name:'WSL · Ubuntu',running:false};
const available={provider:'codex',status:'available',path:'C:/tools/codex.exe',method:'native',currentVersion:'1.0.0',latestVersion:'1.1.0'};
function fixture(t,options={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cli-monitor-test-'));
  const create=()=>manager.createCliUpdates({stateDir:dir,monitorDirectory:dir,listTargets:async()=>[windows,ubuntu],...options});
  const service=create();
  t.after(()=>{service.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {dir,service,create};
}
test('regular discovery never wakes a stopped distribution; explicit target can start only that environment', async t=>{
  const calls=[];
  const {service}=fixture(t,{command:async(id,args,opts)=>{calls.push({id,args,start:opts.start});return {rows:[available]};}});
  await service.refresh();await service.refresh('wsl:Unknown');
  assert.deepEqual(calls,[{id:'windows',args:['list'],start:false}]);
  const state=await service.refresh('wsl:Ubuntu');
  assert.equal(state.targets[1].running,true);assert.deepEqual(calls.at(-1),{id:'wsl:Ubuntu',args:['list'],start:true});
});
test('accepted batch includes eligible displayed rows once; reopening restores stages and terminal result',async t=>{
  let file,launches=0;
  const {service,create}=fixture(t,{command:async()=>({rows:[available,{provider:'grok',status:'manual'}]}),start:async f=>{file=f;launches++;return process.pid;}});
  await service.refresh();
  await Promise.all([service.run(),service.run()]);
  assert.equal(launches,1);
  const journal=JSON.parse(fs.readFileSync(file));assert.equal(journal.items.length,1);
  journal.items[0].status='verifying';batch.writeState(file,journal);
  service.close();
  const reopened=create();t.after(()=>reopened.close());
  await reopened.refresh();assert.equal(reopened.snapshot().targets[0].rows[0].status,'verifying');
  journal.items[0].status='updated';journal.items[0].currentVersion='1.1.0';journal.busy=false;
  batch.writeState(file,journal);
  await reopened.refresh();
  assert.equal(reopened.snapshot().busy,false);
  assert.equal(reopened.snapshot().targets[0].rows[0].lastResult.status,'updated');
});
test('batch continues after a provider is busy and validates the terminal response ID',async()=>{
  const calls=[];
  const result=await batch.runBatch(['claude','codex','grok'].map(provider=>({...available,provider,id:'windows'})),async(id,args)=>{
    calls.push(args);
    const provider=args[1],operationId=args[3];
    return {operationId:provider==='grok'?'wrong-id':operationId,busy:false,rows:[{provider,status:provider==='claude'?'blocked':'updated',currentVersion:provider==='codex'?'1.1.0':'1.0.0'}]};
  },()=>{});
  assert.deepEqual(result.items.map(i=>i.status),['blocked','updated','error']);
  assert.equal(result.items[1].previousVersion,'1.0.0');assert.equal(result.busy,false);
  assert.ok(calls.every(args=>args.includes('--expected-path')&&args.includes(available.path)&&args.includes('--expected-version')&&args.includes('--expected-latest')));
});

