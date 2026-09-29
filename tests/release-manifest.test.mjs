import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {assertRelativePath,createPayloadManifest,createUpdateManifest,scanFirstParty,verifyPayloadManifest,verifyUpdateManifest} from '../scripts/release-lib.mjs';

async function fixture(body) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'agent-release-test-'));
  try { await body(directory); }
  finally { await fs.rm(directory,{recursive:true,force:true}); }
}

test('payload manifest covers every file and rejects tampering and unlisted files',async()=>fixture(async directory=>{
  await fs.mkdir(path.join(directory,'gateway','dist'),{recursive:true});
  await fs.writeFile(path.join(directory,'gateway','dist','index.js'),'test');
  await createPayloadManifest(directory,'2.2.0','1.1.0');
  const manifest=await verifyPayloadManifest(directory);
  assert.equal(manifest.files.length,1);
  await fs.writeFile(path.join(directory,'unlisted.txt'),'new');
  await assert.rejects(verifyPayloadManifest(directory),/every regular file/);
  await fs.rm(path.join(directory,'unlisted.txt'));
  await fs.writeFile(path.join(directory,'gateway','dist','index.js'),'tampered');
  await assert.rejects(verifyPayloadManifest(directory),/mismatch/);
}));

test('traversal paths cannot enter a package',()=>{
  for(const value of ['../secret','gateway/../secret','/root','gateway\\file','C:/secret','gateway//file']) assert.throws(()=>assertRelativePath(value),/Unsafe/);
});

test('update manifest fields and exact-byte Ed25519 signature',async()=>fixture(async directory=>{
  const {privateKey,publicKey}=crypto.generateKeyPairSync('ed25519');
  const publicPath=path.join(directory,'public.pem');
  await fs.writeFile(publicPath,publicKey.export({format:'pem',type:'spki'}));
  const manifest=createUpdateManifest({publishedAt:'2026-09-29T00:00:00.000Z',gatewayVersion:'2.2.0',monitorVersion:'1.1.0',assetSize:42,assetSha256:'a'.repeat(64)});
  assert.equal(manifest.repository,'qkrguswnd133/agent-acp-mcp');
  assert.equal(manifest.asset.name,'Agent-ACP-MCP-Windows-2.2.0.zip');
  assert(manifest.notes.gateway.length>0&&manifest.notes.monitor.length>0);
  const bytes=Buffer.from(JSON.stringify(manifest)+'\n');
  const signature=crypto.sign(null,bytes,privateKey).toString('base64');
  assert(await verifyUpdateManifest(bytes,signature,publicPath));
  assert.equal(await verifyUpdateManifest(Buffer.from(bytes.toString().trim()),signature,publicPath),false);
}));

test('privacy scan reports filenames without exposing matched credential text',async()=>fixture(async directory=>{
  await fs.writeFile(path.join(directory,'safe.md'),'C:/Users/YOUR_NAME/example');
  await scanFirstParty([directory]);
  const token='ghp_'+'x'.repeat(30);
  await fs.writeFile(path.join(directory,'unsafe.md'),token);
  await assert.rejects(scanFirstParty([directory]),error=>error.message.includes('unsafe.md: credential token')&&!error.message.includes(token));
  await fs.rm(path.join(directory,'unsafe.md'));
  await fs.writeFile(path.join(directory,'company.md'),'https://intranet.example.internal/project');
  await assert.rejects(scanFirstParty([directory]),/company.md: private network domain/);
}));
