import {modelPolicy,effortPolicy} from './config.js';
import type {RunInput,ProviderName,ProviderRunResult} from './types.js';
import type {ModelCatalog} from './model-catalog.js';
const providers:ProviderName[]=['grok','claude','codex'];
export interface SelectedSetting {value:string;source:'parent'|'configured';reason?:string}
export interface RunSelection {model:SelectedSetting;effort:SelectedSetting}
export class ModelSelectionError extends Error {
 constructor(public code:string,message:string,public provider?:ProviderName,public selection?:RunSelection){super(`${code}: ${message}`);this.name='ModelSelectionError';}
}
export function validateRunSettings(input:RunInput){
 const spec=(input.provider??'auto').trim().toLowerCase(),names=[...new Set(spec.split(',').map(x=>x.trim()).filter(Boolean))];
 const direct=input.model!==undefined||input.effort!==undefined||input.selection_reason!==undefined;
 if(direct&&(names.length!==1||!providers.includes(names[0] as ProviderName)))throw Error('model/effort/selection_reason requires one explicit provider; use provider_options for auto or multiple providers');
 if(direct&&input.provider_options!==undefined)throw Error('Use either model/effort/selection_reason or provider_options, not both');
 const validate=(value:{model?:string;effort?:string;selection_reason?:string})=>{
  if(!value||typeof value!=='object')throw Error('Invalid provider model settings');
  if(value.model!==undefined&&(typeof value.model!=='string'||! /^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]{0,199}$/.test(value.model)))throw Error('Invalid model identifier');
  if(value.effort!==undefined&&(typeof value.effort!=='string'||! /^[a-z][a-z0-9_-]{0,31}$/.test(value.effort)))throw Error('Invalid effort identifier');
  if(value.selection_reason!==undefined&&(typeof value.selection_reason!=='string'||!value.selection_reason.trim()||value.selection_reason.length>4000))throw new ModelSelectionError('SELECTION_REASON_REQUIRED','selection_reason must be nonblank and at most 4000 characters');
 };
 validate(input);
 for(const [provider,options] of Object.entries(input.provider_options??{})){
  if(!providers.includes(provider as ProviderName))throw Error('Unknown provider_options key: '+provider);
  if(spec!=='auto'&&!names.includes(provider))throw Error('provider_options cannot target an unrequested provider: '+provider);
  validate(options);
 }
}
/** Each field is a policy, not an override. No heuristics and no CLI defaults. */
export function resolveProviderSettings(provider:ProviderName,input:RunInput){
 const local=input.provider_options?.[provider]??input;
 const initial=(field:'model'|'effort'):SelectedSetting=>{const policy=field==='model'?modelPolicy(provider):effortPolicy(provider);return policy==='auto'?{value:local[field]??'unavailable',source:'parent',...(local.selection_reason?.trim()?{reason:local.selection_reason.trim()}:{})}:{value:policy,source:'configured'};};
 const selection:RunSelection={model:initial('model'),effort:initial('effort')};
 for(const field of ['model','effort'] as const){
  const configured=field==='model'?modelPolicy(provider):effortPolicy(provider),supplied=local[field];
  if(configured!=='auto'){
   selection[field]={value:configured,source:'configured'};
   if(supplied!==undefined&&supplied!==configured)throw new ModelSelectionError('FIXED_SETTING_CONFLICT',`${provider}.${field} is fixed to ${configured}; received ${supplied}`,provider,selection);
  }else{
   if(!supplied||['auto','unavailable','default'].includes(supplied))throw new ModelSelectionError('MODEL_SELECTION_REQUIRED',`${provider}.${field}=auto requires a concrete parent selection`,provider,selection);
   selection[field]={value:supplied,source:'parent',...(local.selection_reason?.trim()?{reason:local.selection_reason.trim()}:{})};
   if(!local.selection_reason?.trim())throw new ModelSelectionError('SELECTION_REASON_REQUIRED',`${provider}: parent-supplied ${field} requires selection_reason`,provider,selection);
  }
 }
 // Also protect native adapter callers that bypass the MCP schema.
 validateRunSettings({...input,provider,model:undefined,effort:undefined,selection_reason:undefined,provider_options:{[provider]:local}});
 return {model:selection.model.value,effort:selection.effort.value,modelSource:selection.model.source,effortSource:selection.effort.source,selection};
}
export function validateCatalog(provider:ProviderName,settings:ReturnType<typeof resolveProviderSettings>,catalog:ModelCatalog){
 const model=catalog.models.find(model=>model.id===settings.model);
 if(catalog.modelsAuthoritative&&!model)throw new ModelSelectionError('UNSUPPORTED_MODEL_OR_EFFORT',`${provider}: model ${settings.model} is absent from ${catalog.source}`,provider,settings.selection);
 if(model?.effortsAuthoritative&&!model.efforts?.includes(settings.effort))throw new ModelSelectionError('UNSUPPORTED_MODEL_OR_EFFORT',`${provider}: ${settings.model} does not advertise effort ${settings.effort}`,provider,settings.selection);
}
export function withSelection<T extends ProviderRunResult>(result:T,selection:RunSelection):T & {selection:RunSelection;observation:NonNullable<ProviderRunResult["observation"]>}{
 const observed=(field:'model'|'effort')=>{const value=result[field];const known=typeof value==='string'&&!!value&&!['auto','unavailable','default'].includes(value);return {value:known?value:'unavailable',source:known?String(result[`${field}Source`]??'provider_result'):'unavailable',verified:known};};
 return {...result,model:observed('model').value,effort:observed('effort').value,selection,observation:result.observation??{model:observed('model'),effort:observed('effort')}};
}
export function selectionFailure(provider:ProviderName,error:unknown,selection?:RunSelection):ProviderRunResult{
 const code=error instanceof ModelSelectionError?error.code:'task_error';
 const result:ProviderRunResult={provider,text:'',error:error instanceof Error?error.message:String(error),errorKind:code,model:'unavailable',effort:'unavailable',observation:{model:{value:'unavailable',source:'unavailable',verified:false},effort:{value:'unavailable',source:'unavailable',verified:false}}};
 if(selection)return withSelection(result,selection);
 if(error instanceof ModelSelectionError&&error.selection)result.selection=error.selection;
 return result;
}
