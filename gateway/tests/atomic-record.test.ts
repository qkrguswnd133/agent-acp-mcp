import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {replaceRecord} from '../src/atomic-record.js';
import {MaintenanceOperations} from '../src/maintenance-operations.js';

const denied=()=>Object.assign(Error('sharing violation'),{code:'EPERM'});
async function fixture(run:(root:string)=>Promise<void>){const root=await fs.mkdtemp(path.join(os.tmpdir(),'atomic-record-'));try{await run(root);}finally{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('atomic-record-'));await fs.rm(root,{recursive:true,force:true});}}

test('Windows record replacement retries sharing conflicts without unlinking the previous record',()=>fixture(async root=>{
 const destination=path.join(root,'record.json'),source=path.join(root,'pending.tmp');await fs.writeFile(destination,'old');await fs.writeFile(source,'new');let attempts=0;const delays:number[]=[];
 await replaceRecord(source,destination,{platform:'win32',delay:async ms=>{delays.push(ms);assert.equal(await fs.readFile(destination,'utf8'),'old');},rename:async(a,b)=>{if(attempts++<2)throw denied();await fs.rename(a,b);}});
 assert.equal(attempts,3);assert.deepEqual(delays,[20,40]);assert.equal(await fs.readFile(destination,'utf8'),'new');
}));

test('record replacement rechecks compare-and-swap guard after a sharing conflict and preserves newer data',()=>fixture(async root=>{
 const destination=path.join(root,'record.json'),source=path.join(root,'pending.tmp');await fs.writeFile(destination,'old');await fs.writeFile(source,'new');let attempts=0;
 await assert.rejects(replaceRecord(source,destination,{platform:'win32',rename:async()=>{attempts++;throw denied();},delay:async()=>{await fs.writeFile(destination,'newer writer');},beforeAttempt:async()=>{if(await fs.readFile(destination,'utf8')!=='old')throw Error('record changed');}}),/record changed/);
 assert.equal(attempts,1);assert.equal(await fs.readFile(destination,'utf8'),'newer writer');assert.equal(await fs.readFile(source,'utf8'),'new');
}));

test('record retry is bounded and does not retry permanent or non-Windows errors',async()=>{
 for(const [platform,code,expected] of [['win32','EPERM',8],['win32','ENOENT',1],['linux','EACCES',1]] as const){let attempts=0;await assert.rejects(replaceRecord('source','destination',{platform,delay:async()=>{},rename:async()=>{attempts++;throw Object.assign(Error(code),{code});}}),{code});assert.equal(attempts,expected);}
});

test('a final operation record sharing conflict cannot replay maintenance or turn its successful result into failure',()=>fixture(async root=>{
 let runs=0,conflicts=0;
 const manager=new MaintenanceOperations(root,(source,destination)=>replaceRecord(source,destination,{platform:'win32',delay:async()=>{},rename:async(a,b)=>{if(JSON.parse(await fs.readFile(a,'utf8')).status==='completed'&&conflicts++<2)throw denied();await fs.rename(a,b);}}));
 const accepted=await manager.start('fixture',{},async()=>{runs++;return {ok:true,removedPaths:['fixture-output']};});await manager.drain();
 const result=await manager.status(accepted.operation_id);assert.equal(runs,1);assert.equal(result.status,'completed');assert.deepEqual(result.result,{ok:true,removedPaths:['fixture-output']});assert.equal(conflicts,3);
}));
