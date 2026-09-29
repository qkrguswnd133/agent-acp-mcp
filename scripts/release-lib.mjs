import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const packageFile=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','package.json');
export const releaseVersion = JSON.parse(readFileSync(packageFile,'utf8')).version;
if(!/^\d+\.\d+\.\d+$/.test(releaseVersion)) throw new Error(`Invalid root release version: ${releaseVersion}`);
const notesFile=path.resolve(path.dirname(packageFile),'release-notes',`${releaseVersion}.json`);
export const releaseNotes=JSON.parse(readFileSync(notesFile,'utf8'));
for(const component of ['gateway','monitor']) {
  if(!Array.isArray(releaseNotes[component])||!releaseNotes[component].length||!releaseNotes[component].every(note=>typeof note==='string'&&note.trim()===note&&note.length>0&&note.length<=1000)) throw new Error(`Invalid ${component} release notes: ${notesFile}`);
}
export const releaseTag = `v${releaseVersion}`;
export const repository = 'qkrguswnd133/agent-acp-mcp';
export const archiveName = `Agent-ACP-MCP-Windows-${releaseVersion}.zip`;
export const forbiddenNames = /(^|[\\/])(?:\.env(?:\..*)?|\.git|state|work|configuration|logs?|sessions?|credentials?|auth|cache|\.codex|\.claude|\.grok)([\\/]|$)/i;
const sensitivePatterns = [
  {name:'personal Windows path', regex:/[A-Za-z]:[\\/]Users[\\/](?!YOUR_NAME\b|USERNAME\b|<[^>]+>)[^\\/\s"']+/i},
  {name:'personal Unix path', regex:/(?:\/Users\/|\/home\/)(?!YOUR_NAME\b|USERNAME\b|<[^>]+>)[^/\s"']+/i},
  {name:'credential token', regex:/\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/},
  {name:'other credential token', regex:/\b(?:AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{20,})\b/},
  {name:'private key', regex:/-----BEGIN (?:OPENSSH |RSA |EC |ENCRYPTED )?PRIVATE KEY-----/},
  {name:'private network domain', regex:/(?:https?:\/\/|@)[A-Za-z0-9.-]+\.(?:internal|corp|lan|local)\b/i},
];

export function assertRelativePath(relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes(':') || relative.includes('\0') || path.posix.isAbsolute(relative)) throw new Error(`Unsafe package path: ${relative}`);
  const parts=relative.split('/');
  if(parts.some(part=>!part || part==='.' || part==='..')) throw new Error(`Unsafe package path: ${relative}`);
  return relative;
}

export async function regularFiles(root) {
  const results=[];
  async function visit(directory, relative='') {
    for (const dirent of await fs.readdir(directory,{withFileTypes:true})) {
      const rel=relative ? `${relative}/${dirent.name}` : dirent.name;
      assertRelativePath(rel);
      const full=path.join(directory,dirent.name);
      const stat=await fs.lstat(full);
      if(stat.isSymbolicLink()) throw new Error(`Links are not allowed in release input: ${rel}`);
      if(stat.isDirectory()) await visit(full,rel);
      else if(stat.isFile()) results.push(rel);
      else throw new Error(`Unsupported release entry: ${rel}`);
    }
  }
  await visit(root);
  return results.sort((a,b)=>a.localeCompare(b,'en'));
}

export async function copyTree(source,destination,{rejectNames=true}={}) {
  for(const rel of await regularFiles(source)) {
    if(rejectNames && forbiddenNames.test(rel)) throw new Error(`Excluded file in release input: ${rel}`);
    const target=path.join(destination,...rel.split('/'));
    await fs.mkdir(path.dirname(target),{recursive:true});
    await fs.copyFile(path.join(source,...rel.split('/')),target);
  }
}

export async function sha256(file) {
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

export async function createPayloadManifest(root,gatewayVersion,monitorVersion) {
  const files=[];
  for(const rel of await regularFiles(root)) {
    if(rel==='manifest.json') continue;
    if(forbiddenNames.test(rel)) throw new Error(`Forbidden package file: ${rel}`);
    const full=path.join(root,...rel.split('/'));
    const stat=await fs.stat(full);
    files.push({path:rel,sha256:await sha256(full),size:stat.size});
  }
  const manifest={platform:'win32-x64',gatewayVersion,monitorVersion,files};
  await fs.writeFile(path.join(root,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  return manifest;
}

export async function verifyPayloadManifest(root) {
  const manifest=JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8'));
  if(manifest.platform!=='win32-x64'||!Array.isArray(manifest.files)) throw new Error('Invalid package manifest');
  const actual=(await regularFiles(root)).filter(rel=>rel!=='manifest.json');
  const listed=[];
  for(const entry of manifest.files) {
    const rel=assertRelativePath(entry.path);
    if(forbiddenNames.test(rel)) throw new Error(`Forbidden package file: ${rel}`);
    if(!/^[0-9a-f]{64}$/.test(entry.sha256)||!Number.isSafeInteger(entry.size)||entry.size<0) throw new Error(`Invalid package hash or size: ${rel}`);
    const full=path.join(root,...rel.split('/'));
    const stat=await fs.stat(full);
    if(!stat.isFile()||stat.size!==entry.size||await sha256(full)!==entry.sha256) throw new Error(`Package file mismatch: ${rel}`);
    listed.push(rel);
  }
  listed.sort((a,b)=>a.localeCompare(b,'en'));
  if(JSON.stringify(actual)!==JSON.stringify(listed)) throw new Error('Package manifest must list every regular file exactly once');
  return manifest;
}

export async function scanFirstParty(roots) {
  const findings=[];
  for(const root of roots) {
    const stat=await fs.lstat(root);
    if(stat.isSymbolicLink()) throw new Error(`Link in first-party source: ${root}`);
    const files=stat.isFile()?[path.basename(root)]:await regularFiles(root);
    for(const rel of files) {
      if(forbiddenNames.test(rel)) { findings.push(`${rel}: excluded filename`); continue; }
      if(!/\.(?:js|mjs|cjs|ts|json|md|ps1|toml|css|html|txt)$/i.test(rel)) continue;
      const content=await fs.readFile(stat.isFile()?root:path.join(root,...rel.split('/')),'utf8');
      for(const pattern of sensitivePatterns) if(pattern.regex.test(content)) findings.push(`${rel}: ${pattern.name}`);
    }
  }
  if(findings.length) throw new Error(`Privacy scan failed:\n${findings.join('\n')}`);
}

export function createUpdateManifest({publishedAt,gatewayVersion,monitorVersion,assetSize,assetSha256}) {
  if(!Number.isSafeInteger(assetSize)||assetSize<=0||!/^[0-9a-f]{64}$/.test(assetSha256)) throw new Error('Invalid archive size/hash');
  const iso=new Date(publishedAt).toISOString();
  if(iso!==publishedAt) throw new Error('publishedAt must be canonical UTC ISO 8601');
  return {
    schemaVersion:1,
    repository,
    version:releaseVersion,
    tag:releaseTag,
    publishedAt:iso,
    components:{gateway:gatewayVersion,monitor:monitorVersion},
    notes:{gateway:[...releaseNotes.gateway],monitor:[...releaseNotes.monitor]},
    asset:{name:archiveName,size:assetSize,sha256:assetSha256},
    minimumUpdaterVersion:'1.0.0',
  };
}

export async function signUpdateManifest(bytes,privateKeyPath) {
  const key=crypto.createPrivateKey(await fs.readFile(privateKeyPath));
  if(key.asymmetricKeyType!=='ed25519') throw new Error('Signing key must be Ed25519');
  return crypto.sign(null,bytes,key).toString('base64');
}

export async function verifyUpdateManifest(bytes,signature,publicKeyPath) {
  const key=crypto.createPublicKey(await fs.readFile(publicKeyPath));
  if(key.asymmetricKeyType!=='ed25519') throw new Error('Trusted key must be Ed25519');
  return crypto.verify(null,bytes,key,Buffer.from(signature.trim(),'base64'));
}
