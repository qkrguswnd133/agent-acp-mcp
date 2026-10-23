/** A subscription CLI protocol fixture. No real CLI or model is invoked. */
export interface CodexAppServerFixtureOptions {
 argsFile?:string;
 requestsFile?:string;
 threadId?:string;
 threadResult?:Record<string,unknown>;
 startup?:string;
 onRequest?:string;
 beforeTurn?:string;
 models?:any[];
 exitCode?:number;
 stderr?:string;
}

/**
 * Reuses synthetic exec events as test input, but emits only documented
 * app-server notifications. Settings are returned by this same thread/start;
 * service tier is deliberately not added to turn/completed as backend usage.
 */
export function codexAppServerFixtureScript(events:any[],options:CodexAppServerFixtureOptions={}):string{
 const threadId=options.threadId??events.find(event=>event.type==='thread.started')?.thread_id??'codex-fixture-thread';
 const runtime=[...events].reverse().find(event=>event.model!==undefined||event.reasoning_effort!==undefined||event.service_tier!==undefined);
 const threadResult=options.threadResult??{
  ...(runtime?.model!==undefined?{model:runtime.model}:{}),
  ...(runtime?.reasoning_effort!==undefined?{reasoningEffort:runtime.reasoning_effort}:{}),
  serviceTier:runtime?.service_tier==='priority'||runtime?.service_tier==='fast'?'priority':null,
 };
 return `import fs from 'node:fs';import path from 'node:path';import readline from 'node:readline';
const args=process.argv.slice(2),threadId=${JSON.stringify(threadId)},turnId='fixture-turn';
const events=${JSON.stringify(events)},settings=${JSON.stringify(threadResult)};
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const note=(method,params)=>send({method,params:{threadId,turnId,...params}});
${options.argsFile?`fs.writeFileSync(${JSON.stringify(options.argsFile)},JSON.stringify(args));`:''}
${options.startup??''}
for await(const line of readline.createInterface({input:process.stdin})){
 let request;try{request=JSON.parse(line);}catch{continue;}
 ${options.onRequest??''}
 ${options.requestsFile?`fs.appendFileSync(${JSON.stringify(options.requestsFile)},JSON.stringify(request)+'\\n');`:''}
 if(request.id===undefined)continue;
 if(request.method==='initialize'){send({id:request.id,result:{userAgent:'fixture/1'}});continue;}
 if(request.method==='config/read'){send({id:request.id,result:{config:{mcp_servers:{}}}});continue;}
 if(request.method==='model/list'){send({id:request.id,result:{data:${JSON.stringify(options.models??[])},nextCursor:null}});continue;}
 if(request.method==='account/read'){send({id:request.id,result:{account:{type:'chatgpt',email:'fixture@example.invalid'}}});continue;}
 if(request.method==='account/rateLimits/read'){send({id:request.id,result:{rateLimits:{primary:{usedPercent:10,resetsAt:1999999999}}}});continue;}
 if(request.method==='thread/start'){send({id:request.id,result:{thread:{id:threadId},...settings}});continue;}
 if(request.method==='turn/interrupt'){send({id:request.id,result:{}});note('turn/completed',{turn:{id:turnId,status:'interrupted',items:[],error:null}});continue;}
 if(request.method!=='turn/start'){send({id:request.id,error:{code:-32601,message:'Unsupported fixture method '+request.method}});continue;}
 send({id:request.id,result:{turn:{id:turnId,status:'inProgress',items:[],error:null}}});
 note('turn/started',{turn:{id:turnId,status:'inProgress',items:[],error:null}});
 ${options.beforeTurn??''}
 for(const [index,event] of events.entries()){
  if(event.type==='thread.started')continue;
  if(event.usage){const usage={inputTokens:event.usage.input_tokens??0,cachedInputTokens:event.usage.cached_input_tokens??0,outputTokens:event.usage.output_tokens??0,reasoningOutputTokens:event.usage.reasoning_output_tokens??0,totalTokens:(event.usage.input_tokens??0)+(event.usage.output_tokens??0)};note('thread/tokenUsage/updated',{tokenUsage:{total:usage,last:usage,modelContextWindow:null}});}
  if(event.type==='item.started'||event.type==='item.completed'){
   const value=event.item??{},item={...value,id:value.id??'fixture-item-'+index};
   if(value.type==='agent_message')item.type='agentMessage';
   if(value.type==='command_execution'){
    item.type='commandExecution';item.cwd=value.cwd??process.cwd();item.status=event.type==='item.completed'?'completed':'inProgress';
    item.aggregatedOutput=value.aggregated_output;item.exitCode=value.exit_code;item.durationMs=value.duration_ms;
    delete item.aggregated_output;delete item.exit_code;delete item.duration_ms;
   }
   if(value.type==='file_change')item.type='fileChange';
   note(event.type.replace('.','/'),{item});continue;
  }
  if(event.type==='turn.completed'||event.type==='turn.failed'){
   note('turn/completed',{turn:{id:turnId,status:event.type==='turn.failed'?'failed':'completed',error:event.error??null,items:[]}});continue;
  }
  if(event.type==='error')note('error',{error:event.error??{message:event.message},willRetry:events.slice(index+1).some(next=>next.type==='turn.completed')});
 }
 ${options.stderr?`process.stderr.write(${JSON.stringify(options.stderr)});`:''}
 ${options.exitCode!==undefined?`setTimeout(()=>process.exit(${options.exitCode}),50);`:''}
}
`;
}
