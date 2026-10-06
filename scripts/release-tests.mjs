import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import sandbox from '../gateway/scripts/test-sandbox.cjs';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const owned=sandbox.createTestSandbox();let status=1;
try{
 const env=sandbox.testEnvironment(owned);delete env.NODE_TEST_CONTEXT;
 const result=spawnSync(process.execPath,['--import',pathToFileURL(path.join(repo,'gateway/scripts/test-sandbox-preload.mjs')).href,'--test','tests/release-manifest.test.mjs','tests/release-publisher.test.mjs','tests/job-tools.test.mjs'],{cwd:repo,env,stdio:'inherit',windowsHide:true});
 if(result.error)throw result.error;status=result.status??1;
}catch(error){console.error(error.message);}
finally{try{sandbox.cleanupTestSandbox(owned);}catch(error){console.error(`Test sandbox retained at ${owned.root}: ${error.message}`);status=1;}}
process.exitCode=status;
