import type {ProviderName} from './types.js';
export interface CatalogModel {id:string;name?:string;efforts?:string[];effortsAuthoritative:boolean}
export interface ModelCatalog {provider:ProviderName;status:'available'|'partial'|'unavailable';source:string;version:string;observedAt:string;expiresAt:string;modelsAuthoritative:boolean;models:CatalogModel[];note?:string}
export const catalogTtlMs=300_000;
export function catalog(provider:ProviderName,source:string,version:string,models:CatalogModel[],authoritative:boolean,note?:string):ModelCatalog{
 const now=Date.now();return {provider,source,version,observedAt:new Date(now).toISOString(),expiresAt:new Date(now+catalogTtlMs).toISOString(),models,modelsAuthoritative:authoritative,status:models.length?(authoritative&&models.every(m=>m.effortsAuthoritative)?'available':'partial'):'unavailable',...(note?{note}:{})};
}
export function unavailableCatalog(provider:ProviderName,note='Catalog discovery is unavailable; provider CLI rejection remains authoritative.',version='unavailable'){return catalog(provider,'unavailable',version,[],false,note);}
export class CatalogCache {
 private entries=new Map<string,ModelCatalog>();private pending=new Map<string,Promise<ModelCatalog>>();
 async get(key:string,load:()=>Promise<ModelCatalog>,force=false):Promise<ModelCatalog>{
  const old=this.entries.get(key);if(!force&&old&&Date.parse(old.expiresAt)>Date.now())return old;
  const pending=this.pending.get(key);if(pending)return pending;
  const result=load().then(value=>{this.entries.set(key,value);return value;}).finally(()=>this.pending.delete(key));this.pending.set(key,result);return result;
 }
}
const ids=(value:any):string[]=>Array.isArray(value)?[...new Set(value.map(v=>typeof v==='string'?v:v?.id??v?.value??v?.reasoningEffort).filter(v=>typeof v==='string'&&v.length>0))] as string[]:[];
export function grokCatalog(state:any,version:string,options:any[]=[]):ModelCatalog{
 const raw=state?.availableModels;
 const config=options.find(option=>option.id==='model'&&option.type==='select');
 const configModels=ids(config?.options);
 const models:CatalogModel[]=Array.isArray(raw)?raw.filter((m:any)=>typeof m.modelId==='string'&&m._meta?.apiKeyRequired!==true&&m._meta?.supportsToolUse!==false).map((m:any)=>({id:m.modelId,name:m.name,efforts:ids(m._meta?.reasoningEfforts),effortsAuthoritative:Array.isArray(m._meta?.reasoningEfforts)})):configModels.map(id=>({id,effortsAuthoritative:false}));
 const effort=options.find(option=>option.id==='reasoning_effort'&&option.type==='select');
 // Config effort options are scoped to the current model, never every model.
 const current=models.find(m=>m.id===(config?.currentValue??state?.currentModelId));
 if(current&&!current.effortsAuthoritative&&Array.isArray(effort?.options)){current.efforts=ids(effort.options);current.effortsAuthoritative=true;}
 return catalog('grok','grok_acp_model_state',version,models,(Array.isArray(raw)&&raw.length>0)||configModels.length>0,models.length?undefined:'ACP did not advertise a usable model catalog; support is unverified.');
}
export function codexCatalog(rows:any[],version:string,complete=true):ModelCatalog{
 const models:CatalogModel[]=rows.filter(m=>typeof m?.model==='string'||typeof m?.id==='string').map(m=>({id:m.model??m.id,name:m.displayName,efforts:ids(m.supportedReasoningEfforts),effortsAuthoritative:Array.isArray(m.supportedReasoningEfforts)}));
 return catalog('codex','codex_app_server_model_list',version,models,complete&&models.length>0,!complete?'Incomplete model/list pagination; model absence is unverified.':models.length?undefined:'model/list returned no usable models; support is unverified.');
}
export function claudeCatalog(value:any,version:string):ModelCatalog{
 const raw=value?.models;
 const models:CatalogModel[]=Array.isArray(raw)?raw.filter(m=>typeof m?.value==='string'&&!['auto','default'].includes(m.value)).map(m=>({id:m.value,name:m.displayName,efforts:ids(m.supportedEffortLevels),effortsAuthoritative:Array.isArray(m.supportedEffortLevels)})):[];
 return catalog('claude','claude_control_initialize',version,models,false,models.length?'CLI supported-model choices may be aliases rather than an exhaustive snapshot catalog; absence does not establish unsupported model. Effort support is validated only when enumerated.':'CLI initialize did not advertise supported models; support is unverified.');
}
