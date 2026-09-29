import {readdirSync} from 'node:fs';import {spawnSync} from 'node:child_process';
const files=readdirSync('test').filter(n=>n.endsWith('.test.mjs')).map(n=>'test/'+n);
const result=spawnSync(process.execPath,['--test',...files],{stdio:'inherit',windowsHide:true});process.exit(result.status??1);
