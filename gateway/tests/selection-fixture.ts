import {modelPolicy,effortPolicy} from '../src/config.js';
import type {RunInput,ProviderName} from '../src/types.js';
/** Existing lifecycle/quota fixtures explicitly act as the parent under auto policies. */
export function selectedInput(input:RunInput,adapter?:ProviderName):RunInput{
 const spec=adapter??input.provider??'auto';
 const names=spec==='auto'?['grok','claude','codex'] as ProviderName[]:spec.split(',') as ProviderName[];
 const defaults=(name:ProviderName)=>({...(modelPolicy(name)==='auto'?{model:'fixture-model'}:{}),...(effortPolicy(name)==='auto'?{effort:name==='grok'?'xhigh':'high'}:{}),selection_reason:'Deterministic parent selection for this fixture.'});
 if(names.length===1&&!input.provider_options)return {...defaults(names[0]),...input,provider:adapter??input.provider,selection_reason:input.selection_reason??'Deterministic parent selection for this fixture.'};
 if(input.model!==undefined||input.effort!==undefined)return input;
 return {...input,provider_options:Object.fromEntries(names.map(name=>[name,{...defaults(name),...input.provider_options?.[name]}]))};
}
