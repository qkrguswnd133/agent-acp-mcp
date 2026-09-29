import path from 'node:path';
import {within} from './policy.js';

/** Inputs are canonical paths. Continuations may retain or reduce authority only. */
export function validateContinuationScope(saved:any,cwd:string,kind:string,allowed:string[]):void {
 if(!saved||typeof saved.cwd!=='string'||path.relative(saved.cwd,cwd)!==''||saved.kind!==kind)
  throw Error('Continuation cwd or tool differs; start a new session for another workspace or tool');
 if(!Array.isArray(saved.allowed)||!saved.allowed.every((p:unknown)=>typeof p==='string'&&path.isAbsolute(p)&&within(saved.cwd,p)))
  throw Error('Continuation saved scope is invalid; start a new session');
 if(!allowed.every(p=>within(cwd,p)&&saved.allowed.some((previous:string)=>within(previous,p))))
  throw Error('Continuation allowed_paths expands the previous scope; retain or narrow it, or start a new session');
}
