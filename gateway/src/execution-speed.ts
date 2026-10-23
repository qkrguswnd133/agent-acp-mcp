import type {ProviderName,ProviderRunResult} from './types.js';
import type {ModelCatalog} from './model-catalog.js';
export type ExecutionSpeed='standard'|'fast'|'ultrafast';
export function speedPolicy(provider:ProviderName){
 const raw=process.env[`${provider.toUpperCase()}_SPEED`];
 return {value:(raw??'standard').trim().toLowerCase()||'standard',source:raw?.trim()?'configured':'default'};
}
export class SpeedSettingError extends Error {readonly code='UNSUPPORTED_EXECUTION_SPEED';}
export function validateExecutionSpeed(provider:ProviderName,model:string,catalog?:ModelCatalog):ExecutionSpeed{
 const speed=speedPolicy(provider).value;
 if(!['standard','fast','ultrafast'].includes(speed))throw new SpeedSettingError(`${provider.toUpperCase()}_SPEED must be standard, fast or a supported ultrafast tier; received ${speed}`);
 if(speed==='standard')return speed;
 if(provider==='grok')throw new SpeedSettingError('Grok CLI/ACP speed selection is not verified; only GROK_SPEED=standard is supported.');
 if(!catalog?.models.find(m=>m.id===model)?.speeds?.includes(speed))throw new SpeedSettingError(`${provider}: ${model} does not advertise ${speed} speed. Choose a supported model/tier; no silent fallback or model change.`);
 return speed as ExecutionSpeed;
}
export function codexSpeedArgs(speed:ExecutionSpeed){
 // The official CLI normalizes explicit "standard" to a null serviceTier.
 // Omission would permit a project/managed new-thread default to select Fast.
 return ['-c',`service_tier=${JSON.stringify(speed)}`,'-c',`features.fast_mode=${speed!=='standard'}`];
}
export function claudeSpeedSettings(speed:ExecutionSpeed){
 if(speed==='ultrafast')throw new SpeedSettingError('Claude does not advertise ultrafast speed.');
 const standard=speed==='standard';
 return {args:['--settings',JSON.stringify({fastMode:!standard,...(standard?{env:{CLAUDE_CODE_DISABLE_FAST_MODE:'1'}}:{})})],env:standard?{CLAUDE_CODE_DISABLE_FAST_MODE:'1'}:{}};
}
export function observedSpeed(value:unknown):ExecutionSpeed|undefined{
 if(value==='standard'||value==='default')return 'standard';
 if(value==='fast'||value==='priority')return 'fast';
 if(value==='ultrafast')return 'ultrafast';
 return undefined;
}
export function withExecutionSpeed<T extends ProviderRunResult>(result:T):T{
 const policy=speedPolicy(result.provider),observed=observedSpeed(result.speed);
 const fallback=observed&&observed!==policy.value?`Requested ${policy.value}; provider reported ${observed}. The task was not retried.`:policy.value==='fast'&&['off','cooldown'].includes(String(result.fastModeState))?`Fast was requested, but the final CLI fast mode state is ${result.fastModeState}${result.fastModeDisabledReason?': '+result.fastModeDisabledReason:''}. This does not describe every request in the session; no automatic retry.`:undefined;
 return {...result,executionSpeed:{requested:policy.value,settingSource:policy.source,observed:observed??'unavailable',observationSource:observed?result.speedSource??'provider_result':'unavailable',verified:!!observed,...(fallback?{warning:fallback}:{}),...(result.provider==='grok'?{note:'Standard uses the native Grok default; independent speed control is not advertised.'}:{})}};
}
