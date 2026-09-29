[CmdletBinding()]
param(
    [string]$SigningKey = (Join-Path $env:USERPROFILE '.agent-acp-mcp-signing\release-ed25519-private.pem'),
    [string]$NodeExecutable,
    [string]$NpmCli,
    [string]$GhExecutable,
    [string]$PublishedAt,
    [switch]$UseExistingBuild,
    [switch]$DraftOnly,
    [switch]$FinalizeDraft
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
if ($FinalizeDraft -and ($DraftOnly -or $UseExistingBuild)) { throw '-FinalizeDraft cannot be combined with -DraftOnly or -UseExistingBuild.' }
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$package = Get-Content -LiteralPath (Join-Path $repository 'package.json') -Raw | ConvertFrom-Json
$version = [string]$package.version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid root release version.' }
$tag = 'v'+$version
$archive = 'Agent-ACP-MCP-Windows-'+$version+'.zip'
$repoName = 'qkrguswnd133/agent-acp-mcp'
$assets = @($archive,'update-manifest.json','update-manifest.sig',($archive + '.sha256'))
$output = Join-Path $repository ('build\release\'+$tag)
if (-not $NodeExecutable) { $NodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source }
if (-not $GhExecutable) { $GhExecutable = (Get-Command gh.exe -ErrorAction Stop).Source }
$NodeExecutable = (Resolve-Path -LiteralPath $NodeExecutable).ProviderPath
$GhExecutable = (Resolve-Path -LiteralPath $GhExecutable).ProviderPath
function AssertCommand([string]$Message) { if ($LASTEXITCODE -ne 0) { throw $Message } }
function VerifyAssets([string]$Directory,[string]$Head) {
    & $NodeExecutable (Join-Path $repository 'scripts\verify-build.mjs') $output $Head $Directory
    AssertCommand 'Asset provenance does not match tested commit.'
    & $NodeExecutable (Join-Path $repository 'scripts\verify-assets.mjs') $Directory (Join-Path $repository 'monitor\update\trusted-key.pem')
    AssertCommand 'Release signature or checksum verification failed.'
}
function GetRelease {
    # GitHub's tag lookup can return 404 for an authenticated draft. The
    # authenticated list endpoint includes drafts and supports pagination.
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $response = @(& $GhExecutable api --paginate --slurp ('repos/'+$repoName+'/releases?per_page=100') 2>$null)
    } finally { $ErrorActionPreference = $previousPreference }
    if ($LASTEXITCODE -ne 0) { throw 'Cannot list GitHub releases to verify this tag.' }
    $json = ($response -join "`n").Trim()
    if (-not $json.StartsWith('[') -or -not $json.EndsWith(']')) { throw 'GitHub release list response is invalid.' }
    try { $pages = ConvertFrom-Json -InputObject $json }
    catch { throw 'Cannot parse GitHub release list.' }
    $records = New-Object System.Collections.ArrayList
    function VisitReleaseNode($Node,$List) {
        if ($null -eq $Node) { return }
        if ($Node -is [array]) { foreach ($child in $Node) { VisitReleaseNode $child $List }; return }
        if ($Node -is [pscustomobject] -and $Node.PSObject.Properties.Name -contains 'tag_name') { [void]$List.Add($Node); return }
        throw 'GitHub release list has an unexpected shape.'
    }
    VisitReleaseNode $pages $records
    $matching = @($records | Where-Object { [string]$_.tag_name -eq $tag })
    if ($matching.Count -gt 1) { throw 'GitHub returned duplicate releases for this tag.' }
    if ($matching.Count -eq 1) { return $matching[0] }
    return $null
}
function AssertReleaseAssets($Release) {
    $names = @($Release.assets | ForEach-Object { [string]$_.name } | Sort-Object)
    $expected = @($assets | Sort-Object)
    if (($names -join "`n") -ne ($expected -join "`n")) { throw 'GitHub release asset names do not match the expected set.' }
}
Push-Location -LiteralPath $repository
try {
    $status = @(git status --porcelain=v1 --untracked-files=all)
    AssertCommand 'Cannot inspect working tree.'
    if ($status.Count) { throw 'Commit all source changes before publishing; the working tree must be clean.' }
    $branch = (@(git branch --show-current) -join "`n").Trim()
    AssertCommand 'Cannot inspect current branch.'
    if ($branch.Trim() -ne 'main') { throw 'Publish from main.' }
    $head = (@(git rev-parse HEAD) -join "`n").Trim()
    AssertCommand 'Cannot inspect HEAD.'
    $originUrl = (@(git remote get-url origin) -join "`n").Trim()
    AssertCommand 'Cannot inspect origin URL.'
    if ($originUrl.Trim() -notin @('https://github.com/qkrguswnd133/agent-acp-mcp.git','https://github.com/qkrguswnd133/agent-acp-mcp','git@github.com:qkrguswnd133/agent-acp-mcp.git')) { throw 'Origin must be the public qkrguswnd133/agent-acp-mcp repository.' }
    $remoteMain = (@(git ls-remote origin refs/heads/main) -join "`n").Trim()
    AssertCommand 'Cannot verify origin/main.'
    if (($remoteMain.Trim() -split '\s+')[0] -ne $head) { throw 'Push this commit to origin/main before publishing.' }
    $localTag = (@(git tag --list $tag) -join "`n").Trim()
    AssertCommand 'Cannot inspect local tag.'
    if ($localTag.Trim()) {
        $localCommit = (@(git rev-list -n 1 $tag) -join "`n").Trim()
        AssertCommand 'Cannot resolve local tag.'
        if ($localCommit.Trim() -ne $head) { throw 'Local release tag points to a different commit.' }
    }
    $remotePeeled = (@(git ls-remote origin ('refs/tags/'+$tag+'^{}')) -join "`n").Trim()
    AssertCommand 'Cannot inspect remote tag.'
    $remoteTag = (@(git ls-remote origin ('refs/tags/'+$tag)) -join "`n").Trim()
    AssertCommand 'Cannot inspect remote tag.'
    $remoteCommit = if ($remotePeeled.Trim()) { ($remotePeeled.Trim() -split '\s+')[0] } elseif ($remoteTag.Trim()) { ($remoteTag.Trim() -split '\s+')[0] } else { '' }
    if ($remoteCommit -and $remoteCommit -ne $head) { throw 'Remote release tag points to a different commit.' }
    & $GhExecutable auth status 1>$null 2>$null
    AssertCommand 'GitHub CLI authentication is required.'
    $release = GetRelease
    if ($FinalizeDraft) {
        if (-not $release -or -not $release.draft) { throw 'A draft release for this tag is required to finalize.' }
    } elseif ($release) { throw 'Release already exists; refusing to replace it.' }
    if (-not $FinalizeDraft -and -not $UseExistingBuild) {
        $buildArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $PSScriptRoot 'Build-Release.ps1'),'-SigningKey',$SigningKey,'-NodeExecutable',$NodeExecutable)
        if ($NpmCli) { $buildArgs += @('-NpmCli',$NpmCli) }
        if ($PublishedAt) { $buildArgs += @('-PublishedAt',$PublishedAt) }
        & powershell.exe @buildArgs
        AssertCommand 'Release build or tests failed.'
    }
    VerifyAssets $output $head
    if (-not $FinalizeDraft) {
        if (-not $localTag.Trim() -and -not $remoteCommit) {
            git tag -a $tag -m ('Agent ACP MCP '+$version)
            AssertCommand 'Could not create release tag.'
        }
        if (-not $remoteCommit) {
            git push origin ('refs/tags/'+$tag)
            AssertCommand 'Could not push release tag.'
        }
    }
    $download = Join-Path ([IO.Path]::GetTempPath()) ('agent-acp-release-check-'+[guid]::NewGuid().ToString('N'))
    $notes = $null
    try {
        if (-not $FinalizeDraft) {
            $notes = New-TemporaryFile
            $releaseManifest = Get-Content -LiteralPath (Join-Path $output 'update-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
            $bodyLines = @(
                "Gateway $($releaseManifest.components.gateway) and Agent Monitor $($releaseManifest.components.monitor) for Windows x64.",
                '',
                'Gateway'
            )
            $bodyLines += @($releaseManifest.notes.gateway | ForEach-Object { '- '+[string]$_ })
            $bodyLines += @('','Agent Monitor')
            $bodyLines += @($releaseManifest.notes.monitor | ForEach-Object { '- '+[string]$_ })
            $bodyLines += @(
                '',
                'Download the ZIP and verify its SHA-256 checksum before running Install.ps1 or Update.ps1. The monitor verifies the detached Ed25519 signature on update metadata and the ZIP checksum before offering an update.',
                '',
                'Node.js 22.12+ x64 and separately installed, authenticated provider CLIs are required. No provider credentials are included.'
            )
            $body = $bodyLines -join [Environment]::NewLine
            [IO.File]::WriteAllText($notes.FullName,$body,(New-Object Text.UTF8Encoding($false)))
            $assetPaths = @($assets | ForEach-Object { Join-Path $output $_ })
            & $GhExecutable release create $tag @assetPaths --repo $repoName --verify-tag --draft --title ('Agent ACP MCP '+$version) --notes-file $notes.FullName
            AssertCommand 'Draft release creation failed.'
            $release = GetRelease
            if (-not $release -or -not $release.draft) { throw 'Cannot verify newly created draft release.' }
        }
        AssertReleaseAssets $release
        New-Item -ItemType Directory -Path $download | Out-Null
        & $GhExecutable release download $tag --repo $repoName --dir $download --pattern '*'
        AssertCommand 'Draft asset download failed.'
        VerifyAssets $download $head
        $finalPeeled = (@(git ls-remote origin ('refs/tags/'+$tag+'^{}')) -join "`n").Trim()
        AssertCommand 'Cannot recheck release tag.'
        $finalLightweight = (@(git ls-remote origin ('refs/tags/'+$tag)) -join "`n").Trim()
        AssertCommand 'Cannot recheck release tag.'
        $finalCommit = if ($finalPeeled.Trim()) { ($finalPeeled.Trim() -split '\s+')[0] } elseif ($finalLightweight.Trim()) { ($finalLightweight.Trim() -split '\s+')[0] } else { '' }
        if ($finalCommit -ne $head) { throw 'Release tag changed before publication.' }
        if ($DraftOnly) {
            Write-Host "Verified draft release $tag; publication deferred by -DraftOnly."
        } else {
            & $GhExecutable release edit $tag --repo $repoName --draft=false
            AssertCommand 'Draft passed verification but publication failed; review the draft release.'
            Write-Host "Published https://github.com/$repoName/releases/tag/$tag"
        }
    } finally {
        if ($notes -and (Test-Path -LiteralPath $notes.FullName)) { Remove-Item -LiteralPath $notes.FullName -Force }
        $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
        if ((Test-Path -LiteralPath $download) -and $download.StartsWith($tempRoot+'\',[StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $download) -match '^agent-acp-release-check-[0-9a-f]{32}$') {
            Remove-Item -LiteralPath $download -Recurse -Force
        }
    }
} finally { Pop-Location }
