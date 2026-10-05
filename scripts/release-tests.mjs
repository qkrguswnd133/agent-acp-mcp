import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const result=spawnSync(process.execPath,['--test','tests/release-manifest.test.mjs','tests/release-publisher.test.mjs','tests/job-tools.test.mjs'],{cwd:repo,stdio:'inherit'});
if(result.error) throw result.error;
if(result.status!==0) process.exit(result.status ?? 1);
