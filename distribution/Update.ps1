[CmdletBinding(SupportsShouldProcess=$true, ConfirmImpact='Medium')]
param(
    [string]$NodeExecutable,
    [string]$GatewayDirectory = (Join-Path $env:LOCALAPPDATA 'Programs\Agent ACP MCP'),
    [string]$MonitorDirectory = (Join-Path $env:LOCALAPPDATA 'Programs\Agent Monitor'),
    [string]$MonitorDataDirectory,
    [ValidateSet('All','Gateway','Monitor')][string]$Component = 'All',
    [switch]$NoAutoClose
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function FullPath([string]$Value) {
    $result = [IO.Path]::GetFullPath($Value).TrimEnd('\','/')
    if ($result.Length -le 3) { throw "A drive root cannot be an installation directory: $Value" }
    return $result
}
function Inside([string]$Child,[string]$Parent) {
    return $Child.Equals($Parent,[StringComparison]::OrdinalIgnoreCase) -or $Child.StartsWith($Parent+'\',[StringComparison]::OrdinalIgnoreCase)
}
function FileHash([string]$Path) {
    # Windows PowerShell 5.1 Get-FileHash internally invokes ShouldProcess-aware
    # helpers; hash directly so -WhatIf still performs the read-only validation.
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','') }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}
function WriteJsonAtomic([string]$Path,$Value) {
    $temp=$Path+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
    try {
        [IO.File]::WriteAllText($temp,(ConvertTo-Json -InputObject $Value -Depth 8 -Compress),(New-Object Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $temp -Destination $Path -Force
    } finally { if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force } }
}
function ReleaseInfo([string]$Source) {
    $file=Join-Path $Source 'release-info.json'
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'Release information is missing.' }
    $info=Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($info.schemaVersion -ne 1 -or [string]$info.version -notmatch '^\d+\.\d+\.\d+$' -or [string]$info.components.gateway -notmatch '^\d+\.\d+\.\d+$' -or [string]$info.components.monitor -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid release information.' }
    return $info
}
function WriteReceipt($Item,$Info) {
    WriteJsonAtomic (Join-Path $Item.Stage 'release-receipt.json') ([ordered]@{schemaVersion=1;version=[string]$Info.version;components=[ordered]@{gateway=[string]$Info.components.gateway;monitor=[string]$Info.components.monitor};installedAt=[DateTime]::UtcNow.ToString('o')})
}
function AssertNoLinks([string]$Root,[switch]$Tree) {
    $cursor = $Root
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse points are not supported: $cursor" }
        }
        $parent = Split-Path -Parent $cursor
        if ($parent -eq $cursor) { break }; $cursor = $parent
    }
    if ($Tree) {
        foreach ($child in Get-ChildItem -LiteralPath $Root -Force) {
            if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse points are not supported: $($child.FullName)" }
            if ($child.PSIsContainer) { AssertNoLinks $child.FullName -Tree }
        }
    }
}
function InstallationProcesses($Items) {
    $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    foreach ($process in $processes) {
        if ($process.ProcessId -eq $PID) { continue }
        foreach ($item in $Items) {
            $exe = [string]$process.ExecutablePath
            $command = ([string]$process.CommandLine).Replace('/','\')
            $runtime = ([string]$process.Name) -match '^(node|electron|Agent Monitor|claude|codex|grok)(\.exe)?$'
            if (($exe -and (Inside $exe $item.Target)) -or ($runtime -and $command.IndexOf($item.Target+'\',[StringComparison]::OrdinalIgnoreCase) -ge 0)) {
                [pscustomobject]@{Process=$process; Item=$item}
            }
        }
    }
}
function AssertStopped($Items) {
    $remaining = @(InstallationProcesses $Items)
    if ($remaining.Count) {
        $first=$remaining[0]
        throw "Installation is in use (PID $($first.Process.ProcessId), $($first.Process.Name)): $($first.Item.Target). A host may have restarted it. Disconnect MCP and exit Agent Monitor before retrying."
    }
}
function AssertNoActiveJobs([string]$Gateway) {
    $jobs = Join-Path $Gateway 'state\jobs'
    if (-not (Test-Path -LiteralPath $jobs)) { return }
    foreach ($file in Get-ChildItem -LiteralPath $jobs -Force -File) {
        if ($file.Extension -ne '.json') { throw "Job state is being written or is unrecognized: $($file.Name). Finish jobs before updating." }
        try { $job=Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8 | ConvertFrom-Json; $status=[string]$job.status }
        catch { throw "Cannot verify job state: $($file.Name). Automatic shutdown is blocked." }
        if ($status -notin @('completed','failed','cancelled','interrupted')) {
            # A crashed gateway can leave nonterminal records indefinitely.
            # Preserve them; ignore only a verifiably absent owner with no
            # surviving direct children. Missing/malformed ownership fails closed.
            $ownerProperty=$job.PSObject.Properties['ownerPid']
            $jobOwner=0
            if ($status -in @('queued','running','cancelling') -and $ownerProperty -and
                [int]::TryParse([string]$ownerProperty.Value,[ref]$jobOwner) -and $jobOwner -gt 0) {
                $owners=@(Get-CimInstance Win32_Process -Filter "ProcessId = $jobOwner" -ErrorAction Stop)
                if (-not $owners.Count) {
                    $children=@(Get-CimInstance Win32_Process -Filter "ParentProcessId = $jobOwner" -ErrorAction Stop)
                    if (-not $children.Count) {
                        Write-Host "Preserving interrupted job record from exited Gateway PID ${jobOwner}: $($file.Name)"
                        continue
                    }
                    throw "Unfinished job ($status): $($file.Name). Exited Gateway PID $jobOwner still has active child processes."
                }
            }
            throw "Unfinished job ($status): $($file.Name). Wait for completion or cancel it through the parent before updating."
        }
    }
}
function AssertIdleGateway($Entry) {
    $process=$Entry.Process; $gateway=$Entry.Item.Target
    $entryPoint=Join-Path $gateway 'dist\src\index.js'
    $command=([string]$process.CommandLine).Replace('/','\')
    $nodePath=([string]$process.ExecutablePath).Replace('/','\')
    # Require index.js to be the actual entry argument, not a string passed to
    # another Node program. Unusual launch flags require manual disconnection.
    $pattern='^\s*(?:"'+[regex]::Escape($nodePath)+'"|'+[regex]::Escape($nodePath)+'|"?node\.exe"?)\s+(?:"'+[regex]::Escape($entryPoint)+'"|'+[regex]::Escape($entryPoint)+')(?:\s|$)'
    if ($process.Name -ine 'node.exe' -or -not $process.ExecutablePath -or $command -notmatch $pattern) {
        throw "Cannot safely identify Gateway PID $($process.ProcessId). Close its host manually."
    }
    AssertNoActiveJobs $gateway
    # CLI maintenance/status or provider work may precede its job-state write.
    # Never stop a provider tree based merely on an apparently empty job list.
    $children=@(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($process.ProcessId)" -ErrorAction Stop)
    foreach ($child in $children) {
        # Windows may attach a console host even to a hidden idle Node process.
        # This OS console process is not a provider job and exits with its client.
        $console=Join-Path $env:SystemRoot 'System32\conhost.exe'
        $isConsole=([string]$child.ExecutablePath) -ieq $console -and $child.Name -ieq 'conhost.exe'
        if ($isConsole -and -not @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($child.ProcessId)" -ErrorAction Stop).Count) { continue }
        throw "Gateway PID $($process.ProcessId) has active child processes. Wait for provider activity to finish, or disconnect MCP manually."
    }
}
function GatewaySupportsMaintenance([string]$Gateway) {
    try {
        $package=Get-Content -LiteralPath (Join-Path $Gateway 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        return ([version]$package.version -ge [version]'2.2.0')
    } catch { return $false }
}
function WaitForMaintenance([object[]]$Entries,[string]$Gateway) {
    $requestFile=$Gateway+'.maintenance.json'
    $id=[guid]::NewGuid().ToString()
    $ackPrefix=$Gateway+'.maintenance.'+$id+'.'
    $ownerStartedAt=(Get-Process -Id $PID -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString()
    $request=[ordered]@{schemaVersion=1;operationId=$id;ownerPid=$PID;ownerStartedAt=$ownerStartedAt;requestedAt=[DateTime]::UtcNow.ToString('o');expiresAt=[DateTime]::UtcNow.AddMinutes(30).ToString('o');phase='prepare'}
    if (Test-Path -LiteralPath $requestFile) {
        try {
            $existing=Get-Content -LiteralPath $requestFile -Raw -Encoding UTF8 | ConvertFrom-Json
            $expires=[DateTime]::Parse([string]$existing.expiresAt).ToUniversalTime()
            $owner=Get-Process -Id ([int]$existing.ownerPid) -ErrorAction SilentlyContinue
            if ($expires -gt [DateTime]::UtcNow -and $owner -and $existing.PSObject.Properties['ownerStartedAt'] -and $owner.StartTime.ToUniversalTime().Ticks.ToString() -eq [string]$existing.ownerStartedAt) { throw 'Another gateway maintenance request is active.' }
        } catch { if ($_.Exception.Message -eq 'Another gateway maintenance request is active.') { throw } }
        Remove-Item -LiteralPath $requestFile -Force
    }
    WriteJsonAtomic $requestFile $request
    $script:maintenanceLeases+=@([pscustomobject]@{Request=$requestFile;AckPrefix=$ackPrefix})
    try {
        $deadline=[DateTime]::UtcNow.AddSeconds(8)
        do {
            $ready=$true
            foreach ($entry in $Entries) {
                $process=Get-CimInstance Win32_Process -Filter "ProcessId = $($entry.Process.ProcessId)" -ErrorAction Stop
                if (-not $process) { continue }
                if ($process.CreationDate -ne $entry.Process.CreationDate -or $process.ExecutablePath -ne $entry.Process.ExecutablePath) { throw 'Gateway process identity changed during maintenance.' }
                $ackFile=$ackPrefix+$process.ProcessId+'.ack.json'
                if (-not (Test-Path -LiteralPath $ackFile)) { $ready=$false; continue }
                try { $ack=Get-Content -LiteralPath $ackFile -Raw -Encoding UTF8 | ConvertFrom-Json }
                catch { $ready=$false; continue }
                if ($ack.operationId -ne $id -or $ack.gatewayPid -ne $process.ProcessId) { $ready=$false }
            }
            if ($ready) { break }
            Start-Sleep -Milliseconds 150
        } while ([DateTime]::UtcNow -lt $deadline)
        if (-not $ready) { throw 'Gateway is busy or did not acknowledge maintenance; active jobs and provider calls were left running.' }
        $request.phase='commit';WriteJsonAtomic $requestFile $request
        $deadline=[DateTime]::UtcNow.AddSeconds(10)
        do {
            $remaining=@(InstallationProcesses @([pscustomobject]@{Name='Gateway';Target=$Gateway}))
            if (-not $remaining.Count) { break }
            Start-Sleep -Milliseconds 150
        } while ([DateTime]::UtcNow -lt $deadline)
        if ($remaining.Count) { throw 'Gateway did not exit after committing maintenance; update blocked.' }
    } finally { }
}
function CloseForUpdate($Items) {
    $gatewayItems=@($Items | Where-Object Name -eq 'Gateway')
    foreach ($item in $gatewayItems) { AssertNoActiveJobs $item.Target }
    $entries=@(InstallationProcesses $Items)
    $modern=@($entries | Where-Object {$_.Item.Name -eq 'Gateway' -and (GatewaySupportsMaintenance $_.Item.Target)})
    $legacy=@($entries | Where-Object {$_.Item.Name -eq 'Gateway' -and -not (GatewaySupportsMaintenance $_.Item.Target)})
    foreach ($entry in $legacy) { AssertIdleGateway $entry }
    foreach ($item in $gatewayItems) {
        if (GatewaySupportsMaintenance $item.Target) {
            WaitForMaintenance @($modern | Where-Object {$_.Item.Target -eq $item.Target}) $item.Target
        }
    }
    $monitorItems=@($Items | Where-Object Name -eq 'Monitor')
    # A Gateway-only update also closes the configured monitor that imports it.
    if (-not $monitorItems.Count -and $gatewayItems.Count) {
        $config=Join-Path $MonitorDirectory 'agent-monitor.config.json'
        if (Test-Path -LiteralPath $config -PathType Leaf) {
            try {
                $configured=Get-Content -LiteralPath $config -Raw -Encoding UTF8 | ConvertFrom-Json
                if ((FullPath ([string]$configured.gatewayRoot)) -eq $GatewayDirectory) {
                    AssertNoLinks $MonitorDirectory -Tree
                    $monitorItems=@([pscustomobject]@{Name='Monitor';Target=$MonitorDirectory})
                }
            } catch { throw 'Cannot verify the associated monitor configuration. Exit it manually before updating.' }
        }
    }
    foreach ($monitor in $monitorItems) {
        if (@(InstallationProcesses @($monitor)).Count) {
            Write-Host "Closing Agent Monitor: $($monitor.Target)"
            $quitArguments=if ($MonitorDataDirectory) { @('--quit',('"--data-dir='+$MonitorDataDirectory+'"')) } else { @('--quit') }
            $quit=Start-Process -FilePath (Join-Path $monitor.Target 'Agent Monitor.exe') -ArgumentList $quitArguments -WindowStyle Hidden -PassThru
            $null=$quit.WaitForExit(5000)
            $deadline=[DateTime]::UtcNow.AddSeconds(10)
            while (@(InstallationProcesses @($monitor)).Count -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 250 }
            AssertStopped @($monitor)
        }
    }
    foreach ($entry in $legacy) {
        # Revalidate identity and state immediately before stopping this exact PID.
        $original=$entry.Process
        $current=Get-CimInstance Win32_Process -Filter "ProcessId = $($original.ProcessId)" -ErrorAction Stop
        if (-not $current) { continue }
        if ($current.CreationDate -ne $original.CreationDate -or $current.ExecutablePath -ne $original.ExecutablePath -or $current.CommandLine -ne $original.CommandLine) {
            throw 'Gateway process identity changed. Nothing was terminated; retry after disconnecting MCP.'
        }
        AssertIdleGateway ([pscustomobject]@{Process=$current;Item=$entry.Item})
        Write-Host "Stopping idle Gateway PID $($current.ProcessId)."
        Stop-Process -Id $current.ProcessId -ErrorAction Stop
    }
    Start-Sleep -Milliseconds 500
    AssertStopped $Items
}
function AssertOwnedSibling([string]$Value,$Item,[string]$Suffix) {
    $expected = $Item.Target + $Suffix + $script:updateId
    if (-not $Value.Equals($expected,[StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Parent $Value) -ne (Split-Path -Parent $Item.Target)) {
        throw 'Unsafe update staging or backup path.'
    }
}

$source = FullPath $PSScriptRoot
$releaseInfo=ReleaseInfo $source
$GatewayDirectory = FullPath $GatewayDirectory
$MonitorDirectory = FullPath $MonitorDirectory
if ($MonitorDataDirectory) { $MonitorDataDirectory = FullPath $MonitorDataDirectory }
if ((Inside $GatewayDirectory $MonitorDirectory) -or (Inside $MonitorDirectory $GatewayDirectory)) { throw 'Installation destinations must be separate and must not overlap.' }
$items = @()
if ($Component -ne 'Monitor') { $items += [pscustomobject]@{Name='Gateway'; Target=$GatewayDirectory; Source=(Join-Path $source 'gateway'); Stage=''; Backup=''; OldMoved=$false; Installed=$false} }
if ($Component -ne 'Gateway') { $items += [pscustomobject]@{Name='Monitor'; Target=$MonitorDirectory; Source=(Join-Path $source 'monitor'); Stage=''; Backup=''; OldMoved=$false; Installed=$false} }
AssertNoLinks $source -Tree
foreach ($item in $items) {
    if ((Inside $item.Target $source) -or (Inside $source $item.Target)) { throw 'Extract the release outside the installation directories before updating.' }
    if (-not (Test-Path -LiteralPath $item.Target -PathType Container)) { throw "Existing installation not found: $($item.Target). Use Install.ps1 for a new installation." }
    AssertNoLinks $item.Target -Tree
    if ($item.Name -eq 'Gateway') {
        $package = Get-Content -LiteralPath (Join-Path $item.Target 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($package.name -ne 'agent-acp-mcp-local' -or -not (Test-Path -LiteralPath (Join-Path $item.Target 'dist\src\index.js') -PathType Leaf)) { throw 'The target is not an Agent ACP MCP installation.' }
    } elseif (-not (Test-Path -LiteralPath (Join-Path $item.Target 'Agent Monitor.exe') -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $item.Target 'resources\app.asar') -PathType Leaf)) { throw 'The target is not an Agent Monitor installation.' }
}

# Verify the complete extracted release, including files not selected for update.
$manifest = Get-Content -LiteralPath (Join-Path $source 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$known = @{}
foreach ($entry in $manifest.files) {
    $relative = [string]$entry.path
    if (-not $relative -or [IO.Path]::IsPathRooted($relative) -or $relative.Contains(':')) { throw 'Invalid manifest path.' }
    $candidate = [IO.Path]::GetFullPath((Join-Path $source $relative))
    if (-not (Inside $candidate $source) -or $candidate -eq $source -or $candidate -eq (Join-Path $source 'manifest.json') -or $known.ContainsKey($candidate)) { throw 'Invalid or duplicate manifest path.' }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw "Missing release file: $relative" }
    if ([string]$entry.sha256 -notmatch '^[0-9a-fA-F]{64}$' -or (FileHash $candidate) -ne $entry.sha256) { throw "Checksum mismatch: $relative" }
    $known[$candidate] = $true
}
foreach ($file in Get-ChildItem -LiteralPath $source -Recurse -Force -File) {
    if ($file.FullName -ne (Join-Path $source 'manifest.json') -and -not $known.ContainsKey($file.FullName)) { throw "Unlisted release file: $($file.FullName). Extract a clean ZIP first." }
}
foreach ($item in $items) {
    if (-not (Test-Path -LiteralPath $item.Source -PathType Container)) { throw "Missing release component: $($item.Name)" }
}
if ($Component -ne 'Monitor' -or $NodeExecutable) {
    if (-not $NodeExecutable) {
        $node = Get-Command node.exe -ErrorAction SilentlyContinue
        if (-not $node) { throw 'Node.js 22.12+ is required; specify -NodeExecutable if it is not on PATH.' }
        $NodeExecutable = $node.Source
    }
    $NodeExecutable = (Resolve-Path -LiteralPath $NodeExecutable).ProviderPath
    $version = & $NodeExecutable -p 'process.versions.node'
    if ($LASTEXITCODE -ne 0 -or [version]$version -lt [version]'22.12.0') { throw 'Node.js 22.12+ required (24 LTS recommended).' }
    $arch = & $NodeExecutable -p 'process.arch'
    if ($LASTEXITCODE -ne 0 -or $arch -ne 'x64') { throw 'x64 Node.js is required.' }
}
if ($NoAutoClose) { AssertStopped $items }
if (-not $PSCmdlet.ShouldProcess(($items.Target -join ', '),'Close idle components, back up and update program files, preserving local settings and records')) { return }

$script:updateId = (Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+[guid]::NewGuid().ToString('N').Substring(0,8)
$updateLocks = @()
$script:maintenanceLeases=@()
try {
    foreach ($item in $items) {
        $lockPath = $item.Target+'.update.lock'
        # OpenOrCreate + FileShare.None also permits retry after a crashed updater.
        # Retain the empty lock file so another updater cannot lock a deleted inode.
        AssertNoLinks $lockPath
        $updateLocks += [IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    }
    if (-not $NoAutoClose) { CloseForUpdate $items }
    else { AssertStopped $items }
    foreach ($item in $items) {
        $item.Stage = $item.Target+'.update-'+$updateId
        $item.Backup = $item.Target+'.backup-'+$updateId
        AssertOwnedSibling $item.Stage $item '.update-'
        AssertOwnedSibling $item.Backup $item '.backup-'
        if ((Test-Path -LiteralPath $item.Stage) -or (Test-Path -LiteralPath $item.Backup)) { throw 'Update staging path already exists.' }
        Copy-Item -LiteralPath $item.Source -Destination $item.Stage -Recurse -Force
        # Program directories come only from the new release; obsolete code is removed.
        # User-owned top-level entries absent from the release are retained verbatim.
        foreach ($old in Get-ChildItem -LiteralPath $item.Target -Force) {
            $preserve = $old.Name -in @('state','work','configuration','profiles','agent-monitor.config.json')
            if ($old.Name -eq 'release-receipt.json') { continue }
            if ($preserve -or -not (Test-Path -LiteralPath (Join-Path $item.Source $old.Name))) {
                $destination = Join-Path $item.Stage $old.Name
                if ($old.PSIsContainer -and (Test-Path -LiteralPath $destination -PathType Container)) {
                    foreach ($child in Get-ChildItem -LiteralPath $old.FullName -Force) { Copy-Item -LiteralPath $child.FullName -Destination $destination -Recurse -Force }
                } else { Copy-Item -LiteralPath $old.FullName -Destination $destination -Recurse -Force }
            }
        }
        WriteReceipt $item $releaseInfo
        if ($item.Name -eq 'Gateway') {
            & $NodeExecutable --check (Join-Path $item.Stage 'dist\src\index.js')
            if ($LASTEXITCODE -ne 0) { throw 'New Gateway entry point failed the Node.js syntax check.' }
        } elseif ($NodeExecutable) {
            $monitorConfig=Join-Path $item.Stage 'agent-monitor.config.json'
            if (Test-Path -LiteralPath $monitorConfig -PathType Leaf) {
                $config=Get-Content -LiteralPath $monitorConfig -Raw -Encoding UTF8 | ConvertFrom-Json
                if (-not $config.PSObject.Properties['nodeExecutable']) {
                    $config | Add-Member -NotePropertyName nodeExecutable -NotePropertyValue $NodeExecutable
                    WriteJsonAtomic $monitorConfig $config
                }
            }
        }
    }
    # Recheck immediately before replacement; leave stopped until this script finishes.
    AssertStopped $items
    foreach ($item in $items) {
        AssertOwnedSibling $item.Backup $item '.backup-'
        # All paths are siblings on the same volume. Directory.Move is one
        # rename, so a locked file cannot leave a partly copied backup tree.
        [IO.Directory]::Move($item.Target,$item.Backup)
        $item.OldMoved = $true
        if (Test-Path -LiteralPath $item.Target) { throw 'Installation path was recreated by another process.' }
        [IO.Directory]::Move($item.Stage,$item.Target)
        $item.Installed = $true
    }
} catch {
    $originalError = $_.Exception.Message
    $rollbackErrors = @()
    for ($index=$items.Count-1; $index -ge 0; $index--) {
        $item = $items[$index]
        if (-not $item.OldMoved) { continue }
        try {
            if ($item.Installed) {
                $failed = $item.Target+'.failed-'+$updateId
                AssertOwnedSibling $failed $item '.failed-'
                if (Test-Path -LiteralPath $failed) { throw 'Failed-update recovery path already exists.' }
                [IO.Directory]::Move($item.Target,$failed)
            }
            AssertOwnedSibling $item.Backup $item '.backup-'
            if (Test-Path -LiteralPath $item.Target) { throw 'Refusing to overwrite an unexpected directory during rollback.' }
            [IO.Directory]::Move($item.Backup,$item.Target)
            $item.OldMoved = $false
        } catch { $rollbackErrors += "$($item.Name): $($_.Exception.Message); backup: $($item.Backup)" }
    }
    if ($rollbackErrors.Count) { throw "Update failed: $originalError. Automatic rollback was incomplete: $($rollbackErrors -join '; '). Do not restart until the backup is restored." }
    throw "Update failed: $originalError. Original installation paths were preserved/restored. Temporary .update-* or .failed-* folders may remain for inspection."
} finally {
    foreach ($lease in $script:maintenanceLeases) {
        if (Test-Path -LiteralPath $lease.Request) { Remove-Item -LiteralPath $lease.Request -Force }
        Get-ChildItem -LiteralPath (Split-Path -Parent $lease.Request) -Filter ((Split-Path -Leaf $lease.AckPrefix)+'*.ack.json') -File -ErrorAction SilentlyContinue | Remove-Item -Force
    }
    foreach ($handle in $updateLocks) { $handle.Dispose() }
}
foreach ($item in $items) {
    Write-Host "Updated $($item.Name): $($item.Target)"
    Write-Host "Backup retained: $($item.Backup)"
}
Write-Host 'Host MCP settings, global instructions, provider CLIs, and login credentials were not changed.'
Write-Host 'Reconnect MCP and start Agent Monitor. Keep backups until verification; do not distribute backups containing local data.'
