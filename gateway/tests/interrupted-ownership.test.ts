import test from 'node:test';
import assert from 'node:assert/strict';
import {assertInterruptedOwnershipAbsent,verifyInterruptedOwnership,processOwnershipSnapshot,type ProcessSnapshotEntry} from '../src/interrupted-ownership.js';

const input={ownerPid:42,workspacePaths:['C:\\worktrees\\one\\repo','C:\\dev\\repo']};
const processEntry=(pid:number,parentPid=1,commandLine:string|null='unrelated.exe',name='unrelated.exe'):ProcessSnapshotEntry=>({pid,parentPid,commandLine,name});
const self=[processEntry(100,50,'node gateway.js','node.exe'),processEntry(50,1,'codex --cwd C:\\dev\\repo','codex.exe'),processEntry(1,0,null,'System')];
const check=(entries:ProcessSnapshotEntry[])=>assertInterruptedOwnershipAbsent(input,[...self,...entries],'win32',100);

test('interrupted ownership permits absent owner with no observed children or workspace use',()=>{
 assert.doesNotThrow(()=>check([]));assert.doesNotThrow(()=>check([processEntry(77,1,'node --cwd C:\\dev\\repo-other','node.exe')]));
});
test('interrupted ownership blocks live owners and surviving descendants',()=>{
 assert.throws(()=>check([processEntry(42)]),/owner process is still alive/);
 assert.throws(()=>check([processEntry(77,42)]),/surviving child/);
 assert.throws(()=>check([processEntry(78,77),processEntry(77,42)]),/surviving child/);
});
test('interrupted ownership blocks workspace references outside the original process tree',()=>{
 for(const text of ['node --cwd "C:\\WORKTREES\\one\\repo"','git -C C:/dev/repo status','python C:\\dev\\repo\\script.py'])assert.throws(()=>check([processEntry(77,1,text,'node.exe')]),/references the interrupted workspace/);
 assert.throws(()=>check([{...processEntry(77),cwd:'C:\\dev\\repo\\nested'}]),/references the interrupted workspace/);
});
test('interrupted ownership fails closed on missing, malformed and unreadable process evidence',()=>{
 assert.throws(()=>assertInterruptedOwnershipAbsent(input,[],'win32',100),/unknown/);
 assert.throws(()=>check([{...processEntry(77),parentPid:NaN}]),/unknown/);
 assert.throws(()=>check([processEntry(77,1,null,'grok.exe')]),/unreadable/);
 assert.throws(()=>check([processEntry(77,1,'','powershell.exe')]),/unreadable/);
 assert.throws(()=>assertInterruptedOwnershipAbsent({...input,ownerPid:0},self,'win32',100),/unknown/);
});
test('real ownership check never accepts a currently alive owner PID',async()=>{
 await assert.rejects(()=>verifyInterruptedOwnership({ownerPid:process.pid,workspacePaths:input.workspacePaths}),/owner process is still alive/);
});
test('reviewed terminal jobs allow a live gateway but reject remaining workspace writers and unknown ownership',()=>{
 const finished=(entries:ProcessSnapshotEntry[])=>assertInterruptedOwnershipAbsent(input,[...self,processEntry(42,1,'node gateway.js','node.exe'),...entries],'win32',100,true);
 assert.doesNotThrow(()=>finished([processEntry(77,42,'codex -C C:\\other-repo','codex.exe')]));
 assert.throws(()=>finished([processEntry(77,42,'codex -C C:\\worktrees\\one\\repo','codex.exe')]),/references/);
 assert.throws(()=>finished([processEntry(77,42,null,'codex.exe')]),/unreadable/);
});
test('target-only scan ignores original repository preview servers but still blocks isolated workspace use',()=>{
 const target={...input,workspacePaths:[input.workspacePaths[0]]};
 const inspect=(row:ProcessSnapshotEntry)=>assertInterruptedOwnershipAbsent(target,[...self,row],'win32',100,true);
 assert.doesNotThrow(()=>inspect(processEntry(77,1,'node C:\\dev\\repo\\node_modules\\next dev','node.exe')));
 assert.doesNotThrow(()=>inspect(processEntry(77,1,'node C:\\other\\C:\\worktrees\\one\\repo','node.exe')));
 assert.throws(()=>inspect(processEntry(77,1,'node --cwd="C:\\worktrees\\one\\repo"','node.exe')),/references/);
 assert.throws(()=>inspect({...processEntry(77),cwd:input.workspacePaths[0]}),/references/);
});
test('unreadable pre-existing session-0 services need complete independent ancestry before becoming warnings',()=>{
 const earlier='2026-10-20T00:00:00Z',startedAt='2026-10-23T00:00:00Z';
 const rows=[{...processEntry(100,50,'node gateway.js','node.exe'),sessionId:1,createdAt:earlier},{...processEntry(50,1),sessionId:1,createdAt:earlier},{...processEntry(1,0,null,'System'),sessionId:0,createdAt:earlier}];
 const service={...processEntry(77,1,null,'node.exe'),sessionId:0,createdAt:'2026-10-21T00:00:00Z'};
 const inspect=(entry:ProcessSnapshotEntry,extra:Partial<typeof input>&{trackedPids?:number[]}={})=>assertInterruptedOwnershipAbsent({...input,startedAt,...extra},[...rows,entry],'win32',100,true);
 const result=inspect(service);assert.equal(result.processWarnings.length,1);assert.equal(result.processWarnings[0].pid,77);assert.match(result.processWarnings[0].reason,/independent/);
 for(const entry of [{...service,sessionId:1},{...service,createdAt:null},{...service,createdAt:'2026-10-23T01:00:00Z'},{...service,parentPid:999},{...service,parentPid:42}])assert.throws(()=>inspect(entry),/unreadable/);
 assert.throws(()=>inspect(service,{trackedPids:[77]}),/unreadable/);
 assert.throws(()=>inspect({...service,commandLine:'node C:\\worktrees\\one\\repo'}),/references/);
});
test('Windows ownership projection preserves generation, session and cwd evidence in one inventory call',async()=>{
 let scans=0;const createdAt='2026-10-20T00:00:00Z';
 const snapshot=await processOwnershipSnapshot({platform:'win32',snapshot:async()=>{scans++;return {complete:true,observedAt:createdAt,processes:[{pid:77,parentPid:1,imageName:'node.exe',commandLine:null,createdAt,creationKey:'windows:638965152000000000',observedAt:createdAt,sessionId:0,cwd:'C:\\other'}]};}});
 assert.equal(scans,1);assert.equal(snapshot[0].createdAt,createdAt);assert.equal(snapshot[0].creationKey,'windows:638965152000000000');assert.equal(snapshot[0].sessionId,0);assert.equal(snapshot[0].cwd,'C:\\other');
});
test('terminal owner exemption never hides a reused gateway PID now referencing the target',()=>{
 const old={...input,startedAt:'2026-10-20T00:00:00Z',workspacePaths:[input.workspacePaths[0]]};
 const reused={...processEntry(42,1,'node C:\\worktrees\\one\\repo','node.exe'),createdAt:'2026-10-21T00:00:00Z'};
 assert.throws(()=>assertInterruptedOwnershipAbsent(old,[...self,reused],'win32',100,true),/references/);
});
