import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

function runPowerShell(command) {
  return spawnSync('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{encoding:'utf8'});
}

test('first-release Git lookups yield empty strings for absent local and remote tags',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'agent-release-tag-test-'));
  try {
    const remote=path.join(root,'remote.git');
    const work=path.join(root,'work');
    const git=(cwd,...args)=>execFileSync('git',args,{cwd,stdio:'pipe'});
    git(root,'init','--bare',remote);
    git(root,'init','-b','main',work);
    git(work,'config','user.name','Release Test');
    git(work,'config','user.email','release-test@example.invalid');
    git(work,'commit','--allow-empty','-m','initial');
    git(work,'remote','add','origin',remote);
    git(work,'push','-u','origin','main');
    const command=`$ErrorActionPreference='Stop'; Set-Location -LiteralPath '${work.replaceAll("'","''")}'; $tag='v9.9.9'; $localTag = (@(git tag --list $tag) -join "\`n").Trim(); if ($LASTEXITCODE -ne 0) { throw 'local lookup failed' }; $remotePeeled = (@(git ls-remote origin ('refs/tags/'+$tag+'^{}')) -join "\`n").Trim(); if ($LASTEXITCODE -ne 0) { throw 'peeled lookup failed' }; $remoteTag = (@(git ls-remote origin ('refs/tags/'+$tag)) -join "\`n").Trim(); if ($LASTEXITCODE -ne 0) { throw 'remote lookup failed' }; if ($null -eq $localTag -or $null -eq $remotePeeled -or $null -eq $remoteTag -or $localTag.Length -ne 0 -or $remotePeeled.Length -ne 0 -or $remoteTag.Length -ne 0) { throw 'absent tag was not an empty string' }; Write-Output 'EMPTY_TAG_OUTPUT_OK'`;
    const result=runPowerShell(command);
    assert.equal(result.status,0,result.stderr||result.stdout);
    assert.match(result.stdout,/EMPTY_TAG_OUTPUT_OK/);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('publisher assembles exactly four correctly named release assets',()=>{
  const publisher=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','distribution','Publish-Release.ps1');
  const command=`$ErrorActionPreference='Stop'; $tokens=$null; $errors=$null; $ast=[System.Management.Automation.Language.Parser]::ParseFile('${publisher.replaceAll("'","''")}',[ref]$tokens,[ref]$errors); if($errors.Count){throw 'publisher syntax error'}; $assignments=@($ast.FindAll({param($node) $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -eq '$assets'},$true)); if($assignments.Count -ne 1){throw 'publisher asset assignment missing'}; $archive='Agent-ACP-MCP-Windows-2.2.0.zip'; Invoke-Expression $assignments[0].Extent.Text; $expected=@($archive,'update-manifest.json','update-manifest.sig',($archive+'.sha256')); if($assets.Count -ne 4 -or (($assets -join '|') -ne ($expected -join '|'))){throw ('wrong assets: '+($assets -join '|'))}; Write-Output 'ASSET_NAMES_OK'`;
  const result=runPowerShell(command);
  assert.equal(result.status,0,result.stderr||result.stdout);
  assert.match(result.stdout,/ASSET_NAMES_OK/);
});
