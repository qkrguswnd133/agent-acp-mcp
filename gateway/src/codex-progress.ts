/** Progress is derived from provider tool events, never from assistant prose.
 * Counts cover observed events and are not filesystem totals or test results. */
export class CodexProgress {
 private phase='starting';private lastActivityAt:string;private source='cli_json';private lastCommand:any=null;
 private terminal=false;private partial=false;
 private readonly streams={cli_json:{commands:new Map<string,any>(),writes:new Set<string>()},session_jsonl:{commands:new Map<string,any>(),writes:new Set<string>()}};
 constructor(private readonly startedAt:number){this.lastActivityAt=new Date(startedAt).toISOString();}
 observeCli(event:any,at=Date.now()){
  if(!event||typeof event.type!=='string')return false;
  const item=event.item;let phase:string|undefined;
  if(event.type==='thread.started'||event.type==='turn.started')phase='reasoning';
  if(item?.type==='command_execution'&&['item.started','item.updated','item.completed'].includes(event.type)){
   this.command('cli_json',item.id,item.command,item.cwd,event.type==='item.completed'?'completed':'running',item.exit_code??item.exitCode,at);return true;
  }
  if(item?.type==='file_change'&&event.type==='item.completed'){
   if(item.status!=='failed'){const key=typeof item.id==='string'?item.id:JSON.stringify(item.changes??[]);this.streams.cli_json.writes.add(key);}phase='editing';
  }
  if(item?.type==='reasoning')phase='reasoning';
  if(item?.type==='agent_message')phase=event.type==='item.completed'?'awaiting_terminal_event':'responding';
  if(event.type==='turn.completed'){this.terminal=true;this.phase=phase='completion_pending_cleanup';}
  if(event.type==='turn.failed'){this.terminal=true;this.phase=phase='failure_pending_cleanup';}
  if(!phase)return false;this.touch('cli_json',at,phase);return true;
 }
 observeSession(event:any){
  const at=Date.parse(event?.timestamp),p=event?.payload;if(!Number.isFinite(at)||!p)return false;
  if(event.type==='event_msg'){
   if(p.type==='exec_command_begin'){this.command('session_jsonl',p.call_id,p.command,p.cwd,'running',undefined,at);return true;}
   if(p.type==='exec_command_end'){this.command('session_jsonl',p.call_id,p.command,p.cwd,'completed',p.exit_code,at);return true;}
   if(p.type==='patch_apply_end'&&p.success===true){this.streams.session_jsonl.writes.add(String(p.call_id??event.timestamp));this.touch('session_jsonl',at,'editing');return true;}
   if(p.type==='task_complete'){this.terminal=true;this.phase='completion_pending_cleanup';this.touch('session_jsonl',at,this.phase);return true;}
   if(p.type==='agent_message'){this.touch('session_jsonl',at,'awaiting_terminal_event');return true;}
  }
  // Rollout files also expose the tool call before a corresponding exec event.
  // call_id is shared, so the begin/end forms update rather than double count it.
  if(event.type==='response_item'&&p.type==='function_call'&&['exec_command','shell_command','shell'].includes(p.name)){
   let args:any;try{args=typeof p.arguments==='string'?JSON.parse(p.arguments):p.arguments;}catch{return false;}
   if(!args)return false;this.command('session_jsonl',p.call_id,args.cmd??args.command,args.workdir??args.cwd,'running',undefined,at);return true;
  }
  return false;
 }
 markPartial(){this.partial=true;}
 finalized(){this.phase='finalized';}
 snapshot(){
  const counts=Object.values(this.streams).map(stream=>{
   const commands=[...stream.commands.values()];return {
    commandsStarted:commands.length,commandsCompleted:commands.filter(c=>c.status==='completed').length,
    successfulReads:commands.filter(c=>c.kind==='reading'&&c.exitCode===0).length,
    successfulWrites:stream.writes.size,successfulCommands:commands.filter(c=>c.exitCode===0).length,
    failedCommands:commands.filter(c=>typeof c.exitCode==='number'&&c.exitCode!==0).length,
    testCommandsStarted:commands.filter(c=>c.kind==='testing').length,
   };
  });
  const totals=Object.fromEntries(Object.keys(counts[0]!).map(key=>[key,Math.max(...counts.map(c=>c[key as keyof typeof c]))]));
  return {startedAt:new Date(this.startedAt).toISOString(),lastActivityAt:this.lastActivityAt,provider:'codex',source:this.source,
   phase:this.phase,...totals,lastCommand:this.lastCommand?{...this.lastCommand}:null,countsAreLowerBounds:true,
   truncated:this.partial,completionObserved:this.terminal,
   coverage:'Codex CLI and matching session tool events only. Counts use the maximum per source to avoid duplicate counting; shell read/test classification is inferred from command syntax. No test totals or unobserved file changes are inferred.'};
 }
 private command(source:'cli_json'|'session_jsonl',id:unknown,value:unknown,cwd:unknown,status:string,exitCode:unknown,at:number){
  const command=typeof value==='string'?value:Array.isArray(value)&&value.every(x=>typeof x==='string')?value.join(' '):undefined;
  if(typeof id!=='string'||!id)return;
  const stream=this.streams[source],previous=stream.commands.get(id);
  if(!command&&!previous)return;
  const text=command??previous.command,kind=command?commandPhase(text):previous.kind;
  const item={command:text.slice(0,1000),commandTruncated:command?text.length>1000:previous.commandTruncated,cwd:typeof cwd==='string'?cwd:previous?.cwd??null,
   status,exitCode:typeof exitCode==='number'&&Number.isInteger(exitCode)?exitCode:previous?.exitCode??null,kind,at:new Date(at).toISOString(),source};
  stream.commands.set(id,item);
  if(at>=Date.parse(this.lastActivityAt)){this.lastCommand=item;this.touch(source,at,status==='running'?kind:'reasoning');}
 }
 private touch(source:string,at:number,phase:string){
  if(at<Date.parse(this.lastActivityAt))return;
  this.lastActivityAt=new Date(at).toISOString();this.source=source;
  if(!this.terminal||phase==='completion_pending_cleanup'||phase==='failure_pending_cleanup')this.phase=phase;
 }
}

function commandPhase(command:string){
 if(/(?:^|[\s/\\"'])+(?:pytest|jest|vitest|ctest)(?:[\s"']|$)|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:gradlew?(?:\.bat)?|mvnw?(?:\.cmd)?)\s+[^\r\n]*(?:test|check|verify)\b|\bnode\s+--test\b/i.test(command))return 'testing';
 if(/(?:^|[\s/\\"'])+(?:rg|cat|head|tail|grep|sed|Get-Content|Select-String)(?:[\s"']|$)|\bgit\s+(?:show|diff|status|log)\b/i.test(command))return 'reading';
 return 'executing';
}
