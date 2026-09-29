import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {regularFiles} from './release-lib.mjs';

const monitor=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','monitor');
const directories=new Set(['assets','backend','ui','update','node_modules','release','scripts','test','work']);
const files=new Set(['main.cjs','preload.cjs','geometry.cjs','package.json','package-lock.json']);
for(const entry of await fs.readdir(monitor,{withFileTypes:true})) {
  if(entry.isSymbolicLink()) throw new Error(`Link at monitor source root: ${entry.name}`);
  if(entry.isDirectory()) {
    if(!directories.has(entry.name)) throw new Error(`Unexpected monitor source directory: ${entry.name}`);
    if(!['node_modules','release','work'].includes(entry.name)) await regularFiles(path.join(monitor,entry.name));
  } else if(entry.isFile()) {
    if(!files.has(entry.name)) throw new Error(`Unexpected monitor source file: ${entry.name}`);
  } else throw new Error(`Unexpected monitor source entry: ${entry.name}`);
}
console.log('Monitor packaging input allowlist PASS');
