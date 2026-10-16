import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {verifyTrackedProcessesAbsent,classifyProcessCleanup} from '../src/process-cleanup.js';
import {readProcessInventory,type RecordedProcessIdentity,type ProcessInventory} from '../src/process-inventory.js';
import {trackProcessTree,ownedDescendants} from '../src/process-tree.js';
import {processIdentityAsync} from '../src/process-identity.js';
import {verifyFinishedOwnership} from '../src/interrupted-ownership.js';
import {terminateProcessWithSnapshot} from '../src/process.js';
import {EventEmitter} from 'node:events';
import type {ChildProcess} from 'node:child_process';
const observedAt='2026-10-13T12:00:00.000Z',start='2026-10-13T10:00:00.000Z',end='2026-10-13T11:00:00.000Z';
const row=(pid:number,createdAt:string|null='2026-10-13T10:30:00.000Z',parentPid=0,imageName='node.exe'):RecordedProcessIdentity=>({pid,parentPid,createdAt,imageName,observedAt});
const inventory=(rows:RecordedProcessIdentity[],complete=true):ProcessInventory=>({processes:rows,observedAt,complete});

test('reused parent PID cannot adopt a child born before its parent or run root',async()=>{
 const root={pid:9840,parentPid:1,created:start},old={pid:5764,parentPid:9840,created:'2026-10-13T06:00:00.000Z'},child={pid:100,parentPid:9840,created:end},grandchild={pid:101,parentPid:100,created:'2026-10-13T11:01:00.000Z'},backdated={pid:102,parentPid:100,created:'2026-10-13T10:59:00.000Z'};
 assert.deepEqual(ownedDescendants([root,old,child,grandchild,backdated],new Map([[root.pid,root]]),root,start).map(row=>row.pid),[9840,100,101]);
 assert.deepEqual(ownedDescendants([root,child],new Map([[root.pid,root]]),root,'2026-10-13T10:00:01.000Z'),[]);
 const preciseRoot={...root,created:'windows:638000000000000002'},preciseOld={...old,created:'windows:638000000000000001'};
 assert.deepEqual(ownedDescendants([preciseRoot,preciseOld],new Map([[root.pid,preciseRoot]]),preciseRoot).map(row=>row.pid),[9840]);
 const killed:number[]=[];
 const tracker=trackProcessTree(root.pid,()=>true,{snapshot:async()=>killed.length?[root,old]:[root,old,child],terminate:async pid=>{killed.push(pid);}});await new Promise(resolve=>setTimeout(resolve,0));
 const result=await tracker.cleanup();assert.deepEqual(result.trackedPids,[100]);assert.deepEqual(killed,[100]);assert.equal(result.verified,true);
});

test('root termination excludes stale-parent children and refreshes creation before each individual kill',async()=>{
 for(const changed of [false,true]){
  const root={pid:1900000000,parentPid:1,created:start},child={pid:1900000001,parentPid:root.pid,created:end},old={pid:1900000002,parentPid:root.pid,created:'2026-10-13T06:00:00.000Z'};
  const emitter=new EventEmitter(),processFixture=Object.assign(emitter,{pid:root.pid,exitCode:null as number|null,signalCode:null,kill(){this.exitCode=0;emitter.emit('close',0);return true;}}) as unknown as ChildProcess;
  let calls=0;const killed:number[]=[];
  const result=await terminateProcessWithSnapshot(processFixture,{snapshot:async()=>{calls++;return [root,old,changed&&calls>1?{...child,created:observedAt}:child];},kill:pid=>{killed.push(pid);}});
  assert.equal(result,true);assert.deepEqual(killed,changed?[]:[child.pid]);assert.equal(calls,2);
 }
});

test('one Windows inventory supplies async lease identity, tracked identity and workspace ownership checks',async()=>{
 let calls=0;let pending:Promise<ProcessInventory>|undefined;
 const snapshot=()=>pending??=readProcessInventory({platform:'win32',execute:async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,5));return JSON.stringify([{ProcessId:123,ParentProcessId:0,Name:'fixture.exe',CommandLine:'fixture.exe',CreatedAt:start,CreationKey:'638959536000000000'}]);}});
 const [identity,proof,ownership]=await Promise.all([processIdentityAsync(123,{platform:'win32',snapshot}),verifyTrackedProcessesAbsent([77],{snapshot}),verifyFinishedOwnership({ownerPid:999,workspacePaths:['C:\\fixture-worktree']},{platform:'win32',snapshot})]);
 assert.equal(identity,'638959536000000000');assert.deepEqual(proof.absentPids,[77]);assert.equal(ownership.processScan,'passed');assert.equal(calls,1);
});
test('same PID different creation is reused, same creation stays alive regardless of renamed image',async()=>{
 const saved=row(77,start),current=row(77,end,0,'chrome.exe');
 const proof=await verifyTrackedProcessesAbsent([77],{trackedProcesses:[saved],snapshot:async()=>inventory([current])});assert.deepEqual(proof.reusedPids,[77]);assert.equal(proof.checks?.[0].currentImageName,'chrome.exe');assert.equal(proof.checks?.[0].recordedCreatedAt,start);
 await assert.rejects(verifyTrackedProcessesAbsent([77],{trackedProcesses:[saved],snapshot:async()=>inventory([{...saved,imageName:'renamed.exe'}])}),(error:any)=>error.processCheck.checks[0].decision==='alive');
 const precise={...saved,creationKey:'windows:638959536000000001'};assert.deepEqual((await verifyTrackedProcessesAbsent([77],{trackedProcesses:[precise],snapshot:async()=>inventory([{...precise,creationKey:'windows:638959536000000002'}])})).reusedPids,[77]);
});
test('legacy creation outside job lifetime proves reuse but unknown time never does',async()=>{
 const cleanupAt=classifyProcessCleanup({processCleanup:{at:end,trackedPids:[77],remainingPids:[],verified:false}}).cleanupAt;assert.equal(cleanupAt,end);assert.deepEqual((await verifyTrackedProcessesAbsent([77],{startedAt:start,cleanupAt,snapshot:async()=>inventory([row(77,'2026-10-13T11:01:00.000Z')])})).reusedPids,[77]);
 for(const created of ['2026-10-13T09:00:00.000Z','2026-10-13T11:01:00.000Z'])assert.deepEqual((await verifyTrackedProcessesAbsent([77],{startedAt:start,finishedAt:end,snapshot:async()=>inventory([row(77,created)])})).reusedPids,[77]);
 for(const created of [null,'not-a-date'])await assert.rejects(verifyTrackedProcessesAbsent([77],{startedAt:start,finishedAt:end,snapshot:async()=>inventory([row(77,created)])}),(e:any)=>e.processCheck.checks[0].decision==='unknown');
 await assert.rejects(verifyTrackedProcessesAbsent([77],{snapshot:async()=>inventory([row(77,end)])}),/unverified/);
});
test('legacy within lifetime needs complete creation-consistent independent ancestry and explicit anchors',async()=>{
 const rows=[row(77,undefined,50),row(50,'2026-10-13T09:00:00.000Z',4),row(4,'2026-10-13T08:00:00.000Z',0)];
 const options={startedAt:start,finishedAt:end,rootPids:[42],rootAnchorSource:'job_owner',snapshot:async()=>inventory(rows)};
 assert.deepEqual((await verifyTrackedProcessesAbsent([77],options)).reusedPids,[77]);
 await assert.rejects(verifyTrackedProcessesAbsent([77],{...options,rootPids:[]}),/unverified/);
 await assert.rejects(verifyTrackedProcessesAbsent([77],{...options,snapshot:async()=>inventory(rows.slice(0,2))}),(e:any)=>e.processCheck.checks[0].decision==='unknown'&&e.processCheck.checks[0].reason.includes('Parent PID 4'));
 await assert.rejects(verifyTrackedProcessesAbsent([77],{...options,snapshot:async()=>inventory([row(77,undefined,42),row(42,start)])}),(e:any)=>e.processCheck.checks[0].decision==='alive');
 await assert.rejects(verifyTrackedProcessesAbsent([77],{...options,snapshot:async()=>inventory([row(77,undefined,50),row(50,end,0)])}),/unverified/);
});
test('117 legacy PIDs use exactly one Windows CIM inventory invocation and no per-PID process launch',async()=>{
 let calls=0;const pids=Array.from({length:117},(_,i)=>1000+i);
 const proof=await verifyTrackedProcessesAbsent(pids,{startedAt:start,finishedAt:end,snapshot:()=>readProcessInventory({platform:'win32',execute:async(file,args)=>{calls++;assert.match(file,/powershell.exe/);assert.match(args.at(-1)!,/Get-CimInstance Win32_Process/);return JSON.stringify(pids.map(pid=>({ProcessId:pid,ParentProcessId:0,Name:'chrome.exe',CreatedAt:'2026-10-13T12:00:00.000Z',CreationKey:'638959536000000000'})));}})});
 assert.equal(calls,1);assert.equal(proof.snapshotCount,1);assert.equal(proof.reusedPids?.length,117);assert.equal(proof.checks?.length,117);
});
test('absent, incomplete and failed inventories preserve per-PID diagnostics',async()=>{
 assert.deepEqual((await verifyTrackedProcessesAbsent([77],{snapshot:async()=>inventory([])})).absentPids,[77]);
 for(const snapshot of [async()=>inventory([],false),async()=>{throw Error('denied');}])await assert.rejects(verifyTrackedProcessesAbsent([77],{snapshot}),(e:any)=>e.processCheck.checks[0].decision==='unknown'&&e.processCheck.processExitScan==='blocked');
 await assert.rejects(verifyTrackedProcessesAbsent([77],{trackedProcesses:[row(77,start)],snapshot:async()=>{throw Error('denied');}}),(e:any)=>e.processCheck.checks[0].recordedCreatedAt===start&&e.message.includes('processCheck.checks'));
});
test('Linux inventory persists boot/start-tick key and UTC creation without ps date parsing',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pid-inventory-'));
 try{
  await fs.mkdir(path.join(root,'sys/kernel/random'),{recursive:true});await fs.mkdir(path.join(root,'77'));await fs.writeFile(path.join(root,'sys/kernel/random/boot_id'),'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');await fs.writeFile(path.join(root,'stat'),'btime 1760000000\n');
  await fs.writeFile(path.join(root,'77/stat'),'77 (node (worker)) S '+['1',...Array(17).fill('0'),'12345','0'].join(' '));
  const result=await readProcessInventory({platform:'linux',procRoot:root,clockTicks:100});assert.equal(result.processes[0].createdAt,new Date((1760000000+123.45)*1000).toISOString());assert.equal(result.processes[0].creationKey,'linux:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:12345');assert.equal(result.processes[0].imageName,'node (worker)');
  let calls=0;const options={platform:'linux' as const,procRoot:root,execute:async()=>{calls++;return '100\n';}};await readProcessInventory(options);await readProcessInventory(options);assert.equal(calls,1);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('tracker preserves observed child and root creation identities after they exit',async()=>{
 let calls=0;const source=[{...row(100,start),parentPid:1,created:start},{...row(101,end,100),parentPid:100,created:end}];
 const tracker=trackProcessTree(100,()=>true,{snapshot:async()=>++calls===1?source:[]});await new Promise(resolve=>setTimeout(resolve,0));
 const result=await tracker.cleanup();assert.equal(result.rootPid,100);assert.equal(result.rootProcess?.createdAt,start);assert.equal(result.trackedProcesses?.[0].createdAt,end);assert.equal(result.trackedProcesses?.[0].imageName,'node.exe');assert.ok(result.observedAt);
 const combined=classifyProcessCleanup({results:[{processCleanup:result}]});assert.equal(combined.rootProcesses[0].pid,100);assert.equal(combined.trackedProcesses[0].pid,101);
});
test('tracker never calls a missing current creation identity verified or kills its PID',async()=>{
 let calls=0;const tracker=trackProcessTree(100,()=>true,{snapshot:async()=>++calls===1?[{pid:100,parentPid:1,created:start},{pid:101,parentPid:100,created:end}]:[{pid:101,parentPid:-1,created:''}]});await new Promise(resolve=>setTimeout(resolve,0));
 const result=await tracker.cleanup();assert.equal(result.verified,false);assert.deepEqual(result.remainingPids,[]);assert.deepEqual(result.unverifiedPids,[101]);
});
