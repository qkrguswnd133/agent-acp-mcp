import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {copyTree,releaseVersion,scanFirstParty,regularFiles} from './release-lib.mjs';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const stage=path.join(repo,'build','release',`v${releaseVersion}`,'payload');
const gateway=JSON.parse(await fs.readFile(path.join(repo,'gateway','package.json'),'utf8'));
const monitor=JSON.parse(await fs.readFile(path.join(repo,'monitor','package.json'),'utf8'));
if(!/^\d+\.\d+\.\d+$/.test(gateway.version)||!/^\d+\.\d+\.\d+$/.test(monitor.version)) throw new Error('Invalid component version');
const releaseDirectories=await fs.readdir(path.join(repo,'monitor','release'),{withFileTypes:true});
const packaged=releaseDirectories.filter(item=>item.isDirectory());
if(packaged.length!==1) throw new Error(`Expected one packaged monitor directory; found ${packaged.length}`);
const monitorPackage=path.join(repo,'monitor','release',packaged[0].name);
for(const required of ['Agent Monitor.exe','resources/app.asar']) await fs.access(path.join(monitorPackage,...required.split('/')));
const gatewayDocs=(await fs.readdir(path.join(repo,'gateway'))).filter(name=>name.endsWith('.md')).sort();
await scanFirstParty([
  path.join(repo,'README.md'),
  path.join(repo,'package.json'),
  path.join(repo,'scripts'),
  path.join(repo,'tests'),
  path.join(repo,'distribution'),
  path.join(repo,'gateway','src'),
  path.join(repo,'gateway','tests'),
  path.join(repo,'gateway','scripts'),
  path.join(repo,'gateway','profiles'),
  path.join(repo,'gateway','package.json'),
  path.join(repo,'monitor','backend'),
  path.join(repo,'monitor','ui'),
  path.join(repo,'monitor','update'),
  path.join(repo,'monitor','test'),
  path.join(repo,'monitor','scripts'),
  path.join(repo,'monitor','package.json'),
  path.join(repo,'monitor','main.cjs'),
  path.join(repo,'monitor','preload.cjs'),
  path.join(repo,'monitor','geometry.cjs'),
  path.join(repo,'monitor','login-item.cjs'),
  path.join(repo,'monitor','scripts','Start-Standalone.ps1'),
  path.join(repo,'distribution','examples'),
  path.join(repo,'distribution','instructions'),
  path.join(repo,'release-notes',`${releaseVersion}.json`),
  ...gatewayDocs.map(name=>path.join(repo,'gateway',name)),
]);
try {
  if((await fs.lstat(stage)).isSymbolicLink()) throw new Error('Release payload stage is a link');
} catch(error) { if(error.code!=='ENOENT') throw error; }
await fs.rm(stage,{recursive:true,force:true});
await fs.mkdir(stage,{recursive:true});
async function copyFile(relativeSource,relativeDestination=relativeSource) {
  const destination=path.join(stage,...relativeDestination.split('/'));
  await fs.mkdir(path.dirname(destination),{recursive:true});
  await fs.copyFile(path.join(repo,...relativeSource.split('/')),destination);
}
for(const filename of ['Install.ps1','Update.ps1','Run-Update.ps1','Verify-Package.mjs','README.md','THIRD-PARTY-NOTICES.md']) await copyFile(`distribution/${filename}`,filename);
await copyTree(path.join(repo,'distribution','examples'),path.join(stage,'examples'));
await copyTree(path.join(repo,'distribution','instructions'),path.join(stage,'instructions'));
for(const filename of ['package.json','package-lock.json']) await copyFile(`gateway/${filename}`,`gateway/${filename}`);
await copyTree(path.join(repo,'gateway','dist','src'),path.join(stage,'gateway','dist','src'));
await copyTree(path.join(repo,'gateway','src'),path.join(stage,'gateway','src'));
await copyTree(path.join(repo,'gateway','runtime','powershell7'),path.join(stage,'gateway','runtime','powershell7'));
await copyTree(path.join(repo,'gateway','runtime','codex-shell'),path.join(stage,'gateway','runtime','codex-shell'));
await copyFile('gateway/scripts/codex-shell-launcher.cs');
await copyTree(path.join(repo,'gateway','profiles'),path.join(stage,'gateway','profiles'));
for(const name of gatewayDocs) await copyFile(`gateway/${name}`,`gateway/${name}`);
await copyTree(monitorPackage,path.join(stage,'monitor'));
const info={schemaVersion:1,version:releaseVersion,components:{gateway:gateway.version,monitor:monitor.version}};
await fs.writeFile(path.join(stage,'release-info.json'),JSON.stringify(info,null,2)+'\n');
// Electron/Chromium license notices are third-party legal text and remain in
// the ZIP. They can contain upstream authors' Unix paths and private domains.
const upstream=(await regularFiles(path.join(stage,'gateway/runtime/powershell7'))).map(file=>'gateway/runtime/powershell7/'+file);
await scanFirstParty([stage],{skipRelativeFiles:['monitor/LICENSE','monitor/LICENSES.chromium.html',...upstream]});
console.log(`Assembled ${stage}`);
