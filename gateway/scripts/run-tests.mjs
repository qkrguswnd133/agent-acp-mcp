import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import sandbox from './test-sandbox.cjs';
const root=new URL('../',import.meta.url),owned=sandbox.createTestSandbox();
let status=1;
try{
 const requested=process.argv.slice(2),smoke=requested[0]==='--smoke';
 const files=requested.length&&!smoke?requested:readdirSync(new URL('../dist/tests/',import.meta.url)).filter(name=>name.endsWith('.test.js')).map(name=>`dist/tests/${name}`);
 const args=smoke?['dist/tests/smoke.js']:['--test',...files];
 const env=sandbox.testEnvironment(owned);delete env.NODE_TEST_CONTEXT;
 const result=spawnSync(process.execPath,['--import',new URL('./test-sandbox-preload.mjs',import.meta.url).href,...args],{cwd:fileURLToPath(root),env,stdio:'inherit',windowsHide:true});
 if(result.error)throw result.error;status=result.status??1;
}catch(error){console.error(error.message);}
finally{try{sandbox.cleanupTestSandbox(owned);}catch(error){console.error(`Test sandbox retained at ${owned.root}: ${error.message}`);status=1;}}
process.exitCode=status;
