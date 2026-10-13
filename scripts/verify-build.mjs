import fs from 'node:fs/promises';
import path from 'node:path';
import {releaseAssets,releaseVersion,sha256} from './release-lib.mjs';

const [output,sourceCommit,assetDirectory=output]=process.argv.slice(2);
if(!output||!/^[0-9a-f]{40}$/.test(sourceCommit||'')) throw new Error('Usage: node scripts/verify-build.mjs BUILD_OUTPUT HEAD_COMMIT');
const provenance=JSON.parse(await fs.readFile(path.join(output,'build-provenance.json'),'utf8'));
if(provenance.schemaVersion!==1||provenance.version!==releaseVersion||provenance.sourceCommit!==sourceCommit||provenance.testsPassed!==true) throw new Error('Build provenance does not match committed tested source');
if(provenance.linuxValidation?.sourceCommit!==sourceCommit||provenance.linuxValidation?.sourceCommitAtFinish!==sourceCommit||provenance.linuxValidation?.platform!=='linux'||provenance.linuxValidation?.suite!=='all'||provenance.linuxValidation?.passed!==true||provenance.linuxValidation?.sourceDirty!==false)throw Error('Native Linux validation is missing for this source');
const assets=releaseAssets;
if(Object.keys(provenance.assets||{}).length!==assets.length) throw new Error('Build provenance asset set is incomplete');
for(const asset of assets) if(provenance.assets[asset]!==await sha256(path.join(assetDirectory,asset))) throw new Error(`Asset differs from tested build: ${asset}`);
console.log(`Built assets match tested source commit ${sourceCommit}`);
