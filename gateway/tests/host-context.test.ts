import test from 'node:test';
import assert from 'node:assert/strict';
import {CLIENT_INFO_META_KEY,PROTOCOL_VERSION_META_KEY,LOG_LEVEL_META_KEY,type McpServer,type ServerContext} from '@modelcontextprotocol/server';
import {detectHost} from '../src/host.js';
const server=(info:unknown)=>({server:{getClientVersion:()=>info}} as unknown as McpServer);
const context=(envelope:object)=>({mcpReq:{envelope:{[PROTOCOL_VERSION_META_KEY]:'2026-07-28',...envelope}}} as unknown as ServerContext);
test('legacy initialize identity remains supported',()=>{
  assert.equal(detectHost(server({name:'Claude Desktop',version:'1'})).host,'claude');
  assert.equal(detectHost(server({name:'codex-mcp-client'})).host,'codex');
  assert.equal(detectHost(server({name:'Claude Desktop'}),{mcpReq:{envelope:{[LOG_LEVEL_META_KEY]:'info'}}} as unknown as ServerContext).host,'claude');
});
test('request identity takes precedence and is never retained across requests',()=>{
  const s=server({name:'codex-mcp-client'});
  assert.equal(detectHost(s,context({[CLIENT_INFO_META_KEY]:{name:'local-agent-mode-agent',version:'2'}})).host,'claude');
  assert.equal(detectHost(s,context({[CLIENT_INFO_META_KEY]:{name:'grok'}})).host,'grok');
  assert.equal(detectHost(s,context({})).host,'unknown');
  assert.equal(detectHost(s,context({[CLIENT_INFO_META_KEY]:{name:'unrecognized-client'}})).host,'unknown');
  assert.equal(detectHost(s).host,'codex');
});
test('malformed request identity cannot fall back to a different initialized host',()=>{
  for(const value of [null,[],42,'claude',{title:'Claude'},{name:42},{name:'   '}]){
    assert.deepEqual(detectHost(server({name:'claude'}),context({[CLIENT_INFO_META_KEY]:value})),{host:'unknown',clientName:'unknown'});
  }
});
