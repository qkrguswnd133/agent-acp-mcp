import test from 'node:test';
import assert from 'node:assert/strict';
import {codexSandboxArgs} from '../src/providers/codex.js';

test('Windows implementation enables scoped writes without bypassing sandbox or approvals',()=>{
 assert.deepEqual(codexSandboxArgs(true,'win32',{}),['--sandbox','workspace-write','-c','windows.sandbox="unelevated"']);
 assert.deepEqual(codexSandboxArgs(false,'win32',{}),['--sandbox','read-only','-c','windows.sandbox="unelevated"']);
});
test('Windows elevated sandbox is an explicit supported configuration',()=>{
 assert.deepEqual(codexSandboxArgs(true,'win32',{CODEX_WINDOWS_SANDBOX:'elevated'}),['--sandbox','workspace-write','-c','windows.sandbox="elevated"']);
 for(const value of ['','disabled','danger-full-access','unelevated"'])assert.throws(()=>codexSandboxArgs(true,'win32',{CODEX_WINDOWS_SANDBOX:value}),/CODEX_WINDOWS_SANDBOX/);
});
test('POSIX providers retain their existing sandbox arguments',()=>{
 for(const platform of ['linux','darwin'] as const){
  assert.deepEqual(codexSandboxArgs(true,platform,{}),['--sandbox','workspace-write']);
  assert.deepEqual(codexSandboxArgs(false,platform,{}),['--sandbox','read-only']);
 }
});
test('Explicit full access affects implementation only and does not bypass approvals',()=>{
 const env={CODEX_IMPLEMENT_SANDBOX:'danger-full-access'};
 for(const platform of ['win32','linux'] as const){
  assert.deepEqual(codexSandboxArgs(true,platform,env),['--sandbox','danger-full-access']);
  assert.equal(codexSandboxArgs(false,platform,env)[1],'read-only');
 }
 assert.throws(()=>codexSandboxArgs(true,'win32',{CODEX_IMPLEMENT_SANDBOX:'invalid'}),/CODEX_IMPLEMENT_SANDBOX/);
});
