import test from 'node:test';
import assert from 'node:assert/strict';
import {permissionResponse} from '../src/permission-response.js';
const options=[{kind:'allow_once',optionId:'yes'},{kind:'reject_once',optionId:'no'}];
test('policy denial selects the agent offered reject_once, while cancellation stays separate',()=>{
 assert.deepEqual(permissionResponse(options,false),{outcome:{outcome:'selected',optionId:'no'}});
 assert.deepEqual(permissionResponse(options,true),{outcome:{outcome:'selected',optionId:'yes'}});
 assert.deepEqual(permissionResponse(options,false,true),{outcome:{outcome:'cancelled'}});
 assert.deepEqual(permissionResponse(options,true,true),{outcome:{outcome:'cancelled'}});
});
test('missing one-time option fails closed without inventing cancellation or persistent permission',()=>{
 assert.throws(()=>permissionResponse([{kind:'reject_always',optionId:'forever'}],false),/did not offer reject_once/);
 assert.throws(()=>permissionResponse([{kind:'allow_always',optionId:'forever'}],true),/did not offer allow_once/);
});
