#Requires -Version 5.1
param([Parameter(Mandatory=$true)][string]$RequestFile)
$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0

function FullPath([string]$Value) {
    if (-not $Value -or -not [IO.Path]::IsPathRooted($Value)) { throw 'Absolute update path required.' }
    $path=[IO.Path]::GetFullPath($Value).TrimEnd('\','/')
    if ($path.Length -le 3) { throw 'Drive root is not an update path.' }
    return $path
}
function Inside([string]$Child,[string]$Parent) { return $Child.Equals($Parent,[StringComparison]::OrdinalIgnoreCase) -or $Child.StartsWith($Parent+'\',[StringComparison]::OrdinalIgnoreCase) }
function NoLinks([string]$Path,[switch]$Tree) {
    $cursor=$Path
    while ($cursor) { if (Test-Path -LiteralPath $cursor) { if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse points are not allowed.' } }; $parent=Split-Path -Parent $cursor;if ($parent -eq $cursor) { break }; $cursor=$parent }
    if ($Tree -and (Test-Path -LiteralPath $Path)) { foreach($item in Get-ChildItem -LiteralPath $Path -Recurse -Force) { if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse points are not allowed.' } } }
}
function AtomicJson([string]$Path,$Value) {
    $parent=Split-Path -Parent $Path;if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    $temp=$Path+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
    try { [IO.File]::WriteAllText($temp,(ConvertTo-Json -InputObject $Value -Depth 12 -Compress),(New-Object Text.UTF8Encoding($false)));Move-Item -LiteralPath $temp -Destination $Path -Force }
    finally { if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force } }
}
function VerifyPackage([string]$Package) {
    NoLinks $Package -Tree
    $manifestPath=Join-Path $Package 'manifest.json';$manifest=Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json;$known=@{}
    foreach($entry in $manifest.files) {
        $relative=[string]$entry.path
        if (-not $relative -or [IO.Path]::IsPathRooted($relative) -or $relative.Contains(':')) { throw 'Invalid manifest path.' }
        $file=[IO.Path]::GetFullPath((Join-Path $Package $relative))
        if (-not (Inside $file $Package) -or $file -eq $manifestPath -or $known.ContainsKey($file) -or -not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'Missing or duplicate release file.' }
        if ([string]$entry.sha256 -notmatch '^[0-9a-fA-F]{64}$' -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $entry.sha256) { throw 'Release checksum mismatch.' }
        $known[$file]=$true
    }
    foreach($file in Get-ChildItem -LiteralPath $Package -Recurse -Force -File) { if ($file.FullName -ne $manifestPath -and -not $known.ContainsKey($file.FullName)) { throw 'Unlisted release file.' } }
    $info=Get-Content -LiteralPath (Join-Path $Package 'release-info.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($info.schemaVersion -ne 1 -or [string]$info.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid release information.' }
    return $info
}
function Installed([string]$Kind,[string]$Target) {
    if (-not $Target -or -not (Test-Path -LiteralPath $Target -PathType Container)) { return $false }
    if ($Kind -eq 'Gateway') { try { $p=Get-Content -LiteralPath (Join-Path $Target 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json;return $p.name -eq 'agent-acp-mcp-local' -and (Test-Path -LiteralPath (Join-Path $Target 'dist\src\index.js') -PathType Leaf) } catch { return $false } }
    return (Test-Path -LiteralPath (Join-Path $Target 'Agent Monitor.exe') -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $Target 'resources\app.asar') -PathType Leaf)
}
function MonitorRunning([string]$Target,[string]$DataDir) {
    $exe=Join-Path $Target 'Agent Monitor.exe'
    foreach($p in @(Get-CimInstance Win32_Process -Filter "Name = 'Agent Monitor.exe'" -ErrorAction Stop)) {
        if ([string]$p.ExecutablePath -ine $exe) { continue }
        $match=[regex]::Match([string]$p.CommandLine,'(?:"--data-dir=([^"]+)"|--data-dir=(?:"([^"]+)"|([^\s"]+)))')
        if ($match.Success) { $configured='';foreach($group in @($match.Groups[1],$match.Groups[2],$match.Groups[3])) { if ($group.Success) { $configured=$group.Value;break } };if ($configured -ieq $DataDir) { return $true } }
        elseif ($DataDir -ieq (Join-Path $env:APPDATA 'Agent Monitor')) { return $true }
    }
    return $false
}
function StartMonitor([string]$Target,[string]$DataDir) {
    if (MonitorRunning $Target $DataDir) { return }
    $exe=Join-Path $Target 'Agent Monitor.exe';if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Monitor executable missing.' }
    if ($DataDir.Contains('"')) { throw 'Invalid data path.' }
    # Same WMI launch mechanism as scripts/Start-Standalone.ps1, with profile isolation.
    $startup=New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}
    $created=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=('"'+$exe+'" "--data-dir='+$DataDir+'"');CurrentDirectory=$Target;ProcessStartupInformation=$startup}
    if ($created.ReturnValue -ne 0) { throw 'Independent monitor restart failed.' }
}
function SafeDisplay([string]$Value) {
    $clean=($Value -replace '[\x00-\x1f\x7f]',' ').Trim()
    if ($clean.Length -gt 700) { return $clean.Substring(0,700)+'...' }
    return $clean
}
function RecoveryMessage($Result,[string]$ResultFile,[string[]]$Targets) {
    $lines=@('Automatic update rollback was incomplete. Do not start Agent Monitor or retry the update until the installation is restored.','','Installation directories:')
    foreach($target in $Targets) { $lines+=('  '+(SafeDisplay $target)) }
    $lines+=@('','New backup directories:')
    if (@($Result.backups).Count) { foreach($backup in @($Result.backups)) { $lines+=('  '+(SafeDisplay ([string]$backup))) } }
    else { $lines+='  None found. Inspect the installation directories before taking action.' }
    $lines+=@('','Inspect the backups and restore the original installation manually. Result details: '+(SafeDisplay $ResultFile))
    $message=$lines -join [Environment]::NewLine
    if ($message.Length -gt 3500) { return $message.Substring(0,3500) }
    return $message
}
# A function already defined by the caller can observe this UI boundary in tests.
# Production launches use -NoProfile and the default implementation below.
if (-not (Get-Command ShowRecoveryDialog -CommandType Function -ErrorAction SilentlyContinue)) {
    function ShowRecoveryDialog([string]$Message) {
        Add-Type -AssemblyName System.Windows.Forms
        [void][System.Windows.Forms.MessageBox]::Show($Message,'Agent ACP MCP update recovery',[System.Windows.Forms.MessageBoxButtons]::OK,[System.Windows.Forms.MessageBoxIcon]::Error)
    }
}
function PersistOutcome($Result,[string]$ResultFile,[string]$HistoryFile) {
    if ($ResultFile) { try { AtomicJson $ResultFile $Result } catch { Write-Warning 'Could not persist update result.' } }
    if ($HistoryFile) {
        try {
            $entries=@();if (Test-Path -LiteralPath $HistoryFile) { $entries=@(Get-Content -LiteralPath $HistoryFile -Raw -Encoding UTF8 | ConvertFrom-Json) }
            $entries=@($Result)+@($entries | Where-Object {$_.operationId -ne $Result.operationId} | Select-Object -First 49)
            AtomicJson $HistoryFile $entries
        } catch { Write-Warning 'Could not persist update history.' }
    }
}

$result=[ordered]@{schemaVersion=1;operationId=$null;status='failed';version=$null;startedAt=[DateTime]::UtcNow.ToString('o');finishedAt=$null;message='Update failed validation.';backups=@()}
$resultFile=$null;$historyFile=$null;$monitor=$null;$gateway=$null;$userData=$null;$wasRunning=$false
try {
    $RequestFile=FullPath $RequestFile;NoLinks $RequestFile
    $request=Get-Content -LiteralPath $RequestFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($request.schemaVersion -ne 1 -or [string]$request.operationId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { throw 'Invalid update request.' }
    $result.operationId=[string]$request.operationId
    $package=FullPath ([string]$request.packageDirectory)
    $gateway=if ($request.PSObject.Properties['gatewayDirectory'] -and $request.gatewayDirectory) { FullPath ([string]$request.gatewayDirectory) } else { $null }
    $monitor=FullPath ([string]$request.monitorDirectory)
    $node=FullPath ([string]$request.nodeExecutable)
    $resultFile=FullPath ([string]$request.resultFile)
    $userData=FullPath ([string]$request.userDataDir)
    $historyFile=Join-Path $userData 'updates\history.json'
    foreach($path in @($package,$gateway,$monitor,$userData,$resultFile,$historyFile,$node) | Where-Object {$_}) { NoLinks $path }
    if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'Node executable missing.' }
    if ($gateway -and ((Inside $gateway $monitor) -or (Inside $monitor $gateway))) { throw 'Installation paths overlap.' }
    foreach($target in @($gateway,$monitor) | Where-Object {$_}) {
        if ((Inside $target $package) -or (Inside $package $target) -or (Inside $target $userData) -or (Inside $userData $target) -or (Inside $target $resultFile) -or (Inside $resultFile $target)) { throw 'Unsafe overlapping update paths.' }
    }
    if ((Inside $resultFile $package) -or (Inside $package $resultFile) -or (Inside $userData $package)) { throw 'Unsafe output path.' }
    $info=VerifyPackage $package;$result.version=[string]$info.version
    $hasGateway=$gateway -and (Installed 'Gateway' $gateway);$hasMonitor=Installed 'Monitor' $monitor
    if (-not $hasGateway -and -not $hasMonitor) { throw 'No installed component found.' }
    $wasRunning=$hasMonitor -and (MonitorRunning $monitor $userData)
    $component=if ($hasGateway -and $hasMonitor) {'All'} elseif ($hasGateway) {'Gateway'} else {'Monitor'}
    $beforeBackups=@{}
    foreach($target in @($gateway,$monitor) | Where-Object {$_}) { $parent=Split-Path -Parent $target;$leaf=Split-Path -Leaf $target;foreach($backup in @(Get-ChildItem -LiteralPath $parent -Directory -Filter ($leaf+'.backup-*') -ErrorAction SilentlyContinue)) { $beforeBackups[$backup.FullName]=$true } }
    $arguments=@('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $package 'Update.ps1'),'-NodeExecutable',$node,'-Component',$component,'-MonitorDirectory',$monitor,'-MonitorDataDirectory',$userData)
    if ($hasGateway) { $arguments+=@('-GatewayDirectory',$gateway) }
    $ErrorActionPreference='Continue';$output=(& powershell.exe @arguments 2>&1 | Out-String);$code=$LASTEXITCODE;$ErrorActionPreference='Stop'
    # Only newly created siblings of selected installation targets are recovery backups.
    foreach($target in @($gateway,$monitor) | Where-Object {$_}) { $parent=Split-Path -Parent $target;$leaf=Split-Path -Leaf $target;foreach($backup in @(Get-ChildItem -LiteralPath $parent -Directory -Filter ($leaf+'.backup-*') -ErrorAction SilentlyContinue)) { if (-not $beforeBackups.ContainsKey($backup.FullName)) { $result.backups+=@($backup.FullName) } } }
    if ($code -eq 0) {
        $result.status='success';$result.message='Installed components updated.'
    } elseif ($output -match 'Automatic rollback was incomplete' -or @($result.backups).Count) { $result.status='rollback_failed';$result.message='Automatic rollback incomplete. Keep Agent Monitor closed; inspect the backup directories and restore the original installation before retrying.' }
    elseif ($output -match 'in use|busy|did not acknowledge|Unfinished job|active child|maintenance|not exit|restarted') { $result.status='blocked';$result.message='Update blocked by an active component.' }
    elseif ($output -match 'Original installation paths were preserved/restored') { $result.status='rolled_back';$result.message='Update failed; original installations restored.' }
    else { $result.status='failed';$result.message='Update failed before completion.' }
} catch { $result.status='failed';$result.message='Update request or package validation failed.' }
finally {
    $result.finishedAt=[DateTime]::UtcNow.ToString('o')
    PersistOutcome $result $resultFile $historyFile
    if ($result.status -eq 'rollback_failed') {
        $targetPaths=@(@($gateway,$monitor) | Where-Object {$_})
        try { ShowRecoveryDialog (RecoveryMessage $result $resultFile $targetPaths) } catch { Write-Warning 'Could not show recovery dialog; inspect the update result file.' }
    }
    if ($wasRunning -and $result.status -ne 'rollback_failed' -and $monitor -and (Installed 'Monitor' $monitor)) {
        try { StartMonitor $monitor $userData }
        catch {
            $result.message+=' Monitor restart failed. Open the installation manually after checking the result file.'
            PersistOutcome $result $resultFile $historyFile
            try { ShowRecoveryDialog ('Agent Monitor could not restart. Inspect the update result at '+(SafeDisplay $resultFile)+'.') } catch { Write-Warning 'Could not show monitor restart warning.' }
        }
    }
}
if ($result.status -ne 'success') { exit 1 }
