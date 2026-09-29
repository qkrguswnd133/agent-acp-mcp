import test from 'node:test';
import assert from 'node:assert/strict';
import {accountStatus} from '../src/account.js';
test('account metadata retains public labels only and suppresses unauthenticated identity',()=>{
 const raw={email:'person@example.test\n',displayName:'Tester',organization:'Org',token:'do-not-expose',apiKey:'secret',id:'private-id',nested:{secret:'hidden'}};
 const result=accountStatus(true,raw,'fixture',0);
 assert.deepEqual(result,{status:'authenticated',source:'fixture',observedAt:'1970-01-01T00:00:00.000Z',email:'person@example.test',displayName:'Tester',organization:'Org'});
 for(const state of [false,'unknown'] as const){const value=accountStatus(state,raw,'fixture');assert.equal(value.email,undefined);assert.equal(value.organization,undefined);}
 assert.equal(accountStatus(true,{email:{token:'bad'},organization:'x'.repeat(1000)},'fixture').email,undefined);
 assert.equal(accountStatus(true,{organization:'x'.repeat(1000)},'fixture').organization?.length,256);
});
