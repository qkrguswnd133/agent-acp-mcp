import {modelPolicy,effortPolicy} from './config.js';
import type {RunInput,ProviderName} from './types.js';
const providers:ProviderName[]=['grok','claude','codex'];
export function validateRunSettings(input:RunInput){
 const spec=(input.provider??'auto').trim().toLowerCase(),names=[...new Set(spec.split(',').map(x=>x.trim()).filter(Boolean))];
 const direct=input.model!==undefined||input.effort!==undefined;
 if(direct&&(names.length!==1||!providers.includes(names[0] as ProviderName)))throw Error('model/effort requires one explicit provider; use provider_options for auto or multiple providers');
 if(direct&&input.provider_options!==undefined)throw Error('Use either model/effort or provider_options, not both');
 const validate=(value:{model?:string;effort?:string})=>{
  if(!value||typeof value!=='object')throw Error('Invalid provider model settings');
  if(value.model!==undefined&&(typeof value.model!=='string'||! /^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]{0,199}$/.test(value.model)))throw Error('Invalid model identifier');
  if(value.effort!==undefined&&(typeof value.effort!=='string'||! /^[a-z][a-z0-9_-]{0,31}$/.test(value.effort)))throw Error('Invalid effort identifier');
 };
 validate(input);
 for(const [provider,options] of Object.entries(input.provider_options??{})){
  if(!providers.includes(provider as ProviderName))throw Error('Unknown provider_options key: '+provider);
  if(spec!=='auto'&&!names.includes(provider))throw Error('provider_options cannot target an unrequested provider: '+provider);
  validate(options);
 }
}
/** Pure resolution: never mutate shared environment or another invocation's settings. */
export function resolveProviderSettings(provider:ProviderName,input:RunInput){
 const local=input.provider_options?.[provider]??input;
 const source=(field:'model'|'effort')=>local[field]!==undefined?'call':process.env[`${provider.toUpperCase()}_${field.toUpperCase()}`]?.trim()?'environment':'default';
 return {model:local.model??modelPolicy(provider),effort:local.effort??effortPolicy(provider),modelSource:source('model'),effortSource:source('effort')};
}
