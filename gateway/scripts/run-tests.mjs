import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const files=readdirSync(new URL('../dist/tests/',import.meta.url)).filter(name=>name.endsWith('.test.js')).map(name=>`dist/tests/${name}`);
const result=spawnSync(process.execPath,['--test',...files],{stdio:'inherit',windowsHide:true});
process.exit(result.status??1);
