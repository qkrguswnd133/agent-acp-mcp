/** Policy denial is not user cancellation. Never synthesize an option ID. */
export function permissionResponse(options:ReadonlyArray<{kind:string;optionId:string}>,allowed:boolean,cancelled=false){
 if(cancelled)return {outcome:{outcome:'cancelled' as const}};
 const option=options.find(value=>value.kind===(allowed?'allow_once':'reject_once'));
 if(!option)throw Error(`ACP permission response unavailable: agent did not offer ${allowed?'allow_once':'reject_once'}; command was not authorized`);
 return {outcome:{outcome:'selected' as const,optionId:option.optionId}};
}
