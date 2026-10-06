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
import {ModelSelectionError} from './model-settings.js';
import {GrokProvider} from './providers/grok.js';
import {ClaudeProvider} from './providers/claude.js';
import {CodexProvider} from './providers/codex.js';
import type {AgentKind,RunInput} from './types.js';

const router=new AgentRouter([new GrokProvider(),new ClaudeProvider(),new CodexProvider()]);
const jobs=new JobManager(path.join(root,'state/jobs'),(kind,input,signal,hooks)=>{
  const host=(input as any).__host;if(!host)throw Error('HOST_UNKNOWN: job was created without MCP client identity');
  return router.run(kind as AgentKind,input,host,signal,hooks);
});
jobs.setPreflight(input=>router.preflight(input,(input as any).__host));
let inFlight=0;
let maintenance:MaintenanceGate;
function tracked<T extends (...args:any[])=>Promise<any>>(handler:T):T {
 return (async(...args:Parameters<T>)=>{maintenance.assertAvailable();inFlight++;try{return await handler(...args);}finally{inFlight--;}}) as T;
}

const provider=z.string().min(1).max(100).default('auto').describe('Use "auto" for a random non-empty subset of callable providers (host eligibility follows ALLOW_SELF_PROVIDER / allow_self_provider), or an explicit comma-separated list such as "grok,claude".');
const model=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]{0,199}$/).describe('Concrete parent-selected provider model ID or advertised alias. auto is not a per-call selection; use agent_models to inspect catalog and configured policy.');
const effort=z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).describe('Concrete parent-selected effort supported by the selected model. auto requires a parent decision; it never delegates selection to the CLI.');
const selectionReason=z.string().trim().min(1).max(4000).describe('Why the parent selected the model/effort for this task. Required when filling any auto field.');
const providerSettings=z.object({model:model.optional(),effort:effort.optional(),selection_reason:selectionReason.optional()}).strict();
const base={
  task:z.string().min(1).max(100000),
  cwd:z.string().min(1).describe('Existing absolute working directory. For project usage attribution, pass the actual project root, not the gateway or a temporary directory. For isolated implementation, the scope is mapped into a managed worktree and original cwd is retained in metadata.'),
  provider,
  model:model.optional().describe('Concrete model selection for exactly one explicit provider; fixed configuration cannot be overridden; use provider_options for auto/multiple providers.'),
  effort:effort.optional().describe('Concrete effort selection for exactly one explicit provider; fixed configuration cannot be overridden; use provider_options for auto/multiple providers.'),
  selection_reason:selectionReason.optional(),
  provider_options:z.object({grok:providerSettings.optional(),claude:providerSettings.optional(),codex:providerSettings.optional()}).strict().optional().describe('Provider-specific concrete model/effort selections and reasons. Prevalidated for all eligible auto retry candidates. Does not change routing or force auto to select a provider. Cannot combine with top-level model/effort/selection_reason.'),
  allow_self_provider:z.boolean().optional().describe('Optional per-call override of the MCP server env ALLOW_SELF_PROVIDER (default false). Applies to auto and explicit routing. True includes the host in the eligible pool; auto selection is still random. False overrides a true environment default. Auth, quota, locks and nested-delegation protection still apply.'),
  context:z.string().max(100000).optional(),
  session_id:z.string().uuid().optional().describe('Grok-only continuation; use only with provider="grok". Keep cwd/tool unchanged; allowed_paths may be reordered or narrowed, never expanded. Supply the current narrowed scope again on later resumes.'),
  max_runtime_minutes:z.number().int().min(1).max(1440).default(120)
};
const reply=(value:unknown)=>({content:[{type:'text' as const,text:JSON.stringify(value)}]});
const errorReply=(e:unknown)=>({...reply({error:e instanceof Error?e.message:String(e),...(e instanceof ModelSelectionError?{errorKind:e.code,provider:e.provider,selection:e.selection}: {})}),isError:true});

function createServer(){
 const server=new McpServer({name:'agent-acp-mcp',version:'2.5.0'});
 const readTools:Record<string,string>={
   agent_ask:'Start an independent read-only engineering analysis through one or more external providers.',
   agent_review:'Start a read-only code review focused on correctness, regressions, edge cases, security, and complexity.',
   agent_investigate:'Start a read-only debugging/RCA/architecture investigation using independent provider evidence.'
 };
 for(const [name,description] of Object.entries(readTools))server.registerTool(name,{
   description:description+' provider="auto" randomly routes to a non-empty subset of enabled, healthy providers; host eligibility follows ALLOW_SELF_PROVIDER / allow_self_provider. If all initially executed providers hit a usage/rate limit, auto may retry once with fresh-checked unexecuted providers within the original deadline. Explicit provider lists never add providers. Returns a background job_id; use agent_job_wait or agent_job_status.',
   inputSchema:z.object(base),annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:true}
 },tracked(async(input,context)=>{
   try{return reply(await jobs.start(name,{...input,__host:detectHost(server,context)} as any));}catch(e){return errorReply(e);}
 }));
 server.registerTool('agent_implement',{
   description:'Start bounded implementation through selected external providers. With workspace_mode=auto, a conflicting job triggers an isolated Git worktree; dirty originals require explicit base_ref and are never copied. Parent must integrate, verify and call agent_worktree_cleanup after success. Multiple providers run sequentially; any failure stops later implementation and returns handoff information requiring parent workspace review. No automatic implementation retry. Implementation supports local shell builds/tests and failure repair. Grok file tools enforce allowed_paths; shells and Claude/Codex receive the requested scope, not a filesystem sandbox from this gateway. Inspect commandExecutions and final verification. Returns job_id; use agent_job_wait or agent_job_status. Clean empty worktrees are automatically removed after completion; changed or committed work is preserved.',
   inputSchema:z.object({...base,completion_criteria:z.string().min(1),allowed_paths:z.array(z.string()).min(1).optional(),workspace_mode:z.enum(['auto','current','isolated']).default('auto').describe('auto creates a managed worktree only when another overlapping job blocks implementation; current preserves blocking; isolated always creates one. Parent integrates and verifies before cleanup.'),base_ref:z.string().min(1).max(300).optional().describe('Committed Git starting ref for isolation. Required if original has uncommitted changes; those changes are NOT copied.')}),annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:true}
 },tracked(async(input,context)=>{try{return reply(await jobs.start('agent_implement',{...input,__host:detectHost(server,context)} as any));}catch(e){return errorReply(e);} }));
 server.registerTool('agent_worktree_status',{
   description:'Inspect a job managed worktree, branch, base commit and unintegrated changes. Does not modify files.',
   inputSchema:z.object({job_id:z.string().uuid(),include_disk_size:z.boolean().default(false)}),annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}
 },tracked(async({job_id,include_disk_size})=>{try{return reply(await jobs.worktreeStatus(job_id,include_disk_size));}catch(e){return errorReply(e);}}));
 server.registerTool('agent_worktree_cleanup',{
   description:'Safely remove idle managed worktrees. Supply job_id or up to 50 job_ids. dry_run previews eligibility without deleting. Clean empty worktrees (tip=base) need no integration/verification, including failed/cancelled jobs. Nonempty work requires completed job, parent verified=true and verification_summary, clean target including ignored/untracked files, and tip merged into current original HEAD (or opt-in verified patch equivalence). Unrelated original edits do not block cleanup. Bulk results preserve every skipped reason. Never force deletes.',
   inputSchema:z.object({job_id:z.string().uuid().optional(),job_ids:z.array(z.string().uuid()).min(1).max(50).optional(),dry_run:z.boolean().default(false),integration_ref:z.string().min(1).default('HEAD'),allow_patch_equivalent:z.boolean().default(false).describe('Accept cherry-picked commits only when every commit is covered and the current original HEAD still matches all touched paths. Merge commits are refused.'),verified:z.literal(true).optional(),verification_summary:z.string().max(4000).default('')}).refine(v=>!!v.job_id!==!!v.job_ids,'Supply either job_id or job_ids'),annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:false}
 },tracked(async({job_id,job_ids,dry_run,integration_ref,allow_patch_equivalent,verified,verification_summary})=>{try{const options={dryRun:dry_run,verified:verified===true,allowPatchEquivalent:allow_patch_equivalent};return reply(job_ids?await jobs.cleanupWorktrees(job_ids,integration_ref,verification_summary,options):await jobs.cleanupWorktree(job_id!,integration_ref,verification_summary,options));}catch(e){return errorReply(e);}}));
 server.registerTool('agent_worktree_list',{
   description:'List managed worktrees with bounded parallel inspection: job state, base/tip, commit/change counts, checkout health and integration into original HEAD. Disk scanning is off unless include_disk_size=true. Missing paths and metadata-only checkouts are explicit. Paginated; never deletes.',
   inputSchema:z.object({offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(100).default(50),include_removed:z.boolean().default(false),include_disk_size:z.boolean().default(false)}),annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}
 },tracked(async({offset,limit,include_removed,include_disk_size})=>{try{return reply(await jobs.listWorktrees(offset,limit,include_removed,include_disk_size));}catch(e){return errorReply(e);}}));
 server.registerTool('agent_worktree_migrate',{
   description:'Move a finished idle managed worktree with git worktree move into persistent storage. Default dry_run=true. Does not automatically migrate existing worktrees. Updates gateway metadata; start a new provider session after moving because historical provider paths cannot be rewritten. Never runs on active or unknown-owner jobs.',
   inputSchema:z.object({job_id:z.string().uuid(),dry_run:z.boolean().default(true),target_root:z.string().min(1).optional()}),annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:false}
 },tracked(async({job_id,dry_run,target_root})=>{try{return reply(await jobs.worktreeMaintenance(job_id,'migrate',{dryRun:dry_run,targetRoot:target_root}));}catch(e){return errorReply(e);}}));
 server.registerTool('agent_worktree_recover',{
   description:'Recover an idle metadata-only checkout whose tracked files are all missing and index unchanged. Default restore repopulates files from HEAD. remove restores then removes the checkout while preserving its branch. Refuses partial/missing/sparse checkouts. Default dry_run=true; apply requires verified=true and a parent summary acknowledging missing files. Uncommitted lost content cannot be recovered from Git.',
   inputSchema:z.object({job_id:z.string().uuid(),action:z.enum(['restore','remove']).default('restore'),dry_run:z.boolean().default(true),verified:z.literal(true).optional(),verification_summary:z.string().max(4000).default('')}),annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:false}
 },tracked(async({job_id,action,dry_run,verified,verification_summary})=>{try{return reply(await jobs.worktreeMaintenance(job_id,action,{dryRun:dry_run,verified,summary:verification_summary}));}catch(e){return errorReply(e);}}));
 server.registerTool('agent_job_status',{
   description:'Read background job progress and final provider results. Poll while queued/running/cancelling. Check outcome, successCount, failureCount, skipped, and handoff even when some providers succeeded. Outcome success means provider turn execution, not verified completion criteria. Inspect execution.commands, completionCriteria, processExit and processWarnings separately. implementationProgress warns when observed reading continues without writes/commands; parent should review scope/next step, never automatically cancel or replay. Missing telemetry is unavailable. Failed implementations require parent workspace review before continuing.',
   inputSchema:z.object({job_id:z.string().uuid(),verbose:z.boolean().default(false).describe('Default preserves the full review text and compacts command logs with artifact references. Large review bodies may exceed the response budget. true loads the full original diagnostics and can exceed client output limits.')}),annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}
 },async({job_id,verbose})=>{try{return reply(await jobs.status(job_id,verbose));}catch(e){return errorReply(e);}});
 server.registerTool('agent_job_wait',{
   description:'Wait for job completion or timeout, returning a compact status. Works across gateway processes. Timeout or cancelling this wait never cancels the job; use agent_job_cancel for that. Reissue the wait if wait.timed_out=true.',
   inputSchema:z.object({job_id:z.string().uuid(),timeout_seconds:z.number().min(0).max(60).default(25),verbose:z.boolean().default(false)}),annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}
 },async({job_id,timeout_seconds,verbose},context)=>{try{return reply(await jobs.wait(job_id,timeout_seconds,verbose,context.mcpReq.signal));}catch(e){return errorReply(e);}});
 server.registerTool('agent_job_cancel',{
   description:'Cancel a background multi-agent job. Partial edits are preserved.',inputSchema:z.object({job_id:z.string().uuid()}),annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}
 },async({job_id})=>{try{return reply(await jobs.cancel(job_id));}catch(e){return errorReply(e);}});
 server.registerTool('agent_models',{
   description:'Discover model/effort choices and configured policies through official local CLI protocols using subscription sessions, without a model prompt. Cached for five minutes; refresh forces discovery. Missing or partial catalogs explicitly leave support unverified. Auto fields require a concrete parent selection plus selection_reason; fixed fields reject conflicts. Provider routing auto is separate and is not accepted here.',
   inputSchema:z.object({provider:z.string().default('grok,claude,codex').describe('Explicit comma-separated provider names.'),refresh:z.boolean().optional()}),annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}
 },tracked(async({provider,refresh})=>{try{return reply(await router.models(provider,refresh??false));}catch(e){return errorReply(e);}}));
 server.registerTool('agent_status',{
   description:'Show detected MCP host plus Grok/Claude/Codex enabled, availability, authentication, subscription-auth, quota and callable state. Quota includes limitKind, actual resetsAt (null if unknown), and retryAfter for rechecking. Host is detected from MCP clientInfo; no static host setting is used.',
   inputSchema:z.object({refresh:z.boolean().optional(),allow_self_provider:z.boolean().optional()}),annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}
 },tracked(async({refresh,allow_self_provider},context)=>{try{const [status,worktreeWarnings]=await Promise.all([router.status(detectHost(server,context),refresh??false,allow_self_provider),jobs.worktreeWarnings()]);return reply({...status,worktreeWarnings});}catch(e){return errorReply(e);}}));
 server.registerTool('agent_cli_status',{
   description:'Refresh provider CLI/version/auth/quota diagnostics without updating anything.',inputSchema:z.object({}),annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}
 },tracked(async(_input,context)=>{try{return reply(await router.status(detectHost(server,context),true));}catch(e){return errorReply(e);}}));
 server.registerTool('agent_cli_update',{
   description:'Explicit maintenance update for provider CLIs. Requires a comma-separated provider list; auto is forbidden. The current MCP host provider is never updated. Codex update is reported unsupported because its installation method varies.',
   inputSchema:z.object({provider:z.string().min(1).max(100)}),annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:true}
 },tracked(async({provider},context)=>{try{return reply(await router.cliUpdate(provider,detectHost(server,context)));}catch(e){return errorReply(e);}}));
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
 const s=createServer();const c=new Client({name:'agent-bridge-compatibility-selftest',version:'2.5.0'});const [ct,st]=InMemoryTransport.createLinkedPair();
 try{await s.connect(st);await c.connect(ct);const result=await c.listTools();return ['agent_ask','agent_review','agent_investigate','agent_implement','agent_status','agent_cli_status','agent_cli_update','agent_job_status','agent_job_cancel'].every(name=>result.tools.some(t=>t.name===name));}
 finally{await c.close();await s.close();}
});

console.error(JSON.stringify({event:'agent_bridge_start',version:'2.5.0',providers:{grok:process.env.GROK_ENABLED??'default:true',claude:process.env.CLAUDE_ENABLED??'default:true',codex:process.env.CODEX_ENABLED??'default:true'}}));
await serveStdio(createServer);

