import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {updateAction}=createRequire(import.meta.url)('../update/action.cjs');
const state=(current,latest,extra={})=>({installed:{version:current},selected:{version:latest},phase:'idle',...extra});
test('bar update availability uses semantic ordering and hides absent or older releases',()=>{
  assert.equal(updateAction(state('2.2.1','2.2.1')).available,false);
  assert.equal(updateAction(state('2.2.1','2.2.0')).available,false);
  assert.equal(updateAction(state('2.2.9','2.2.10')).canStart,true);
  assert.equal(updateAction(state(null,'2.2.2')).canStart,true);
  assert.equal(updateAction(state('2.2.1',null)).available,false);
  assert.equal(updateAction(state('2.2.1','invalid')).available,false);
});
test('new release remains discoverable but cannot start during work or recovery block',()=>{
  for(const extra of [{phase:'downloading'},{phase:'preparing'},{phase:'installing'},{pending:{operationId:'test'}},{blocked:'new updater required'},{result:{status:'rollback_failed'}}]){
    const action=updateAction(state('2.2.1','2.2.2',extra));assert.equal(action.available,true);assert.equal(action.canStart,false);
  }
});
