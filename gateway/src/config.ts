import type {ProviderName} from './types.js';

const truthy = new Set(['1','true','yes','on','enabled']);
const falsy = new Set(['0','false','no','off','disabled']);

export function envBool(name:string, fallback:boolean):boolean {
  const raw=process.env[name];
  if(raw===undefined)return fallback;
  const value=raw.trim().toLowerCase();
  if(truthy.has(value))return true;
  if(falsy.has(value))return false;
  return fallback;
}

export function providerEnabled(name:ProviderName):boolean {
  if(name==='grok')return envBool('GROK_ENABLED',true);
  if(name==='claude')return envBool('CLAUDE_ENABLED',true);
  return envBool('CODEX_ENABLED',true);
}
/** Per-call booleans override the persistent setting; unset/invalid defaults to false. */
export function allowSelfProvider(override?:boolean):boolean {
  return typeof override==='boolean'?override:envBool('ALLOW_SELF_PROVIDER',false);
}

export function modelPolicy(name:ProviderName):string {
  return (process.env[`${name.toUpperCase()}_MODEL`]??'auto').trim()||'auto';
}

export function effortPolicy(name:ProviderName):string {
  if(name==='grok')return (process.env.GROK_EFFORT??'xhigh').trim()||'xhigh';
  return (process.env[`${name.toUpperCase()}_EFFORT`]??'auto').trim()||'auto';
}

export const quotaRetryMs=Math.max(60_000,Number(process.env.QUOTA_RETRY_MINUTES??15)*60_000||15*60_000);
