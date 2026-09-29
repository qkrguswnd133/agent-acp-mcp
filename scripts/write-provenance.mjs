import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {archiveName,releaseVersion,sha256} from './release-lib.mjs';

const testsPassed=process.argv[2]==='true';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(repo,'build','release',`v${releaseVersion}`);
const assets=[archiveName,'update-manifest.json','update-manifest.sig',`${archiveName}.sha256`];
const hashes={};
for(const asset of assets) hashes[asset]=await sha256(path.join(output,asset));
let sourceCommit=null;
try { sourceCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim(); }
catch {}
const provenance={schemaVersion:1,version:releaseVersion,sourceCommit,testsPassed,assets:hashes};
await fs.writeFile(path.join(output,'build-provenance.json'),JSON.stringify(provenance,null,2)+'\n');
console.log(`Build provenance written (testsPassed=${testsPassed}, sourceCommit=${sourceCommit||'uncommitted'})`);
