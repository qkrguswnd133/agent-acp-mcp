[CmdletBinding()]
param([string]$GatewayRoot = (Join-Path $PSScriptRoot '..\gateway'))
$ErrorActionPreference = 'Stop'
$gatewayDirectory = [IO.Path]::GetFullPath($GatewayRoot)
if (-not (Test-Path -LiteralPath $gatewayDirectory -PathType Container)) { throw 'Gateway directory does not exist.' }
# Refuse redirected source/output parents: the generated launcher must remain in
# this exact gateway tree, including during packaging into a staging directory.
foreach ($relative in @('', 'scripts', 'runtime', 'runtime\codex-shell')) {
    $candidate = if ($relative) { Join-Path $gatewayDirectory $relative } else { $gatewayDirectory }
    if (Test-Path -LiteralPath $candidate) {
        $item = Get-Item -LiteralPath $candidate -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Refusing redirected launcher build path: $candidate" }
    }
}
$source = Join-Path $gatewayDirectory 'scripts\codex-shell-launcher.cs'
$outputDirectory = Join-Path $gatewayDirectory 'runtime\codex-shell'
$output = Join-Path $outputDirectory 'pwsh.exe'
if (Test-Path -LiteralPath $output) {
    if (((Get-Item -LiteralPath $output -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Refusing to overwrite a redirected launcher executable.' }
}
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'The Windows .NET Framework C# compiler is required to build the Codex shell launcher.' }
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
& $compiler /nologo /target:exe /platform:anycpu /optimize+ "/out:$output" $source
if ($LASTEXITCODE -ne 0) { throw 'Codex shell launcher compilation failed.' }
Write-Output $output
