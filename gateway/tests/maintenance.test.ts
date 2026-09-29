import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {MaintenanceGate} from '../src/maintenance.js';

const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gateway-maintenance-'));return {dir,root:path.join(dir,'gateway')};}
function request(root:string,phase:'prepare'|'commit',expires=Date.now()+60_000){
  const ownerStartedAt=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`(Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().Ticks`],{encoding:'utf8'}).trim();
  const data={schemaVersion:1,operationId:randomUUID(),ownerPid:process.pid,ownerStartedAt,requestedAt:new Date().toISOString(),expiresAt:new Date(expires).toISOString(),phase};
  fs.writeFileSync(root+'.maintenance.json',JSON.stringify(data));return data;
}

test('busy gateway blocks new work but does not acknowledge or exit', {skip:process.platform!=='win32'},async()=>{
  const {dir,root}=fixture();let idle=false,exits=0;const gate=new MaintenanceGate(root,()=>idle,()=>{exits++;});
  try{
    const lease=request(root,'prepare');gate.start();
    assert.throws(()=>gate.assertAvailable(),/GATEWAY_MAINTENANCE/);
    await pause(250);
    assert.equal(fs.existsSync(`${root}.maintenance.${lease.operationId}.${process.pid}.ack.json`),false);
    assert.equal(exits,0);
    idle=true;await pause(250);
    assert.equal(fs.existsSync(`${root}.maintenance.${lease.operationId}.${process.pid}.ack.json`),true);
    assert.equal(exits,0);
    fs.writeFileSync(root+'.maintenance.json',JSON.stringify({...lease,phase:'commit'}));
    await pause(250);assert.equal(exits,1);
  }finally{gate.stop();fs.rmSync(dir,{recursive:true,force:true});}
});

test('expired lease is ignored on gateway startup', {skip:process.platform!=='win32'},()=>{
  const {dir,root}=fixture();const gate=new MaintenanceGate(root,()=>true,()=>{});
  try{request(root,'commit',Date.now()-1000);assert.equal(gate.blocked(),false);gate.assertAvailable();}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
