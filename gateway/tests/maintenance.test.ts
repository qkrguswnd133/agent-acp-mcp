import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {MaintenanceGate} from '../src/maintenance.js';
import {matchesWindowsCimCreation} from '../src/process-identity.js';

const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gateway-maintenance-'));return {dir,root:path.join(dir,'gateway')};}
async function request(root:string,phase:'prepare'|'commit',expires=Date.now()+60_000){
  // Match the actual Update.ps1 producer, not the gateway's CIM reader: its
  // native StartTime retains the final 100 ns digit omitted by CIM.
  const ownerStartedAt=await new Promise<string>((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',`(Get-Process -Id ${process.pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString()`],{encoding:'utf8',timeout:10000,windowsHide:true},(error,stdout)=>error?reject(error):resolve(stdout.trim())));
  const data={schemaVersion:1,operationId:randomUUID(),ownerPid:process.pid,ownerStartedAt,requestedAt:new Date().toISOString(),expiresAt:new Date(expires).toISOString(),phase};
  fs.writeFileSync(root+'.maintenance.json',JSON.stringify(data));return data;
}

test('busy gateway blocks new work but does not acknowledge or exit', {skip:process.platform!=='win32'},async()=>{
  const {dir,root}=fixture();let idle=false,exits=0;const gate=new MaintenanceGate(root,()=>idle,()=>{exits++;});
  try{
    const lease=await request(root,'prepare');gate.start();
    await assert.rejects(gate.assertAvailable(),/GATEWAY_MAINTENANCE/);
    await pause(250);
    assert.equal(fs.existsSync(`${root}.maintenance.${lease.operationId}.${process.pid}.ack.json`),false);
    assert.equal(exits,0);
    idle=true;for(let i=0;i<100&&!fs.existsSync(`${root}.maintenance.${lease.operationId}.${process.pid}.ack.json`);i++)await pause(50);
    assert.equal(fs.existsSync(`${root}.maintenance.${lease.operationId}.${process.pid}.ack.json`),true);
    assert.equal(exits,0);
    fs.writeFileSync(root+'.maintenance.json',JSON.stringify({...lease,phase:'commit'}));
    for(let i=0;i<100&&exits===0;i++)await pause(50);assert.equal(exits,1);
  }finally{gate.stop();fs.rmSync(dir,{recursive:true,force:true});}
});

test('native Windows updater ticks compare only at the observed CIM microsecond precision',()=>{
 const bucket=639277678054974860n;
 for(let remainder=0n;remainder<10n;remainder++)assert.equal(matchesWindowsCimCreation(String(bucket),String(bucket+remainder)),true);
 for(const recorded of [bucket-1n,bucket-10n,bucket+10n,bucket+19n])assert.equal(matchesWindowsCimCreation(String(bucket),String(recorded)),false);
 // A one-tick difference across a bucket boundary is never a fuzzy match.
 assert.equal(matchesWindowsCimCreation(String(bucket+10n),String(bucket+9n)),false);
 assert.equal(matchesWindowsCimCreation(String(bucket+1n),String(bucket+2n)),false);
 for(const observed of [undefined,'not-ticks','1'])assert.equal(matchesWindowsCimCreation(observed,String(bucket)),false);
 assert.equal(matchesWindowsCimCreation(String(bucket),'not-ticks'),false);
});

test('Windows gate accepts the existing native updater record and rejects reused PID creation buckets',async()=>{
 const {dir,root}=fixture(),observed='639277678054974860';
 const gate=new MaintenanceGate(root,()=>true,()=>{}, {platform:'win32',alive:()=>true,identity:()=>observed});
 try{
  for(const [ownerStartedAt,expected] of [['639277678054974868',true],['639277678054974859',false],['639277678054974870',false]] as const){
   fs.writeFileSync(root+'.maintenance.json',JSON.stringify({schemaVersion:1,operationId:randomUUID(),ownerPid:42,ownerStartedAt,requestedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),phase:'prepare'}));
   assert.equal(await gate.blocked(),expected);
  }
 }finally{gate.stop();fs.rmSync(dir,{recursive:true,force:true});}
});

test('expired lease is ignored on gateway startup', {skip:process.platform!=='win32'},async()=>{
  const {dir,root}=fixture();const gate=new MaintenanceGate(root,()=>true,()=>{});
  try{await request(root,'commit',Date.now()-1000);assert.equal(await gate.blocked(),false);await gate.assertAvailable();}finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('pending Windows lease identity query shares work and keeps the event loop responsive',async()=>{
 const {dir,root}=fixture();let calls=0,resolveIdentity!:(value:string)=>void;
 const identity=new Promise<string>(resolve=>{resolveIdentity=resolve;});
 const gate=new MaintenanceGate(root,()=>false,()=>{}, {platform:'win32',alive:()=>true,identity:()=>{calls++;return identity;}});
 try{
  fs.writeFileSync(root+'.maintenance.json',JSON.stringify({schemaVersion:1,operationId:randomUUID(),ownerPid:42,ownerStartedAt:'638959536000000000',requestedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),phase:'prepare'}));
  const first=gate.blocked(),second=gate.blocked();let ticked=false;await new Promise<void>(resolve=>setImmediate(()=>{ticked=true;resolve();}));assert.equal(ticked,true);assert.equal(calls,1);
  resolveIdentity('638959536000000000');assert.deepEqual(await Promise.all([first,second]),[true,true]);
 }finally{gate.stop();fs.rmSync(dir,{recursive:true,force:true});}
});
