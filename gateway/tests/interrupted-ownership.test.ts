import test from 'node:test';
import assert from 'node:assert/strict';
import {assertInterruptedOwnershipAbsent,verifyInterruptedOwnership,type ProcessSnapshotEntry} from '../src/interrupted-ownership.js';

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
