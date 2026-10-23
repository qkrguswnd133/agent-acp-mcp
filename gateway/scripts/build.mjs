import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root=await fs.realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'));
const output=path.join(root,'dist'),stat=await fs.lstat(output).catch(error=>{if(error.code!=='ENOENT')throw error;});
if(stat?.isSymbolicLink())throw Error('Refusing to clean a linked Gateway build output');
// A clean build also removes compiled modules whose source was retired.
if(stat)await fs.rm(output,{recursive:true});
const result=spawnSync(process.execPath,[path.join(root,'node_modules/typescript/bin/tsc'),'-p','tsconfig.json'],{cwd:root,stdio:'inherit',windowsHide:true});
if(result.error)throw result.error;
process.exitCode=result.status??1;
