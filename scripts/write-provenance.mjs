import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {releaseAssets,releaseVersion,sha256} from './release-lib.mjs';

const testsPassed=process.argv[2]==='true';
const expectedCommit=process.argv[3];
if(!/^[0-9a-f]{40}$/.test(expectedCommit||'')) throw new Error('Build provenance requires the source commit captured before build');
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(repo,'build','release',`v${releaseVersion}`);
const assets=releaseAssets;
const hashes={};
for(const asset of assets) hashes[asset]=await sha256(path.join(output,asset));
const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
const changes=execFileSync('git',['status','--porcelain=v1','--untracked-files=all'],{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','ignore']});
if(sourceCommit!==expectedCommit||changes.trim()) throw new Error('Source commit or working tree changed during release build');
let linuxValidation;
if(testsPassed){linuxValidation=JSON.parse(await fs.readFile(path.join(repo,'build','linux-validation.json'),'utf8'));if(linuxValidation.sourceCommit!==sourceCommit||linuxValidation.sourceCommitAtFinish!==sourceCommit||linuxValidation.platform!=='linux'||linuxValidation.suite!=='all'||linuxValidation.passed!==true||linuxValidation.sourceDirty!==false)throw Error('Run native Linux validation for this clean committed source before publishing');}
const provenance={schemaVersion:1,version:releaseVersion,sourceCommit,testsPassed,linuxValidation,assets:hashes};
await fs.writeFile(path.join(output,'build-provenance.json'),JSON.stringify(provenance,null,2)+'\n');
console.log(`Build provenance written (testsPassed=${testsPassed}, sourceCommit=${sourceCommit})`);
