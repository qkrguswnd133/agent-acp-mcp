import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const [privateFile,publicFile]=process.argv.slice(2);
if(!privateFile||!publicFile) throw new Error('Usage: node scripts/create-signing-key.mjs PRIVATE_KEY_PATH PUBLIC_KEY_PATH');
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const privatePath=path.resolve(privateFile);
const publicPath=path.resolve(publicFile);
if(privatePath.toLowerCase().startsWith(repo.toLowerCase()+path.sep)) throw new Error('Private key must be outside repository');
if(privatePath===publicPath) throw new Error('Private and public paths must differ');
for(const file of [privatePath,publicPath]) {
  try { await fs.access(file); throw new Error(`Refusing to overwrite existing key: ${file}`); }
  catch(error) { if(error.code!=='ENOENT') throw error; }
}
const {privateKey,publicKey}=crypto.generateKeyPairSync('ed25519');
const privatePem=privateKey.export({format:'pem',type:'pkcs8'});
const publicPem=publicKey.export({format:'pem',type:'spki'});
await fs.mkdir(path.dirname(privatePath),{recursive:true});
await fs.mkdir(path.dirname(publicPath),{recursive:true});
await fs.writeFile(privatePath,privatePem,{flag:'wx',mode:0o600});
await fs.writeFile(publicPath,publicPem,{flag:'wx'});
console.log(`Private signing key: ${privatePath}`);
console.log(`Public verification key: ${publicPath}`);
