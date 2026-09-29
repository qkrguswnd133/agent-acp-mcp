/** CLI defaults may be replaced by server defaults at session/new or session/load. */
export async function confirmSessionConfig(
  initial:any[],model:string,effort:string,
  update:(configId:string,value:string)=>Promise<{configOptions:any[]}>,
):Promise<void>{
  let options=initial;
  const value=(id:string)=>options.find(option=>option.id===id&&option.type==='select')?.currentValue;
  for(const [id,desired] of [['model',model],['reasoning_effort',effort]]){
    if(value(id)!==desired)options=(await update(id,desired)).configOptions??[];
  }
  if(value('model')!==model||value('reasoning_effort')!==effort)
    throw Error(`ACP did not confirm ${model} / ${effort}; received ${value('model')} / ${value('reasoning_effort')}; refusing prompt`);
}
