import test from 'node:test';
import assert from 'node:assert/strict';
import {processHome} from '../src/process.js';
test('Linux and WSL use Linux HOME even when Windows USERPROFILE is inherited',()=>{
 assert.equal(processHome('linux',{HOME:'/home/USERNAME',USERPROFILE:'C:\\Users\\USERNAME'}),'/home/USERNAME');
 assert.equal(processHome('win32',{HOME:'/home/USERNAME',USERPROFILE:'C:\\Users\\USERNAME'}),'C:\\Users\\USERNAME');
});
