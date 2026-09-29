import {McpServer} from '@modelcontextprotocol/server';
import {serveStdio} from '@modelcontextprotocol/server/stdio';
import {Client,InMemoryTransport} from '@modelcontextprotocol/client';
import {z} from 'zod/v4';
import path from 'node:path';
import {root,shutdown} from './runtime.js';
import {active} from './runtime.js';
import {MaintenanceGate} from './maintenance.js';
import {setMcpSelfTest} from './health.js';
import {JobManager} from './jobs.js';
import {detectHost} from './host.js';
import {AgentRouter} from './router.js';
import {GrokProvider} from './providers/grok.js';
import {ClaudeProvider} from './providers/claude.js';
import {CodexProvider} from './providers/codex.js';
import type {AgentKind,RunInput} from './types.js';

const router=new AgentRouter([new GrokProvider(),new ClaudeProvider(),new CodexProvider()]);
const jobs=new JobManager(path.join(root,'state/jobs'),(kind,input,signal,hooks)=>{
  const host=(input as any).__host;if(!host)throw Error('HOST_UNKNOWN: job was created without MCP client identity');
  return router.run(kind as AgentKind,input,host,signal,hooks);
});
let inFlight=0;
let maintenance:MaintenanceGate;
function tracked<T extends (...args:any[])=>Promise<any>>(handler:T):T {
 return (async(...args:Parameters<T>)=>{maintenance.assertAvailable();inFlight++;try{return await handler(...args);}finally{inFlight--;}}) as T;
}

const provider=z.string().min(1).max(100).default('auto').describe('Use "auto" for a random non-empty subset of callable providers (host eligibility follows ALLOW_SELF_PROVIDER / allow_self_provider), or an explicit comma-separated list such as "grok,claude".');
const model=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]{0,199}$/).describe('Provider model ID or supported alias; auto uses provider automatic/default selection.');
const effort=z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).describe('Provider-supported effort, e.g. low/medium/high/xhigh; support is model-dependent. auto uses provider default policy.');
const providerSettings=z.object({model:model.optional(),effort:effort.optional()}).strict();
const base={
  task:z.string().min(1).max(100000),
  cwd:z.string().min(1).describe('Existing absolute working directory. For project usage attribution, pass the actual project root, not the gateway or a temporary directory. For isolated implementation, the scope is mapped into a managed worktree and original cwd is retained in metadata.'),
  provider,
  model:model.optional().describe('Per-call model override for exactly one explicit provider; use provider_options for auto/multiple providers.'),
  effort:effort.optional().describe('Per-call effort override for exactly one explicit provider; use provider_options for auto/multiple providers.'),
  provider_options:z.object({grok:providerSettings.optional(),claude:providerSettings.optional(),codex:providerSettings.optional()}).strict().optional().describe('Provider-specific model/effort overrides. Does not change routing or force auto to select a provider. Cannot combine with top-level model/effort.'),
  allow_self_provider:z.boolean().optional().describe('Optional per-call override of the MCP server env ALLOW_SELF_PROVIDER (default false). Applies to auto and explicit routing. True includes the host in the eligible pool; auto selection is still random. False overrides a true environment default. Auth, quota, locks and nested-delegation protection still apply.'),
  context:z.string().max(100000).optional(),
  session_id:z.string().uuid().optional().describe('Grok-only continuation; use only with provider="grok". Keep cwd/tool unchanged; allowed_paths may be reordered or narrowed, never expanded. Supply the current narrowed scope again on later resumes.'),
  max_runtime_minutes:z.number().int().min(1).max(1440).default(120)
};
const reply=(value:unknown)=>({content:[{type:'text' as const,text:JSON.stringify(value)}]});
const errorReply=(e:unknown)=>({...reply({error:e instanceof Error?e.message:String(e)}),isError:true});

function createServer(){
 const server=new McpServer({name:'agent-acp-mcp',version:'2.2.0'});
 const readTools:Record<string,string>={
   agent_ask:'Start an independent read-only engineering analysis through one or more external providers.',
   agent_review:'Start a read-only code review focused on correctness, regressions, edge cases, security, and complexity.',
   agent_investigate:'Start a read-only debugging/RCA/architecture investigation using independent provider evidence.'
 };
 for(const [name,description] of Object.entries(readTools))server.registerTool(name,{
   description:description+' provider="auto" randomly routes to a non-empty subset of enabled, healthy providers; host eligibility follows ALLOW_SELF_PROVIDER / allow_self_provider. If all initially executed providers hit a usage/rate limit, auto may retry once with fresh-checked unexecuted providers within the original deadline. Explicit provider lists never add providers. Returns a background job_id; poll agent_job_status.',
   inputSchema:z.object(base),annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:true}
 },tracked(async(input)=>{
   try{return reply(await jobs.start(name,{...input,__host:detectHost(server)} as any));}catch(e){return errorReply(e);}
 }));
 server.registerTool('agent_implement',{
   description:'Start bounded implementation through selected external providers. With workspace_mode=auto, a conflicting job triggers an isolated Git worktree; dirty originals require explicit base_ref and are never copied. Parent must integrate, verify and call agent_worktree_cleanup after success. Multiple providers run sequentially; any failure stops later implementation and returns handoff information requiring parent workspace review. No automatic implementation retry. Implementation supports local shell builds/tests and failure repair. Grok file tools enforce allowed_paths; shells and Claude/Codex receive the requested scope, not a filesystem sandbox from this gateway. Inspect commandExecutions and final verification. Returns job_id; poll agent_job_status.',
   inputSchema:z.object({...base,completion_criteria:z.string().min(1),allowed_paths:z.array(z.string()).min(1).optional(),workspace_mode:z.enum(['auto','current','isolated']).default('auto').describe('auto creates a managed worktree only when another overlapping job blocks implementation; current preserves blocking; isolated always creates one. Parent integrates and verifies before cleanup.'),base_ref:z.string().min(1).max(300).optional().describe('Committed Git starting ref for isolation. Required if original has uncommitted changes; those changes are NOT copied.')}),annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:true}
 },tracked(async(input)=>{try{return reply(await jobs.start('agent_implement',{...input,__host:detectHost(server)} as any));}catch(e){return errorReply(e);} }));
 server.registerTool('agent_worktree_status',{
   description:'Inspect a job managed worktree, branch, base commit and unintegrated changes. Does not modify files.',
   inputSchema:z.object({job_id:z.string().uuid()}),annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}
 },tracked(async({job_id})=>{try{return reply(await jobs.worktreeStatus(job_id));}catch(e){return errorReply(e);}}));
 server.registerTool('agent_worktree_cleanup',{
   description:'After parent has committed, merged and tested the original workspace, remove a completed job clean managed worktree and branch. Requires integration into original HEAD, no dirty/untracked/ignored files, and parent verification. Failed/cancelled jobs and unmerged work are preserved. Never force deletes.',
   inputSchema:z.object({job_id:z.string().uuid(),integration_ref:z.string().min(1).default('HEAD'),verified:z.literal(true),verification_summary:z.string().min(1).max(4000)}),annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:false}
 },tracked(async({job_id,integration_ref,verification_summary})=>{try{return reply(await jobs.cleanupWorktree(job_id,integration_ref,verification_summary));}catch(e){return errorReply(e);}}));
 server.registerTool('agent_job_status',{
   description:'Read background job progress and final provider results. Poll while queued/running/cancelling. Check outcome, successCount, failureCount, skipped, and handoff even when some providers succeeded. Outcome success means provider turn execution, not verified completion criteria. Inspect execution.commands, completionCriteria, processExit and processWarnings separately. implementationProgress warns when observed reading continues without writes/commands; parent should review scope/next step, never automatically cancel or replay. Missing telemetry is unavailable. Failed implementations require parent workspace review before continuing.',
   inputSchema:z.object({job_id:z.string().uuid()}),annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}
 },async({job_id})=>{try{return reply(await jobs.status(job_id));}catch(e){return errorReply(e);}});
 server.registerTool('agent_job_cancel',{
   description:'Cancel a background multi-agent job. Partial edits are preserved.',inputSchema:z.object({job_id:z.string().uuid()}),annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}
 },async({job_id})=>{try{return reply(await jobs.cancel(job_id));}catch(e){return errorReply(e);}});
 server.registerTool('agent_status',{
   description:'Show detected MCP host plus Grok/Claude/Codex enabled, availability, authentication, subscription-auth, quota and callable state. Quota includes limitKind, actual resetsAt (null if unknown), and retryAfter for rechecking. Host is detected from MCP clientInfo; no static host setting is used.',
   inputSchema:z.object({refresh:z.boolean().optional(),allow_self_provider:z.boolean().optional()}),annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}
 },tracked(async({refresh,allow_self_provider})=>{try{return reply(await router.status(detectHost(server),refresh??false,allow_self_provider));}catch(e){return errorReply(e);}}));
 server.registerTool('agent_cli_status',{
   description:'Refresh provider CLI/version/auth/quota diagnostics without updating anything.',inputSchema:z.object({}),annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}
 },tracked(async()=>{try{return reply(await router.status(detectHost(server),true));}catch(e){return errorReply(e);}}));
 server.registerTool('agent_cli_update',{
   description:'Explicit maintenance update for provider CLIs. Requires a comma-separated provider list; auto is forbidden. The current MCP host provider is never updated. Codex update is reported unsupported because its installation method varies.',
   inputSchema:z.object({provider:z.string().min(1).max(100)}),annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:true}
 },tracked(async({provider})=>{try{return reply(await router.cliUpdate(provider,detectHost(server)));}catch(e){return errorReply(e);}}));
 return server;
}

let closing:Promise<void>|undefined;
function closeBridge(){return closing??=(async()=>{await jobs.close();await shutdown();})();}
maintenance=new MaintenanceGate(root,()=>jobs.isIdle()&&inFlight===0&&active.size===0,()=>{void closeBridge().finally(()=>process.exit(0));});
jobs.setMaintenanceCheck(()=>maintenance.assertAvailable());
maintenance.start();
process.stdin.on('end',()=>{void closeBridge();});
for(const s of ['SIGINT','SIGTERM'] as const)process.on(s,()=>{void closeBridge().finally(()=>process.exit(0));});

setMcpSelfTest(async()=>{
 const s=createServer();const c=new Client({name:'agent-bridge-compatibility-selftest',version:'2.2.0'});const [ct,st]=InMemoryTransport.createLinkedPair();
 try{await s.connect(st);await c.connect(ct);const result=await c.listTools();return ['agent_ask','agent_review','agent_investigate','agent_implement','agent_status','agent_cli_status','agent_cli_update','agent_job_status','agent_job_cancel'].every(name=>result.tools.some(t=>t.name===name));}
 finally{await c.close();await s.close();}
});

console.error(JSON.stringify({event:'agent_bridge_start',version:'2.2.0',providers:{grok:process.env.GROK_ENABLED??'default:true',claude:process.env.CLAUDE_ENABLED??'default:true',codex:process.env.CODEX_ENABLED??'default:true'}}));
await serveStdio(createServer);

