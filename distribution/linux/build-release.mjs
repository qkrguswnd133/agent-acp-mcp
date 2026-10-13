#!/usr/bin/env node
/** Standalone Linux packaging; also called by the Windows release publisher. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {compareVersions,ensureSafePath,parseArchive,verifyPackage,verifyManifest,REPOSITORY} from './updater.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const REPO=path.resolve(HERE,'../..');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export function createUstar(files){
  const chunks=[];const seen=new Set();
  for(const file of [...files].sort((a,b)=>a.path.localeCompare(b.path,'en'))){
    const name=file.path;if(seen.has(name))throw Error('Duplicate tar path');seen.add(name);
    let short=name,prefix='';
    if(Buffer.byteLength(name)>100){let cut=name.lastIndexOf('/');while(cut>0&&(Buffer.byteLength(name.slice(cut+1))>100||Buffer.byteLength(name.slice(0,cut))>155))cut=name.lastIndexOf('/',cut-1);if(cut<1)throw Error(`Path too long for ustar: ${name}`);prefix=name.slice(0,cut);short=name.slice(cut+1);}
    const header=Buffer.alloc(512);header.write(short,0,100);const oct=(value,at,length)=>{const v=value.toString(8);if(v.length>=length)throw Error('Tar numeric field overflow');header.write(v.padStart(length-1,'0')+'\0',at,length);};
    oct(file.executable?0o755:0o644,100,8);oct(0,108,8);oct(0,116,8);oct(file.bytes.length,124,12);oct(0,136,12);header.fill(32,148,156);header.write('0',156);header.write('ustar\0',257);header.write('00',263);header.write(prefix,345,155);const sum=header.reduce((a,b)=>a+b,0);header.write(sum.toString(8).padStart(6,'0')+'\0 ',148,8);chunks.push(header,file.bytes,Buffer.alloc((512-file.bytes.length%512)%512));
  }
  chunks.push(Buffer.alloc(1024));return zlib.gzipSync(Buffer.concat(chunks),{level:9});
}
async function filesUnder(root,relative=''){
  const result=[];
  for(const entry of await fs.readdir(path.join(root,relative),{withFileTypes:true})){
    const rel=relative?relative+'/'+entry.name:entry.name;
    // npm command shims are not needed by the Gateway runtime and are platform-specific links.
    if(entry.name==='.bin'&&entry.isDirectory())continue;
    const stat=await fs.lstat(path.join(root,rel));if(stat.isSymbolicLink())throw Error(`Package input contains a link: ${rel}`);
    if(stat.isDirectory())result.push(...await filesUnder(root,rel));else if(stat.isFile())result.push(rel);else throw Error(`Unsupported package input: ${rel}`);
  }
  return result.sort();
}
const run=(command,args,cwd)=>new Promise((resolve,reject)=>{const child=spawn(command,args,{cwd,stdio:'inherit',shell:false});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error(`${command} exited ${code}`)));});
export async function buildLinuxRelease({gatewayDir,out,signingKey,publishedAt=new Date().toISOString()}){
  const rootPackage=JSON.parse(await fs.readFile(path.join(REPO,'package.json'),'utf8'));const version=rootPackage.version;compareVersions(version,'0.0.0');
  const notes=JSON.parse(await fs.readFile(path.join(REPO,'release-notes',version+'.json'),'utf8'));
  if(!Array.isArray(notes.gateway)||!notes.gateway.length)throw Error('Gateway release notes are required');
  if(new Date(publishedAt).toISOString()!==publishedAt)throw Error('publishedAt must be a canonical UTC ISO timestamp');
  out=path.resolve(out||path.join(REPO,'build','release','v'+version));await ensureSafePath(out);await fs.mkdir(out,{recursive:true});
  signingKey=await fs.realpath(signingKey);const realRepo=await fs.realpath(REPO);if(signingKey===realRepo||signingKey.startsWith(realRepo+path.sep))throw Error('Signing key must remain outside the source repository');
  const key=crypto.createPrivateKey(await fs.readFile(signingKey));if(key.asymmetricKeyType!=='ed25519')throw Error('Ed25519 signing key is required');
  const trusted=await fs.readFile(path.join(HERE,'trusted-key.pem'),'utf8');
  if(!crypto.createPublicKey(key).export({type:'spki',format:'der'}).equals(crypto.createPublicKey(trusted).export({type:'spki',format:'der'})))throw Error('Signing key does not match the pinned Linux public key');
  let temporary=null;
  try{
    if(!gatewayDir){
      if(process.platform!=='linux')throw Error('On Windows provide --gateway-dir with an already validated release payload');
      if(compareVersions(process.versions.node,'22.12.0')<0)throw Error('Node.js 22.12+ is required');
      const gateway=path.join(REPO,'gateway');await run('npm',['ci','--no-audit','--no-fund'],gateway);await run('npm',['test'],gateway);
      temporary=await fs.mkdtemp(path.join(out,'.linux-build-'));gatewayDir=path.join(temporary,'gateway');await fs.mkdir(gatewayDir);
      for(const name of ['src','dist','profiles','package.json','package-lock.json'])await fs.cp(path.join(gateway,name),path.join(gatewayDir,name),{recursive:true});
      for(const name of (await fs.readdir(gateway)).filter(n=>n.endsWith('.md')))await fs.copyFile(path.join(gateway,name),path.join(gatewayDir,name));
      await run('npm',['ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],gatewayDir);
    }
    gatewayDir=path.resolve(gatewayDir);await ensureSafePath(gatewayDir);
    const gatewayPackage=JSON.parse(await fs.readFile(path.join(gatewayDir,'package.json'),'utf8'));compareVersions(gatewayPackage.version,'0.0.0');
    const files=[];
    const add=async(source,relative,executable=false)=>{let bytes=await fs.readFile(source);if(relative==='linux/install.sh'||relative==='linux/agent-acp')bytes=Buffer.from(bytes.toString('utf8').replace(/\r\n/g,'\n'));files.push({path:relative,bytes,executable});};
    for(const name of ['dist/src','src','profiles','node_modules']){
      const folder=path.join(gatewayDir,name);for(const relative of await filesUnder(folder)){
        if(/\.(?:exe|dll|node|so|dylib)$/i.test(relative))throw Error(`Native dependency needs a separate architecture package: ${name}/${relative}`);
        await add(path.join(folder,relative),'gateway/'+name+'/'+relative);
      }
    }
    for(const name of ['package.json','package-lock.json',...(await fs.readdir(gatewayDir)).filter(n=>n.endsWith('.md'))])await add(path.join(gatewayDir,name),'gateway/'+name);
    for(const name of ['updater.mjs','agent-acp','install.sh','trusted-key.pem','README.md'])await add(path.join(HERE,name),'linux/'+name,['agent-acp','install.sh'].includes(name));
    for(const [source,destination] of [[path.join(HERE,'examples'),'linux/examples'],[path.join(REPO,'distribution/instructions'),'linux/instructions']]){
      for(const relative of await filesUnder(source))await add(path.join(source,relative),destination+'/'+relative);
    }
    const inner={schemaVersion:1,platform:'linux',version,components:{gateway:gatewayPackage.version},files:files.map(f=>({path:f.path,size:f.bytes.length,sha256:hash(f.bytes)}))};
    files.push({path:'package-manifest.json',bytes:Buffer.from(JSON.stringify(inner,null,2)+'\n')});
    const archive=createUstar(files);const assetName=`Agent-ACP-MCP-Linux-${version}.tar.gz`;
    const manifest={schemaVersion:1,platform:'linux',architectures:['x64','arm64'],repository:REPOSITORY,version,tag:'v'+version,publishedAt,components:{gateway:gatewayPackage.version},notes:{gateway:notes.gateway},asset:{name:assetName,size:archive.length,sha256:hash(archive)},minimumUpdaterVersion:'1.0.0'};
    const raw=Buffer.from(JSON.stringify(manifest,null,2)+'\n'),signature=crypto.sign(null,raw,key).toString('base64')+'\n';
    verifyManifest(raw,signature,trusted,'x64');verifyManifest(raw,signature,trusted,'arm64');verifyPackage(parseArchive(archive),manifest);
    const assets=[[assetName,archive],['linux-update-manifest.json',raw],['linux-update-manifest.sig',signature],[assetName+'.sha256',manifest.asset.sha256+'  '+assetName+'\n']];
    // No overwrite, including when Windows assets already exist in this directory.
    for(const [name] of assets){try{await fs.lstat(path.join(out,name));throw Error(`Release asset already exists: ${name}`);}catch(e){if(e.code!=='ENOENT')throw e;}}
    for(const [name,bytes] of assets)await fs.writeFile(path.join(out,name),bytes,{flag:'wx'});
    console.log(JSON.stringify({status:'packaged',platform:'linux',version,gatewayVersion:gatewayPackage.version,architectures:manifest.architectures,files:files.length,asset:manifest.asset,output:out}));
    return {manifest,files:assets.map(([name])=>path.join(out,name))};
  }finally{if(temporary)await fs.rm(temporary,{recursive:true,force:true});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const options={};for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i];if(!['--gateway-dir','--out','--signing-key','--published-at'].includes(key)||!process.argv[i+1])throw Error('Usage: node build-release.mjs --signing-key KEY [--gateway-dir DIR] [--out DIR] [--published-at ISO]');options[key.slice(2).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=process.argv[i+1];}
  if(!options.signingKey)throw Error('--signing-key is required');await buildLinuxRelease(options);
}
