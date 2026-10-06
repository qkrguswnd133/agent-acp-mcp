import './isolated-environment.js';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import path from 'node:path';
import assert from 'node:assert/strict';
import {root} from '../src/acp.js';

const transport=new StdioClientTransport({
 command:process.execPath,
 args:[path.join(root,'dist/src/index.js')],
 env:{...process.env,GROK_ENABLED:'false',CLAUDE_ENABLED:'false',CODEX_ENABLED:'false',ALLOW_SELF_PROVIDER:'true'},
 stderr:'pipe'
});
transport.stderr?.on('data',data=>process.stderr.write(data));
const c=new Client({name:'codex_smoke_client',title:'Codex smoke client',version:'2.0.0'});
try{
 await c.connect(transport);
 const list=await c.listTools();
 const expected=['agent_ask','agent_review','agent_investigate','agent_implement','agent_job_status','agent_job_cancel','agent_status','agent_cli_status','agent_cli_update','agent_worktree_status','agent_worktree_cleanup'];
 for(const name of expected)assert.ok(list.tools.some(t=>t.name===name),`missing ${name}`);
 const status=await c.callTool({name:'agent_status',arguments:{allow_self_provider:false}});
 const value=JSON.parse((status.content as any[])[0].text);
 assert.equal(value.host.host,'codex');
 assert.equal(value.providers.codex.blocked_reason,'self_provider');
 const inherited=JSON.parse(((await c.callTool({name:'agent_status',arguments:{}})).content as any[])[0].text);
 assert.equal(inherited.allow_self_provider,true);assert.equal(inherited.self_provider_policy_source,'environment_default');assert.equal(inherited.providers.codex.blocked_reason,'disabled');
 const opted=JSON.parse(((await c.callTool({name:'agent_status',arguments:{allow_self_provider:true}})).content as any[])[0].text);
 assert.equal(opted.allow_self_provider,true);assert.equal(opted.providers.codex.blocked_reason,'disabled');assert.equal(opted.providers.codex.callable,false);
 for(const name of ['agent_ask','agent_review','agent_investigate','agent_implement'])assert.ok(list.tools.find(t=>t.name===name)?.inputSchema.properties?.allow_self_provider);
 for(const name of ['agent_ask','agent_review','agent_investigate','agent_implement'])for(const key of ['model','effort','provider_options'])assert.ok(list.tools.find(t=>t.name===name)?.inputSchema.properties?.[key]);
 console.log('TOOLS',list.tools.map(t=>t.name));console.log('STATUS',JSON.stringify(value));
}finally{await c.close();}
