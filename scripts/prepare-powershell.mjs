import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createWriteStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const spec=JSON.parse(await fs.readFile(path.join(repo,'scripts/powershell-runtime.json'),'utf8'));
const require=createRequire(path.join(repo,'monitor/package.json')),yauzl=require('yauzl');
const cache=path.join(repo,'build/dependencies'),zipFile=path.join(cache,`powershell-${spec.version}.zip`);
await fs.mkdir(cache,{recursive:true});
const digest=async file=>crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
if(await digest(zipFile).catch(()=>null)!==spec.sha256){
 const response=await fetch(spec.url,{signal:AbortSignal.timeout(180000)});if(!response.ok)throw Error('PowerShell download failed: '+response.status);
 const temp=zipFile+'.download';await pipeline(response.body,createWriteStream(temp));
 if(await digest(temp)!==spec.sha256){await fs.unlink(temp);throw Error('PowerShell upstream SHA256 mismatch');}
 await fs.rename(temp,zipFile);
}
const runtime=path.join(repo,'gateway/runtime'),target=path.join(runtime,'powershell7');
for(const directory of [path.join(repo,'gateway'),runtime,target]){try{if((await fs.lstat(directory)).isSymbolicLink()||await fs.realpath(directory)!==directory)throw Error('Unsafe runtime path');}catch(error){if(error.code!=='ENOENT')throw error;}}
// Only this exact generated dependency directory is replaced; no system installation.
if(!target.startsWith(path.join(repo,'gateway')+path.sep))throw Error('Unsafe runtime destination');
await fs.rm(target,{recursive:true,force:true});await fs.mkdir(target,{recursive:true});
await new Promise((resolve,reject)=>yauzl.open(zipFile,{lazyEntries:true},(error,zip)=>{
 if(error)return reject(error);zip.on('error',reject);zip.on('end',resolve);
 zip.on('entry',entry=>{void (async()=>{
  const parts=entry.fileName.replaceAll('\\','/').split('/');
  if(parts.some(p=>p==='..'||p==='.'||p.includes(':'))||entry.fileName.startsWith('/')||((entry.externalFileAttributes>>>16)&0xf000)===0xa000)throw Error('Unsafe upstream ZIP entry');
  const file=path.resolve(target,...parts);if(file!==target&&!file.startsWith(target+path.sep))throw Error('ZIP path escape');
  if(entry.fileName.endsWith('/'))await fs.mkdir(file,{recursive:true});
  else{await fs.mkdir(path.dirname(file),{recursive:true});await new Promise((r,j)=>zip.openReadStream(entry,(e,stream)=>e?j(e):pipeline(stream,createWriteStream(file,{flags:'wx'})).then(r,j)));}
  zip.readEntry();
 })().catch(error=>{zip.close();reject(error);});});zip.readEntry();
}));
await fs.access(path.join(target,'pwsh.exe'));await fs.access(path.join(target,'LICENSE.txt'));
await fs.writeFile(path.join(target,'gateway-runtime.json'),JSON.stringify(spec,null,2));
console.log(`Verified portable PowerShell ${spec.version} (${spec.sha256})`);
