const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {randomUUID}=require('node:crypto');

const prefix='agent-acp-test-run-';
const markerName='.agent-acp-test-owner.json';
function within(root,target){const relative=path.relative(root,target);return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));}
function validateTestSandbox(root,token){
 if(!path.isAbsolute(root)||!path.basename(root).startsWith(prefix)||!token)throw Error('Invalid test sandbox ownership');
 const info=fs.lstatSync(root);
 if(!info.isDirectory()||info.isSymbolicLink()||fs.realpathSync(root)!==root)throw Error('Test sandbox path changed; refusing cleanup');
 const marker=path.join(root,markerName),markerInfo=fs.lstatSync(marker);
 if(!markerInfo.isFile()||markerInfo.isSymbolicLink())throw Error('Test sandbox ownership marker is unsafe');
 const record=JSON.parse(fs.readFileSync(marker,'utf8'));
 if(record.root!==root||record.token!==token||record.schema!==1)throw Error('Test sandbox ownership marker does not match');
 return record;
}
function createTestSandbox(baseDirectory=os.tmpdir()){
 const base=fs.realpathSync(baseDirectory),root=fs.realpathSync(fs.mkdtempSync(path.join(base,prefix))),token=randomUUID();
 const record={schema:1,root,token,ownerPid:process.pid};
 fs.writeFileSync(path.join(root,markerName),JSON.stringify(record),{flag:'wx'});
 for(const leaf of ['tmp','worktrees','state'])fs.mkdirSync(path.join(root,leaf));
 return {root,token,base,cleaned:false};
}
function testEnvironment(sandbox,original=process.env){
 validateTestSandbox(sandbox.root,sandbox.token);
 for(const leaf of ['tmp','worktrees','state']){
  const target=path.join(sandbox.root,leaf);
  if(!within(sandbox.root,target)||fs.lstatSync(target).isSymbolicLink()||fs.realpathSync(target)!==target)throw Error('Test sandbox child directory was redirected');
 }
 return {...original,TEMP:path.join(sandbox.root,'tmp'),TMP:path.join(sandbox.root,'tmp'),TMPDIR:path.join(sandbox.root,'tmp'),
  AGENT_MCP_WORKTREE_DIR:path.join(sandbox.root,'worktrees'),AGENT_MCP_STATE_DIR:path.join(sandbox.root,'state'),
  AGENT_MCP_TEST_SANDBOX_ROOT:sandbox.root,AGENT_MCP_TEST_SANDBOX_TOKEN:sandbox.token};
}
function cleanupTestSandbox(sandbox){
 if(sandbox.cleaned)return;
 validateTestSandbox(sandbox.root,sandbox.token);
 if(path.dirname(sandbox.root)!==sandbox.base||fs.realpathSync(sandbox.base)!==sandbox.base)throw Error('Test sandbox parent changed; refusing cleanup');
 // Remove exactly this run's generated directory. Node removes directory links
 // themselves, without traversing their targets; never scan or prune old roots.
 fs.rmSync(sandbox.root,{recursive:true,force:false,maxRetries:3,retryDelay:100});sandbox.cleaned=true;
}
function installTestSandbox(){
 const root=process.env.AGENT_MCP_TEST_SANDBOX_ROOT,token=process.env.AGENT_MCP_TEST_SANDBOX_TOKEN;
 if(root||token){const inherited={root,token};Object.assign(process.env,testEnvironment(inherited));return inherited;}
 const owned=createTestSandbox();Object.assign(process.env,testEnvironment(owned));
 process.once('exit',()=>{try{cleanupTestSandbox(owned);}catch(error){process.stderr.write(`Test sandbox retained at ${owned.root}: ${error.message}\n`);process.exitCode=1;}});
 return owned;
}
module.exports={createTestSandbox,testEnvironment,cleanupTestSandbox,installTestSandbox,validateTestSandbox};
