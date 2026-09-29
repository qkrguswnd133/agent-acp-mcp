import fs from 'node:fs/promises';
import path from 'node:path';
import {archiveName,releaseVersion,sha256} from './release-lib.mjs';

const [output,sourceCommit,assetDirectory=output]=process.argv.slice(2);
if(!output||!/^[0-9a-f]{40}$/.test(sourceCommit||'')) throw new Error('Usage: node scripts/verify-build.mjs BUILD_OUTPUT HEAD_COMMIT');
const provenance=JSON.parse(await fs.readFile(path.join(output,'build-provenance.json'),'utf8'));
if(provenance.schemaVersion!==1||provenance.version!==releaseVersion||provenance.sourceCommit!==sourceCommit||provenance.testsPassed!==true) throw new Error('Build provenance does not match committed tested source');
const assets=[archiveName,'update-manifest.json','update-manifest.sig',`${archiveName}.sha256`];
if(Object.keys(provenance.assets||{}).length!==assets.length) throw new Error('Build provenance asset set is incomplete');
for(const asset of assets) if(provenance.assets[asset]!==await sha256(path.join(assetDirectory,asset))) throw new Error(`Asset differs from tested build: ${asset}`);
console.log(`Built assets match tested source commit ${sourceCommit}`);
