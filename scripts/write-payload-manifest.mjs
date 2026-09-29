import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPayloadManifest,releaseVersion,verifyPayloadManifest} from './release-lib.mjs';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root=path.join(repo,'build','release',`v${releaseVersion}`,'payload');
const info=JSON.parse(await fs.readFile(path.join(root,'release-info.json'),'utf8'));
await createPayloadManifest(root,info.components.gateway,info.components.monitor);
const verified=await verifyPayloadManifest(root);
console.log(`Payload manifest verified: ${verified.files.length} files`);
