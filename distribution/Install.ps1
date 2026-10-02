[CmdletBinding()]
param(
    [string]$NodeExecutable,
    [string]$GatewayDirectory = (Join-Path $env:LOCALAPPDATA 'Programs\Agent ACP MCP'),
    [string]$MonitorDirectory = (Join-Path $env:LOCALAPPDATA 'Programs\Agent Monitor'),
    [switch]$NoShortcuts
)
$ErrorActionPreference = 'Stop'
function WriteUtf8($Path, $Value) { [IO.File]::WriteAllText($Path, $Value, (New-Object Text.UTF8Encoding($false))) }
function Json($Value) { ConvertTo-Json -InputObject $Value -Depth 12 -Compress }
function AssertNoLinks([string]$Path) {
    $cursor=$Path
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) { if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse point is not allowed: $cursor" } }
        $parent=Split-Path -Parent $cursor; if ($parent -eq $cursor) { break }; $cursor=$parent
    }
}
if (-not $NodeExecutable) {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { throw 'Install Node.js 24 LTS first: https://nodejs.org/en/download' }
    $NodeExecutable = $nodeCommand.Source
}
$NodeExecutable = (Resolve-Path -LiteralPath $NodeExecutable).ProviderPath
$nodeVersion = & $NodeExecutable -p 'process.versions.node'
if ($LASTEXITCODE -ne 0 -or [version]$nodeVersion -lt [version]'22.12.0') { throw 'Node.js 22.12+ required (24 LTS recommended).' }
if ((& $NodeExecutable -p 'process.arch') -ne 'x64') { throw 'Windows x64 and x64 Node.js required.' }
$GatewayDirectory = [IO.Path]::GetFullPath($GatewayDirectory)
$MonitorDirectory = [IO.Path]::GetFullPath($MonitorDirectory)
foreach ($target in @($GatewayDirectory,$MonitorDirectory)) {
    if (Test-Path -LiteralPath $target) { throw "Destination already exists: $target. Stop jobs and back up/rename the old installation first. Nothing was overwritten." }
}
if ($GatewayDirectory -eq $MonitorDirectory -or $GatewayDirectory.StartsWith($MonitorDirectory+'\',[StringComparison]::OrdinalIgnoreCase) -or $MonitorDirectory.StartsWith($GatewayDirectory+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Installation destinations must be separate.' }
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -Raw | ConvertFrom-Json
$releaseInfo=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'release-info.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($releaseInfo.schemaVersion -ne 1 -or [string]$releaseInfo.version -notmatch '^\d+\.\d+\.\d+$' -or [string]$releaseInfo.components.gateway -notmatch '^\d+\.\d+\.\d+$' -or [string]$releaseInfo.components.monitor -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid release information.' }
$known=@{}
AssertNoLinks $PSScriptRoot
foreach ($entry in $manifest.files) {
    if (-not $entry.path -or [IO.Path]::IsPathRooted([string]$entry.path) -or ([string]$entry.path).Contains(':')) { throw 'Invalid manifest path.' }
    $candidate = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot $entry.path))
    if (-not $candidate.StartsWith($PSScriptRoot+'\',[StringComparison]::OrdinalIgnoreCase) -or $known.ContainsKey($candidate)) { throw 'Invalid or duplicate manifest path.' }
    AssertNoLinks $candidate
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw "Missing file: $($entry.path)" }
    if ((Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash -ne $entry.sha256) { throw "Checksum mismatch: $($entry.path)" }
    $known[$candidate]=$true
}
foreach ($file in Get-ChildItem -LiteralPath $PSScriptRoot -Recurse -Force -File) { if ($file.FullName -ne (Join-Path $PSScriptRoot 'manifest.json') -and -not $known.ContainsKey($file.FullName)) { throw "Unlisted release file: $($file.FullName)" } }
New-Item -ItemType Directory -Path (Split-Path -Parent $GatewayDirectory),(Split-Path -Parent $MonitorDirectory) -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'gateway') -Destination $GatewayDirectory -Recurse
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'monitor') -Destination $MonitorDirectory -Recurse
$providerEnv = [ordered]@{
    GROK_ENABLED='true'; CLAUDE_ENABLED='true'; CODEX_ENABLED='true'
    GROK_MODEL='auto'; GROK_EFFORT='auto'
    CLAUDE_MODEL='auto'; CLAUDE_EFFORT='auto'
    CODEX_MODEL='auto'; CODEX_EFFORT='auto'
    CODEX_WINDOWS_SANDBOX='unelevated'; CODEX_IMPLEMENT_SANDBOX='workspace-write'
}
$grokPath = Join-Path $env:USERPROFILE '.grok\bin\grok.exe'
if (Test-Path -LiteralPath $grokPath -PathType Leaf) { $providerEnv.GROK_CLI=$grokPath }
foreach ($providerName in @('claude','codex')) {
    $candidate = Get-Command ($providerName+'.exe'),($providerName+'.cmd') -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($candidate) { $providerEnv[($providerName.ToUpperInvariant()+'_CLI')]=$candidate.Source }
}
$configDir = Join-Path $GatewayDirectory 'configuration'
New-Item -ItemType Directory -Path $configDir | Out-Null
$entryPoint = Join-Path $GatewayDirectory 'dist\src\index.js'
$toml = @(
    '# Merge these tables into config.toml. Do not duplicate an existing agent table.'
    '[mcp_servers.agent]'
    ('command = '+(Json $NodeExecutable))
    ('args = ['+(Json $entryPoint)+']')
    'enabled = true'
    'startup_timeout_sec = 30'
    'tool_timeout_sec = 180'
    ''
    '[mcp_servers.agent.env]'
)
foreach ($key in $providerEnv.Keys) { $toml += "$key = $(Json $providerEnv[$key])" }
WriteUtf8 (Join-Path $configDir 'config.codex.toml') ($toml -join [Environment]::NewLine)
$server = [ordered]@{command=$NodeExecutable;args=@($entryPoint);env=$providerEnv}
$claudeConfig = [ordered]@{mcpServers=[ordered]@{agent=$server}}
WriteUtf8 (Join-Path $configDir 'claude_desktop_config.json') ($claudeConfig | ConvertTo-Json -Depth 12)
WriteUtf8 (Join-Path $configDir 'claude-code.mcp.json') ($claudeConfig | ConvertTo-Json -Depth 12)
WriteUtf8 (Join-Path $MonitorDirectory 'agent-monitor.config.json') ([ordered]@{gatewayRoot=$GatewayDirectory;nodeExecutable=$NodeExecutable;env=$providerEnv} | ConvertTo-Json -Depth 12)
if (-not $NoShortcuts) {
    $shortcutFile = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Agent Monitor.lnk'
    if (Test-Path -LiteralPath $shortcutFile) {
        Write-Warning 'Existing desktop shortcut was preserved.'
    } else {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($shortcutFile)
        $shortcut.TargetPath = Join-Path $MonitorDirectory 'Agent Monitor.exe'
        $shortcut.WorkingDirectory = $MonitorDirectory
        $shortcut.Description = 'Independent agent usage monitor'
        $shortcut.Save()
    }
}
$installedAt=[DateTime]::UtcNow.ToString('o')
$receipt=[ordered]@{schemaVersion=1;version=[string]$releaseInfo.version;components=[ordered]@{gateway=[string]$releaseInfo.components.gateway;monitor=[string]$releaseInfo.components.monitor};installedAt=$installedAt}
$receiptText=$receipt | ConvertTo-Json -Depth 5 -Compress
$gatewayReceipt=Join-Path $GatewayDirectory 'release-receipt.json'
$monitorReceipt=Join-Path $MonitorDirectory 'release-receipt.json'
try {
    WriteUtf8 $gatewayReceipt $receiptText
    WriteUtf8 $monitorReceipt $receiptText
} catch {
    foreach ($receiptPath in @($gatewayReceipt,$monitorReceipt)) { if (Test-Path -LiteralPath $receiptPath) { Remove-Item -LiteralPath $receiptPath -Force -ErrorAction SilentlyContinue } }
    throw
}
Write-Host "Installed gateway: $GatewayDirectory"
Write-Host "Installed monitor: $MonitorDirectory"
Write-Host "Generated examples: $configDir"
Write-Host 'Existing host configuration and global instructions were NOT modified. Follow README.md to merge examples.'
Write-Host 'Log in with your own provider accounts. No CLI was installed or updated.'

