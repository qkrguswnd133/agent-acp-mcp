[CmdletBinding()]
param(
    [string]$NodeExecutable,
    [string]$PrivateKey = (Join-Path $env:USERPROFILE '.agent-acp-mcp-signing\release-ed25519-private.pem'),
    [string]$PublicKey = (Join-Path $PSScriptRoot '..\monitor\update\trusted-key.pem')
)
$ErrorActionPreference = 'Stop'
if (-not $NodeExecutable) { $NodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source }
$NodeExecutable = (Resolve-Path -LiteralPath $NodeExecutable).ProviderPath
$script = Join-Path $PSScriptRoot '..\scripts\create-signing-key.mjs'
& $NodeExecutable $script $PrivateKey $PublicKey
if ($LASTEXITCODE -ne 0) { throw 'Signing key generation failed.' }
Write-Host 'Back up the private key securely. The public key belongs in the monitor source and release.'
