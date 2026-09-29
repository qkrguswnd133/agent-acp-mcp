export interface ModelEvidence { source:string; model:string; }
const identifier=(value:unknown):value is string=>typeof value==='string'&&!!value.trim()&&!['auto','unavailable','<synthetic>'].includes(value.trim());

/** Keep provider identifiers intact; aliases and context suffixes are not revisions. */
export function claudeModelMetadata(parsed:any,sessionModels:string[]=[]){
 const evidence:ModelEvidence[]=[];
 const add=(source:string,value:unknown)=>{if(identifier(value))evidence.push({source,model:value.trim()});};
 add('cli_result.model',parsed?.model);
 for(const field of ['modelUsage','model_usage']){
  const usage=parsed?.[field];
  if(usage&&typeof usage==='object'&&!Array.isArray(usage))for(const name of Object.keys(usage))add(`cli_result.${field}`,name);
 }
 for(const name of sessionModels)add('session_jsonl.message.model',name);
 const cliModels=[...new Set(evidence.filter(e=>e.source.startsWith('cli_result.')).map(e=>e.model))];
 const transcriptModels=[...new Set(evidence.filter(e=>e.source.startsWith('session_jsonl.')).map(e=>e.model))];
 const selected=cliModels.length?cliModels:transcriptModels;
 const observedModels=[...new Set(evidence.map(e=>e.model))];
 // Only explicitly named model fields count. CLI `version` and self-reported text do not.
 const explicit=(fields:string[])=>{
  const values=fields.flatMap(field=>identifier(parsed?.[field])?[{value:parsed[field].trim() as string,source:`cli_result.${field}`}]:[]);
  const unique=[...new Set(values.map(e=>e.value))];
  return {value:unique.length===1?unique[0]:unique.length?'mixed':'unavailable',evidence:values};
 };
 const minor=explicit(['model_minor_version','modelMinorVersion']);
 const snapshot=explicit(['model_snapshot','modelSnapshot']);
 return {model:selected.length===1?selected[0]:selected.length?'mixed':'unavailable',
  modelSource:cliModels.length?'cli_result':transcriptModels.length?'session_jsonl':'unavailable',
  cliModels,transcriptModels,observedModels,modelEvidence:evidence,
  minorVersion:minor.value,minorVersionEvidence:minor.evidence,
  modelSnapshot:snapshot.value,modelSnapshotEvidence:snapshot.evidence};
}
