import type {ChildProcess} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {home,providerChildEnv,terminateProcess} from './process.js';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export const executable = process.env.GROK_CLI || path.join(home,'.grok','bin',process.platform==='win32'?'grok.exe':'grok');
export const childEnv:NodeJS.ProcessEnv = providerChildEnv({GROK_DISABLE_AUTOUPDATER:'1',GROK_SUBAGENTS:'0'});
export const acpArgs = ['agent','--no-leader','--model','grok-4.6','--effort','xhigh'];
export const active = new Set<ChildProcess>();
export const terminate=terminateProcess;
export let shuttingDown=false;
export async function shutdown() { shuttingDown=true;await Promise.all([...active].map(terminate)); }
