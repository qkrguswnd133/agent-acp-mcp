import {packager} from '@electron/packager';
import {copyFile} from 'node:fs/promises';
import path from 'node:path';
const paths=await packager({dir:'.',name:'Agent Monitor',platform:'win32',arch:'x64',out:'release',overwrite:true,icon:'assets/app.ico',ignore:[/^\/(release|test|work|scripts)(\/|$)/]});
for(const destination of paths)await copyFile('scripts/Start-Standalone.ps1',path.join(destination,'Start-Standalone.ps1'));
console.log(paths.join('\n'));
