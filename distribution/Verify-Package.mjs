import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=path.resolve(process.argv[2] || path.dirname(fileURLToPath(import.meta.url)));
const manifest=JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8'));
if(manifest.platform!=='win32-x64'||!Array.isArray(manifest.files)) throw new Error('Invalid package manifest');
const actual=[];
async function walk(directory,relative='') {
  for(const entry of await fs.readdir(directory,{withFileTypes:true})) {
    const rel=relative ? `${relative}/${entry.name}` : entry.name;
    const full=path.join(directory,entry.name);
    const stat=await fs.lstat(full);
    if(stat.isSymbolicLink()) throw new Error(`Link in package: ${rel}`);
    if(stat.isDirectory()) await walk(full,rel);
    else if(stat.isFile()&&rel!=='manifest.json') actual.push(rel);
    else if(!stat.isFile()) throw new Error(`Unsupported package entry: ${rel}`);
  }
}
await walk(root);
const listed=[];
for(const item of manifest.files) {
  const rel=item.path;
  if(typeof rel!=='string'||!rel||rel.includes('\\')||rel.includes(':')||rel.split('/').some(part=>!part||part==='.'||part==='..')) throw new Error(`Unsafe package manifest path: ${rel}`);
  const file=path.join(root,...rel.split('/'));
  const bytes=await fs.readFile(file);
  if(bytes.length!==item.size||crypto.createHash('sha256').update(bytes).digest('hex')!==item.sha256) throw new Error(`Package checksum mismatch: ${rel}`);
  listed.push(rel);
}
actual.sort(); listed.sort();
if(JSON.stringify(actual)!==JSON.stringify(listed)) throw new Error('Package manifest does not cover every file exactly once');
const info=JSON.parse(await fs.readFile(path.join(root,'release-info.json'),'utf8'));
const gateway=JSON.parse(await fs.readFile(path.join(root,'gateway','package.json'),'utf8'));
if(info.schemaVersion!==1||info.components?.gateway!==manifest.gatewayVersion||info.components?.monitor!==manifest.monitorVersion||gateway.version!==manifest.gatewayVersion) throw new Error('Package release versions are inconsistent');
await fs.access(path.join(root,'monitor','Agent Monitor.exe'));
await fs.access(path.join(root,'monitor','resources','app.asar'));
for(const name of ['managed-worktree','index','codex-shell']) {
  await fs.access(path.join(root,'gateway','src',name+'.ts'));
  await fs.access(path.join(root,'gateway','dist','src',name+'.js'));
}
const {codexShellEnvironment}=await import(pathToFileURL(path.join(root,'gateway','dist','src','codex-shell.js')).href);
const shellEnvironment=await codexShellEnvironment({...process.env,CODEX_POWERSHELL_PATH:''});
assert(shellEnvironment.shell?.startsWith(path.join(root,'gateway','runtime')),'Packaged native PowerShell must be selected');

const clientBase=path.join(root,'gateway','node_modules','@modelcontextprotocol','client','dist');
const {Client}=await import(pathToFileURL(path.join(clientBase,'index.mjs')).href);
const {StdioClientTransport}=await import(pathToFileURL(path.join(clientBase,'stdio.mjs')).href);
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'agent-package-verify-'));
try {
  for(const host of ['codex','claude']) {
    const client=new Client({name:`${host}-package-verifier`,version:'1.0.0'});
    const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'gateway','dist','src','index.js')],env:{...process.env,GROK_ENABLED:'false',CLAUDE_ENABLED:'false',CODEX_ENABLED:'false',AGENT_MCP_STATE_DIR:temp},stderr:'pipe'});
    try {
      await client.connect(transport);
      const listing=await client.listTools();
      assert(listing.tools.some(tool=>tool.name==='agent_implement'));
      assert(listing.tools.some(tool=>tool.name==='agent_models'));
      for(const name of ['agent_worktree_list','agent_worktree_forget','agent_worktree_migrate','agent_worktree_recover','agent_job_wait'])assert(listing.tools.some(tool=>tool.name===name));
      const inventory=await client.callTool({name:'agent_worktree_list',arguments:{limit:1}});
      assert(!inventory.isError);
      assert.equal(JSON.parse(inventory.content.find(item=>item.type==='text').text).total,0);
      assert(listing.tools.find(tool=>tool.name==='agent_ask').inputSchema.properties.selection_reason);
      const modelResponse=await client.callTool({name:'agent_models',arguments:{}});
      assert(!modelResponse.isError);
      const models=JSON.parse(modelResponse.content.find(item=>item.type==='text').text);
      assert.equal(models.discoveryOnly,true);
      for(const item of Object.values(models.providers))assert.equal(item.catalog.status,'unavailable');
      const response=await client.callTool({name:'agent_status',arguments:{}});
      assert(!response.isError);
      const value=JSON.parse(response.content.find(item=>item.type==='text').text);
      const detected=value.host;
      assert.equal(typeof detected==='string'?detected:detected.host,host);
      const providers=Array.isArray(value.providers)?value.providers:Object.values(value.providers);
      assert.equal(providers.length,3);
      for(const provider of providers) { assert.equal(provider.enabled,false); assert.equal(provider.callable,false); }
      console.log(`${host}: MCP handshake, host detection and disabled-provider check PASS`);
    } finally { await client.close(); }
  }
  console.log(`PACKAGE_MCP_OK (${manifest.files.length} checksummed files; no provider calls)`);
} finally { await fs.rm(temp,{recursive:true,force:true}); }
