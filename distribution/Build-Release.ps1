[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$SigningKey,
    [string]$NodeExecutable,
    [string]$NpmCli,
    [string]$PublishedAt = ([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')),
    [switch]$SkipTests
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$releasePackage = Get-Content -LiteralPath (Join-Path $repository 'package.json') -Raw | ConvertFrom-Json
$releaseVersion = [string]$releasePackage.version
if ($releaseVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid root release version.' }
if (-not $NodeExecutable) { $NodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source }
$NodeExecutable = (Resolve-Path -LiteralPath $NodeExecutable).ProviderPath
$SigningKey = (Resolve-Path -LiteralPath $SigningKey).ProviderPath
if ($SigningKey.StartsWith($repository+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Signing key must be outside the repository.' }
$version = & $NodeExecutable -p 'process.versions.node'
if ($LASTEXITCODE -ne 0 -or [version]$version -lt [version]'22.12.0') { throw 'Node.js 22.12+ x64 is required.' }
if ((& $NodeExecutable -p 'process.arch') -ne 'x64') { throw 'x64 Node.js is required.' }
if (-not $NpmCli) {
    $npmCommand = Get-Command npm.cmd -ErrorAction Stop
    $NpmCli = Join-Path (Split-Path -Parent $npmCommand.Source) 'node_modules\npm\bin\npm-cli.js'
}
$NpmCli = (Resolve-Path -LiteralPath $NpmCli).ProviderPath
$env:PATH = (Split-Path -Parent $NodeExecutable) + ';' + $env:PATH
function Node([string[]]$Arguments) {
    & $NodeExecutable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Node command failed: $($Arguments -join ' ')" }
}
function Npm([string]$WorkingDirectory,[string[]]$Arguments) {
    Push-Location -LiteralPath $WorkingDirectory
    try { Node (@($NpmCli)+$Arguments) }
    finally { Pop-Location }
}
$output = [IO.Path]::GetFullPath((Join-Path $repository ('build\release\v'+$releaseVersion)))
$expected = [IO.Path]::GetFullPath((Join-Path $repository ('build\release\v'+$releaseVersion)))
if ($output -ne $expected -or -not $output.StartsWith($repository+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe release output path.' }
foreach ($candidate in @((Join-Path $repository 'build'),(Join-Path $repository 'build\release'),$output)) {
    if ((Test-Path -LiteralPath $candidate) -and ((Get-Item -LiteralPath $candidate -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Release output path contains a link: $candidate" }
}
if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Recurse -Force }
New-Item -ItemType Directory -Path $output -Force | Out-Null
Npm (Join-Path $repository 'gateway') @('ci','--no-audit','--no-fund')
Npm (Join-Path $repository 'monitor') @('ci','--no-audit','--no-fund')
Node @((Join-Path $repository 'scripts\assert-monitor-source.mjs'))
if (-not $SkipTests) {
    Npm (Join-Path $repository 'gateway') @('test')
    Npm (Join-Path $repository 'monitor') @('test')
    Node @((Join-Path $repository 'scripts\release-tests.mjs'))
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repository 'tests\Test-Update.ps1') -NodeExecutable $NodeExecutable
    if ($LASTEXITCODE -ne 0) { throw 'PowerShell updater fixture tests failed.' }
    Npm (Join-Path $repository 'monitor') @('run','smoke')
} else {
    Write-Warning 'Tests skipped by explicit -SkipTests. Use only after the same source revision has passed them.'
    Npm (Join-Path $repository 'gateway') @('run','build')
}
Npm (Join-Path $repository 'monitor') @('run','package')
Node @((Join-Path $repository 'scripts\assemble-release.mjs'))
$payload = Join-Path $output 'payload'
Npm (Join-Path $payload 'gateway') @('ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund')
Node @((Join-Path $repository 'scripts\write-payload-manifest.mjs'))
Node @((Join-Path $repository 'distribution\Verify-Package.mjs'),$payload)
Add-Type -AssemblyName System.IO.Compression
$zipPath = Join-Path $output ('Agent-ACP-MCP-Windows-'+$releaseVersion+'.zip')
$stream = [IO.File]::Open($zipPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try {
    $zip = New-Object IO.Compression.ZipArchive($stream,[IO.Compression.ZipArchiveMode]::Create,$false)
    try {
        $files = @(Get-ChildItem -LiteralPath $payload -Recurse -File | Sort-Object { $_.FullName.Substring($payload.Length+1).Replace('\','/') })
        foreach ($file in $files) {
            if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Link in payload: $($file.FullName)" }
            $relative = $file.FullName.Substring($payload.Length+1).Replace('\','/')
            if ($relative.StartsWith('/') -or $relative.Contains('..')) { throw "Unsafe ZIP name: $relative" }
            $entry = $zip.CreateEntry($relative,[IO.Compression.CompressionLevel]::Optimal)
            $entry.LastWriteTime = [DateTimeOffset]::new(2020,1,1,0,0,0,[TimeSpan]::Zero)
            $inputStream = [IO.File]::OpenRead($file.FullName)
            $entryStream = $entry.Open()
            try { $inputStream.CopyTo($entryStream) }
            finally { $entryStream.Dispose(); $inputStream.Dispose() }
        }
    } finally { $zip.Dispose() }
} finally { $stream.Dispose() }
Node @((Join-Path $repository 'scripts\finalize-release.mjs'),$SigningKey,$PublishedAt)
if (-not $SkipTests) { Node @((Join-Path $repository 'tests\Smoke-Release.mjs'),$output) }
Node @((Join-Path $repository 'scripts\write-provenance.mjs'),([string](-not $SkipTests)).ToLowerInvariant())
Write-Host "Release ready: $output"
