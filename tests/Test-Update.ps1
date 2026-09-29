#Requires -Version 5.1
<#
Run on native Windows with Windows PowerShell 5.1:
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File work\Test-Update.ps1

All package and installation paths in these tests are disposable fixtures.
#>
param(
    [string]$Updater = (Join-Path (Split-Path -Parent $PSScriptRoot) 'distribution\Update.ps1'),
    [string]$NodeExecutable,
    [string]$Filter = ''
)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'These tests require native Windows.' }
if (-not $NodeExecutable) { $nodeCommand=Get-Command node.exe -ErrorAction SilentlyContinue; if ($nodeCommand) { $NodeExecutable=$nodeCommand.Source } }
if (-not (Test-Path -LiteralPath $Updater -PathType Leaf)) { throw "Updater missing: $Updater" }
if (-not (Test-Path -LiteralPath $NodeExecutable -PathType Leaf)) { throw "Node missing: $NodeExecutable" }

$script:Passed = 0
$script:Failed = 0
$script:OldGatewayEntry = 'setInterval(() => {}, 1000);'
$script:Root = Join-Path ([IO.Path]::GetTempPath()) ('agent-update-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $script:Root | Out-Null

function Assert($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Put([string]$Path, [string]$Value) {
    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    [IO.File]::WriteAllText($Path, $Value, (New-Object System.Text.UTF8Encoding($false)))
}

function Read([string]$Path) { return [IO.File]::ReadAllText($Path) }

function PathOf([string]$Base, [string]$Relative) {
    return Join-Path $Base ($Relative.Replace('/', [IO.Path]::DirectorySeparatorChar))
}

function Rebuild-Manifest([string]$Package) {
    $files = @(Get-ChildItem -LiteralPath $Package -Recurse -File | Where-Object {
        $_.FullName -ne (Join-Path $Package 'manifest.json')
    } | ForEach-Object {
        [pscustomobject]@{
            path = $_.FullName.Substring($Package.Length + 1).Replace('\', '/')
            sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    } | Sort-Object path)
    $manifest = [pscustomobject]@{
        platform = 'win32-x64'
        gatewayVersion = '9.9.9'
        monitorVersion = '9.9.9'
        files = $files
    }
    Put (Join-Path $Package 'manifest.json') ($manifest | ConvertTo-Json -Depth 8)
}

function New-Fixture([string]$Name) {
    $base = Join-Path $script:Root $Name
    $package = Join-Path $base 'package'
    $gateway = Join-Path $base 'installed\gateway'
    $monitor = Join-Path $base 'installed\monitor'
    New-Item -ItemType Directory -Path $package,$gateway,$monitor -Force | Out-Null

    Copy-Item -LiteralPath $Updater -Destination (Join-Path $package 'Update.ps1')
    Copy-Item -LiteralPath (Join-Path (Split-Path -Parent $Updater) 'Run-Update.ps1') -Destination (Join-Path $package 'Run-Update.ps1')
    Put (PathOf $package 'gateway/package.json') '{"name":"agent-acp-mcp-local","version":"9.9.9"}'
    Put (PathOf $package 'gateway/dist/src/index.js') 'console.log("new gateway entry");'
    Put (PathOf $package 'gateway/src/current.ts') 'new gateway source'
    Put (PathOf $package 'gateway/node_modules/new-module/index.js') 'new dependency'
    Put (PathOf $package 'gateway/profiles/default.json') '{"packaged":true}'
    Put (PathOf $package 'gateway/profiles/new.json') '{"new":true}'
    Put (PathOf $package 'monitor/Agent Monitor.exe') 'new monitor binary'
    Put (PathOf $package 'monitor/resources/app.asar') 'new monitor app'
    Put (PathOf $package 'monitor/resources/new.txt') 'new monitor resource'
    Put (PathOf $package 'release-info.json') '{"schemaVersion":1,"version":"9.9.9","components":{"gateway":"9.9.9","monitor":"9.9.9"}}'
    Rebuild-Manifest $package

    Put (PathOf $gateway 'package.json') '{"name":"agent-acp-mcp-local","version":"1.0.0"}'
    Put (PathOf $gateway 'dist/src/index.js') $script:OldGatewayEntry
    Put (PathOf $gateway 'dist/obsolete.js') 'obsolete gateway binary'
    Put (PathOf $gateway 'src/obsolete.ts') 'obsolete gateway source'
    Put (PathOf $gateway 'node_modules/old-module/index.js') 'obsolete dependency'
    Put (PathOf $gateway 'profiles/default.json') '{"user":"custom"}'
    Put (PathOf $gateway 'profiles/user.json') '{"user":"only"}'
    Put (PathOf $gateway 'state/session.json') '{"token":"fixture-token"}'
    Put (PathOf $gateway 'work/session.log') 'fixture work'
    Put (PathOf $gateway 'config.json') '{"user":"config"}'
    Put (PathOf $gateway 'configuration/settings.json') '{"user":"settings"}'
    Put (PathOf $gateway 'my-notes.txt') 'unknown top-level file'
    Put (PathOf $monitor 'Agent Monitor.exe') 'old monitor binary'
    Put (PathOf $monitor 'resources/app.asar') 'old monitor app'
    Put (PathOf $monitor 'resources/obsolete.txt') 'obsolete monitor resource'
    Put (PathOf $monitor 'state/window.json') '{"user":"window"}'
    Put (PathOf $monitor 'config.json') '{"user":"monitor config"}'
    Put (PathOf $monitor 'agent-monitor.config.json') ([ordered]@{gatewayRoot=$gateway;env=[ordered]@{TEST_SETTING='preserved'}} | ConvertTo-Json -Compress)
    Put (PathOf $base 'external-login.json') '{"token":"outside-install"}'
    return [pscustomobject]@{ Base=$base; Package=$package; Gateway=$gateway; Monitor=$monitor }
}

function Invoke-Update($Fixture, [string[]]$Additional = @(), [string]$GatewayTarget = '', [string]$MonitorTarget = '') {
    if (-not $GatewayTarget) { $GatewayTarget = $Fixture.Gateway }
    if (-not $MonitorTarget) { $MonitorTarget = $Fixture.Monitor }
    $args = @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $Fixture.Package 'Update.ps1'),
        '-NodeExecutable',$NodeExecutable,'-GatewayDirectory',$GatewayTarget,
        '-MonitorDirectory',$MonitorTarget) + $Additional
    $ErrorActionPreference = 'Continue' # Windows PowerShell promotes native stderr to an error record.
    $output = & powershell.exe @args 2>&1 | Out-String
    return [pscustomobject]@{ ExitCode=$LASTEXITCODE; Output=$output }
}
function Invoke-Runner($Fixture,[switch]$OmitGateway,[switch]$MockDialog) {
    $userData=Join-Path $Fixture.Base 'user-data'
    $requestFile=Join-Path $Fixture.Base 'request.json'
    $resultFile=Join-Path $userData 'updates\result.json'
    $request=[ordered]@{schemaVersion=1;operationId=[guid]::NewGuid().ToString();packageDirectory=$Fixture.Package;monitorDirectory=$Fixture.Monitor;nodeExecutable=$NodeExecutable;resultFile=$resultFile;userDataDir=$userData}
    if (-not $OmitGateway) { $request.gatewayDirectory=$Fixture.Gateway }
    Put $requestFile ($request | ConvertTo-Json -Depth 8)
    $dialogFile=Join-Path $Fixture.Base 'recovery-dialog.txt'
    $ErrorActionPreference='Continue'
    if ($MockDialog) {
        $runner=(Join-Path $Fixture.Package 'Run-Update.ps1').Replace("'","''")
        $requestLiteral=$requestFile.Replace("'","''")
        $dialogLiteral=$dialogFile.Replace("'","''")
        $resultLiteral=$resultFile.Replace("'","''")
        $mock="function ShowRecoveryDialog([string]`$Message) { if (Test-Path -LiteralPath '$resultLiteral') { [IO.File]::WriteAllText('$dialogLiteral',`$Message) } }; . '$runner' -RequestFile '$requestLiteral'"
        $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($mock))
        $output=& powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded 2>&1 | Out-String
    } else { $output=& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Fixture.Package 'Run-Update.ps1') -RequestFile $requestFile 2>&1 | Out-String }
    $code=$LASTEXITCODE
    $ErrorActionPreference='Stop'
    $value=if (Test-Path -LiteralPath $resultFile) { Get-Content -LiteralPath $resultFile -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
    return [pscustomobject]@{ExitCode=$code;Output=$output;Result=$value;History=(Join-Path $userData 'updates\history.json');DialogFile=$dialogFile}
}

function Assert-Old($Fixture) {
    Assert ((Read (PathOf $Fixture.Gateway 'dist/src/index.js')) -eq $script:OldGatewayEntry) 'Gateway changed despite rejection.'
    Assert ((Read (PathOf $Fixture.Monitor 'resources/app.asar')) -eq 'old monitor app') 'Monitor changed despite rejection.'
    Assert ((Read (PathOf $Fixture.Base 'external-login.json')) -eq '{"token":"outside-install"}') 'External login changed.'
}

function Assert-Rejected($Fixture, [string[]]$Additional = @()) {
    $result = Invoke-Update $Fixture $Additional
    Assert ($result.ExitCode -ne 0) "Expected rejection. Output: $($result.Output)"
    Assert-Old $Fixture
}

function Start-Gateway($Fixture, [switch]$Hidden) {
    $entry = PathOf $Fixture.Gateway 'dist/src/index.js'
    if ($Hidden) {
        $process = Start-Process -FilePath $NodeExecutable -ArgumentList @($entry) -WindowStyle Hidden -PassThru
    } else {
        $process = Start-Process -FilePath $NodeExecutable -ArgumentList @($entry) -NoNewWindow -PassThru
    }
    Start-Sleep -Milliseconds 350
    $process.Refresh()
    Assert (-not $process.HasExited) "Gateway fixture process did not start: $entry"
    return $process
}
function Prepare-ModernGateway($Fixture) {
    Put (PathOf $Fixture.Gateway 'package.json') '{"name":"agent-acp-mcp-local","version":"2.2.0"}'
    $entry=@'
const fs=require('fs');const path=require('path');
const root=path.resolve(__dirname,'../..');const request=root+'.maintenance.json';
setInterval(()=>{
  let value;try{value=JSON.parse(fs.readFileSync(request,'utf8'));}catch{return;}
  if(value.schemaVersion!==1||!value.operationId||Date.parse(value.expiresAt)<=Date.now())return;
  if(process.argv[2]==='busy')return;
  if(value.phase==='prepare'){
    const ack=root+'.maintenance.'+value.operationId+'.'+process.pid+'.ack.json';
    fs.writeFileSync(ack,JSON.stringify({schemaVersion:1,operationId:value.operationId,gatewayPid:process.pid,acknowledgedAt:new Date().toISOString()}));
  }else if(value.phase==='commit'){process.exit(0);}
},100);
'@
    Put (PathOf $Fixture.Gateway 'dist/src/index.js') $entry
    return $entry
}

function Assert-Alive([Diagnostics.Process]$Process, [string]$Message) {
    $Process.Refresh()
    Assert (-not $Process.HasExited) $Message
}

function Stop-FixtureProcess([Diagnostics.Process]$Process) {
    if ($null -eq $Process) { return }
    $Process.Refresh()
    if (-not $Process.HasExited) { Stop-Process -Id $Process.Id -Force }
}

function Run([string]$Name, [scriptblock]$Body) {
    if ($Filter -and $Name -notmatch $Filter) { return }
    try {
        & $Body
        $script:Passed++
        Write-Host "PASS $Name"
    } catch {
        $script:Failed++
        Write-Host "FAIL $Name`: $($_.Exception.Message)" -ForegroundColor Red
    }
}

try {
    Run 'All updates managed files and retains user data' {
        $f = New-Fixture 'all'
        $result = Invoke-Update $f
        Assert ($result.ExitCode -eq 0) "Updater failed: $($result.Output)"
        Assert ((Read (PathOf $f.Gateway 'dist/src/index.js')) -eq 'console.log("new gateway entry");') 'Gateway executable was not updated.'
        Assert ((Read (PathOf $f.Monitor 'resources/app.asar')) -eq 'new monitor app') 'Monitor executable was not updated.'
        Assert (-not (Test-Path -LiteralPath (PathOf $f.Gateway 'dist/obsolete.js'))) 'Old gateway program survived.'
        Assert (-not (Test-Path -LiteralPath (PathOf $f.Gateway 'node_modules/old-module'))) 'Old dependency survived.'
        Assert (-not (Test-Path -LiteralPath (PathOf $f.Monitor 'resources/obsolete.txt'))) 'Old monitor resource survived.'
        Assert ((Read (PathOf $f.Gateway 'profiles/default.json')) -eq '{"user":"custom"}') 'Customized profile overwritten.'
        Assert ((Read (PathOf $f.Gateway 'profiles/user.json')) -eq '{"user":"only"}') 'User profile lost.'
        Assert ((Read (PathOf $f.Gateway 'profiles/new.json')) -eq '{"new":true}') 'New packaged profile missing.'
        Assert ((Read (PathOf $f.Gateway 'state/session.json')) -eq '{"token":"fixture-token"}') 'Gateway state lost.'
        Assert ((Read (PathOf $f.Gateway 'work/session.log')) -eq 'fixture work') 'Gateway work lost.'
        Assert ((Read (PathOf $f.Gateway 'config.json')) -eq '{"user":"config"}') 'Gateway config lost.'
        Assert ((Read (PathOf $f.Gateway 'configuration/settings.json')) -eq '{"user":"settings"}') 'Unknown configuration lost.'
        Assert ((Read (PathOf $f.Gateway 'my-notes.txt')) -eq 'unknown top-level file') 'Unknown top-level file lost.'
        Assert ((Read (PathOf $f.Monitor 'state/window.json')) -eq '{"user":"window"}') 'Monitor state lost.'
        Assert ((Read (PathOf $f.Monitor 'config.json')) -eq '{"user":"monitor config"}') 'Monitor config lost.'
        $monitorConfig=Get-Content -LiteralPath (PathOf $f.Monitor 'agent-monitor.config.json') -Raw | ConvertFrom-Json
        Assert ($monitorConfig.nodeExecutable -eq $NodeExecutable) 'Node executable was not migrated into monitor config.'
        Assert ($monitorConfig.env.TEST_SETTING -eq 'preserved') 'Monitor config fields changed during migration.'
        Assert ((Read (PathOf $f.Base 'external-login.json')) -eq '{"token":"outside-install"}') 'External login changed.'
        Assert (@(Get-ChildItem -LiteralPath (Split-Path $f.Gateway -Parent) -Directory -Filter 'gateway.backup-*').Count -ge 1) 'Gateway backup missing.'
        Assert (@(Get-ChildItem -LiteralPath (Split-Path $f.Monitor -Parent) -Directory -Filter 'monitor.backup-*').Count -ge 1) 'Monitor backup missing.'
    }
    Run 'Runner selects installed components and persists success' {
        $f=New-Fixture 'runner-success'
        $r=Invoke-Runner $f -OmitGateway
        Assert ($r.ExitCode -eq 0) "Runner failed: $($r.Output)"
        Assert ($r.Result.status -eq 'success') 'Runner did not report success.'
        Assert ($r.Result.operationId -match '^[0-9a-f-]{36}$') 'Operation identity missing.'
        Assert (Test-Path -LiteralPath $r.History) 'Runner history missing.'
        Assert ((Read (PathOf $f.Gateway 'dist/src/index.js')) -eq $script:OldGatewayEntry) 'Omitted gateway was changed.'
        Assert ((Read (PathOf $f.Monitor 'resources/app.asar')) -eq 'new monitor app') 'Monitor was not updated.'
        $receipt=Get-Content -LiteralPath (PathOf $f.Monitor 'release-receipt.json') -Raw | ConvertFrom-Json
        Assert ($receipt.version -eq '9.9.9' -and $receipt.components.gateway -eq '9.9.9' -and $receipt.components.monitor -eq '9.9.9') 'Shared monitor receipt missing.'
    }
    Run 'Runner accepts verified package staged under monitor user data' {
        $f=New-Fixture 'runner-stage-under-data'
        $stage=Join-Path $f.Base 'user-data\updates\stage-fixture'
        New-Item -ItemType Directory -Path (Split-Path -Parent $stage) -Force | Out-Null
        Move-Item -LiteralPath $f.Package -Destination $stage
        $f.Package=$stage
        $r=Invoke-Runner $f -OmitGateway
        Assert ($r.ExitCode -eq 0) "Staged package rejected: $($r.Output)"
        Assert ($r.Result.status -eq 'success') 'Staged package did not update monitor.'
    }
    Run 'Runner reports active job as blocked and preserves installations' {
        $f=New-Fixture 'runner-blocked'
        Put (PathOf $f.Gateway 'state/jobs/active.json') '{"job_id":"active","status":"running"}'
        $r=Invoke-Runner $f
        Assert ($r.ExitCode -ne 0) 'Runner accepted an active job.'
        Assert ($r.Result.status -eq 'blocked') "Wrong runner status: $($r.Result.status)"
        Assert-Old $f
    }
    Run 'Runner reports restored transaction without backup remnants' {
        $f=New-Fixture 'runner-rollback'
        $fake=@'
param($NodeExecutable,$Component,$MonitorDirectory,$MonitorDataDirectory,$GatewayDirectory)
Write-Output 'Original installation paths were preserved/restored'
exit 1
'@
        Put (Join-Path $f.Package 'Update.ps1') $fake
        Rebuild-Manifest $f.Package
        $r=Invoke-Runner $f -MockDialog
        Assert ($r.ExitCode -ne 0) 'Runner accepted an unsuccessful updater.'
        Assert ($r.Result.status -eq 'rolled_back') "Wrong rollback status: $($r.Result.status)"
        Assert (@($r.Result.backups).Count -eq 0) 'A restored transaction retained a reported backup.'
        Assert-Old $f
    }
    Run 'Runner exposes only new recovery backup paths after incomplete rollback' {
        $f=New-Fixture 'runner-rollback-incomplete'
        $preexisting=$f.Gateway+'.backup-prior'
        Put (Join-Path $preexisting 'marker.txt') 'previous backup'
        $fake=@'
param($NodeExecutable,$Component,$MonitorDirectory,$MonitorDataDirectory,$GatewayDirectory)
Copy-Item -LiteralPath $GatewayDirectory -Destination ($GatewayDirectory+'.backup-new') -Recurse -Force
Write-Output 'super-secret-provider-token'
exit 1
'@
        Put (Join-Path $f.Package 'Update.ps1') $fake
        Rebuild-Manifest $f.Package
        $r=Invoke-Runner $f -MockDialog
        Assert ($r.ExitCode -ne 0) 'Incomplete rollback was accepted.'
        Assert ($r.Result.status -eq 'rollback_failed') "Wrong recovery status: $($r.Result.status)"
        Assert (@($r.Result.backups).Count -eq 1 -and $r.Result.backups[0] -eq ($f.Gateway+'.backup-new')) 'Recovery backup list was not limited to new backup.'
        Assert (Test-Path -LiteralPath $r.History) 'Recovery result history missing.'
        Assert (Test-Path -LiteralPath $r.DialogFile) 'Recovery dialog did not run after result persisted.'
        $dialog=Read $r.DialogFile
        Assert ($dialog.Contains($f.Gateway+'.backup-new') -and $dialog.Contains('Do not start Agent Monitor')) 'Recovery dialog did not show backup path and action.'
        Assert (-not $dialog.Contains($preexisting)) 'Preexisting backup leaked into recovery instructions.'
        Assert (-not $dialog.Contains('super-secret-provider-token') -and -not ((Read (Join-Path $f.Base 'user-data\updates\result.json')).Contains('super-secret-provider-token'))) 'Raw updater output leaked into recovery records.'
    }

    Run 'Gateway component leaves monitor unchanged' {
        $f = New-Fixture 'gateway-only'
        $result = Invoke-Update $f @('-Component','Gateway')
        Assert ($result.ExitCode -eq 0) "Updater failed: $($result.Output)"
        Assert ((Read (PathOf $f.Gateway 'dist/src/index.js')) -eq 'console.log("new gateway entry");') 'Gateway unchanged.'
        Assert ((Read (PathOf $f.Monitor 'resources/app.asar')) -eq 'old monitor app') 'Monitor changed.'
        Assert (@(Get-ChildItem -LiteralPath (Split-Path $f.Monitor -Parent) -Directory -Filter 'monitor.backup-*').Count -eq 0) 'Monitor backup created.'
    }

    Run 'Monitor component leaves gateway unchanged' {
        $f = New-Fixture 'monitor-only'
        $result = Invoke-Update $f @('-Component','Monitor')
        Assert ($result.ExitCode -eq 0) "Updater failed: $($result.Output)"
        Assert ((Read (PathOf $f.Gateway 'dist/src/index.js')) -eq $script:OldGatewayEntry) 'Gateway changed.'
        Assert ((Read (PathOf $f.Monitor 'resources/app.asar')) -eq 'new monitor app') 'Monitor unchanged.'
        Assert (@(Get-ChildItem -LiteralPath (Split-Path $f.Gateway -Parent) -Directory -Filter 'gateway.backup-*').Count -eq 0) 'Gateway backup created.'
    }
    Run 'Existing monitor Node selection is preserved' {
        $f=New-Fixture 'monitor-node-explicit'
        Put (PathOf $f.Monitor 'agent-monitor.config.json') '{"gatewayRoot":"fixture","nodeExecutable":"C:\\preconfigured\\node.exe","env":{"TEST_SETTING":"preserved"}}'
        $result=Invoke-Update $f @('-Component','Monitor')
        Assert ($result.ExitCode -eq 0) "Monitor update failed: $($result.Output)"
        $config=Get-Content -LiteralPath (PathOf $f.Monitor 'agent-monitor.config.json') -Raw | ConvertFrom-Json
        Assert ($config.nodeExecutable -eq 'C:\preconfigured\node.exe') 'Explicit Node selection was overridden.'
        Assert ($config.env.TEST_SETTING -eq 'preserved') 'Other monitor config fields changed.'
    }

    Run 'WhatIf leaves installations unchanged' {
        $f = New-Fixture 'whatif'
        $result = Invoke-Update $f @('-WhatIf')
        Assert ($result.ExitCode -eq 0) "WhatIf failed: $($result.Output)"
        Assert-Old $f
        Assert (@(Get-ChildItem -LiteralPath (Split-Path $f.Gateway -Parent) -Directory -Filter '*.backup-*').Count -eq 0) 'WhatIf created a backup.'
    }

    Run 'Corrupt payload checksum is rejected' {
        $f = New-Fixture 'corrupt'
        Put (PathOf $f.Package 'gateway/dist/src/index.js') 'tampered gateway'
        Assert-Rejected $f
    }

    Run 'Missing manifested file is rejected' {
        $f = New-Fixture 'missing'
        Remove-Item -LiteralPath (PathOf $f.Package 'gateway/dist/src/index.js')
        Assert-Rejected $f
    }

    Run 'Unlisted package file is rejected' {
        $f = New-Fixture 'unlisted'
        Put (PathOf $f.Package 'gateway/dist/extra.js') 'not manifested'
        Assert-Rejected $f
    }

    Run 'Manifest traversal is rejected' {
        $f = New-Fixture 'traversal'
        $m = Get-Content -LiteralPath (Join-Path $f.Package 'manifest.json') -Raw | ConvertFrom-Json
        $m.files[0].path = '../external-login.json'
        Put (Join-Path $f.Package 'manifest.json') ($m | ConvertTo-Json -Depth 8)
        Assert-Rejected $f
    }

    Run 'Package source inside installation is rejected' {
        $f = New-Fixture 'source-contained'
        $result = Invoke-Update $f @() $f.Base (Join-Path $script:Root 'separate-monitor-target')
        Assert ($result.ExitCode -ne 0) 'Source-contained target was accepted.'
        Assert-Old $f
    }

    Run 'Overlapping installation paths are rejected' {
        $f = New-Fixture 'overlap'
        $result = Invoke-Update $f @() '' (Join-Path $f.Gateway 'monitor')
        Assert ($result.ExitCode -ne 0) 'Overlapping targets were accepted.'
        Assert-Old $f
    }

    Run 'NoAutoClose leaves a running gateway untouched' {
        $f = New-Fixture 'no-autoclose'
        $process = Start-Gateway $f
        try {
            Assert-Rejected $f @('-NoAutoClose')
            Assert-Alive $process 'NoAutoClose terminated the gateway.'
        } finally {
            Stop-FixtureProcess $process
        }
    }

    Run 'Idle gateway exits automatically; unrelated Node survives' {
        $f = New-Fixture 'idle-autoclose'
        $otherScript = Join-Path $f.Base 'unrelated.cjs'
        Put $otherScript 'setInterval(() => {}, 1000);'
        $other = Start-Process -FilePath $NodeExecutable -ArgumentList @($otherScript) -WindowStyle Hidden -PassThru
        $gateway = $null
        try {
            $gateway = Start-Gateway $f
            $result = Invoke-Update $f @('-Component','Gateway')
            Assert ($result.ExitCode -eq 0) "Idle gateway update failed: $($result.Output)"
            $gateway.Refresh()
            Assert ($gateway.HasExited) 'Idle gateway remained running.'
            Assert-Alive $other 'Unrelated Node process was terminated.'
            Assert ((Read (PathOf $f.Gateway 'dist/src/index.js')) -eq 'console.log("new gateway entry");') 'Gateway was not updated.'
        } finally {
            Stop-FixtureProcess $gateway
            Stop-FixtureProcess $other
        }
    }

    Run 'Hidden idle gateway with console host exits automatically' {
        $f = New-Fixture 'hidden-idle'
        $gateway = Start-Gateway $f -Hidden
        try {
            $result = Invoke-Update $f @('-Component','Gateway')
            Assert ($result.ExitCode -eq 0) "Hidden gateway update failed: $($result.Output)"
            $gateway.Refresh()
            Assert ($gateway.HasExited) 'Hidden idle gateway remained running.'
            Assert ((Read (PathOf $f.Gateway 'dist/src/index.js')) -eq 'console.log("new gateway entry");') 'Gateway was not updated.'
        } finally { Stop-FixtureProcess $gateway }
    }

    Run 'Gateway path as a decoy argument never authorizes process shutdown' {
        $f = New-Fixture 'decoy-argument'
        $otherScript = Join-Path $f.Base 'other.cjs'
        Put $otherScript 'setInterval(() => {}, 1000);'
        $target = PathOf $f.Gateway 'dist/src/index.js'
        $decoy = Start-Process -FilePath $NodeExecutable -ArgumentList @($otherScript,$target) -NoNewWindow -PassThru
        try {
            Start-Sleep -Milliseconds 350
            Assert-Alive $decoy 'Decoy Node process exited early.'
            Assert-Rejected $f @('-Component','Gateway')
            Assert-Alive $decoy 'Decoy Node process was terminated.'
        } finally { Stop-FixtureProcess $decoy }
    }

    Run 'Active gateway job blocks shutdown and update' {
        $f = New-Fixture 'active-job'
        Put (PathOf $f.Gateway 'state/jobs/active.json') '{"job_id":"active","status":"running"}'
        $process = Start-Gateway $f
        try {
            Assert-Rejected $f @('-Component','Gateway')
            Assert-Alive $process 'Gateway with active job was terminated.'
        } finally { Stop-FixtureProcess $process }
    }
    Run 'Modern gateway requires all process acknowledgements before shutdown' {
        $f=New-Fixture 'modern-multi-process'
        $entry=Prepare-ModernGateway $f
        $idle=Start-Gateway $f
        $busy=Start-Process -FilePath $NodeExecutable -ArgumentList @((PathOf $f.Gateway 'dist/src/index.js'),'busy') -WindowStyle Hidden -PassThru
        try {
            Start-Sleep -Milliseconds 350
            Assert-Alive $busy 'Busy gateway fixture did not start.'
            $blocked=Invoke-Update $f @('-Component','Gateway')
            Assert ($blocked.ExitCode -ne 0) 'Updater committed while a modern gateway was busy.'
            Assert-Alive $idle 'Idle gateway was shut down before all peers acknowledged.'
            Assert-Alive $busy 'Busy gateway was terminated.'
            Assert ((Read (PathOf $f.Gateway 'dist/src/index.js')) -eq $entry) 'Gateway changed despite a busy peer.'
            Stop-FixtureProcess $busy
            $updated=Invoke-Update $f @('-Component','Gateway')
            Assert ($updated.ExitCode -eq 0) "Modern idle gateway update failed: $($updated.Output)"
            $idle.Refresh();Assert ($idle.HasExited) 'Idle modern gateway did not exit on commit.'
        } finally { Stop-FixtureProcess $idle;Stop-FixtureProcess $busy }
    }

    Run 'Malformed gateway job blocks shutdown and update' {
        $f = New-Fixture 'malformed-job'
        Put (PathOf $f.Gateway 'state/jobs/broken.json') '{bad json'
        $process = Start-Gateway $f
        try {
            Assert-Rejected $f @('-Component','Gateway')
            Assert-Alive $process 'Gateway with malformed job state was terminated.'
        } finally { Stop-FixtureProcess $process }
    }

    Run 'Gateway child process blocks shutdown without killing either process' {
        $f = New-Fixture 'gateway-child'
        $sleeper = Join-Path $f.Base 'child.cjs'
        $pidFile = Join-Path $f.Base 'child.pid'
        Put $sleeper 'setInterval(() => {}, 1000);'
        $entry = "const c=require('child_process').spawn(process.execPath,[$($sleeper | ConvertTo-Json -Compress)],{stdio:'ignore'});require('fs').writeFileSync($($pidFile | ConvertTo-Json -Compress),String(c.pid));setInterval(()=>{},1000);"
        Put (PathOf $f.Gateway 'dist/src/index.js') $entry
        $parent = $null
        $childId = 0
        try {
            $parent = Start-Gateway $f
            Assert (Test-Path -LiteralPath $pidFile) 'Gateway did not start its child.'
            $childId = [int](Read $pidFile)
            Assert ($null -ne (Get-Process -Id $childId -ErrorAction SilentlyContinue)) 'Child process exited early.'
            $result = Invoke-Update $f @('-Component','Gateway')
            Assert ($result.ExitCode -ne 0) 'Gateway with a child process was updated.'
            Assert-Alive $parent 'Gateway parent was terminated.'
            Assert ($null -ne (Get-Process -Id $childId -ErrorAction SilentlyContinue)) 'Gateway child was terminated.'
            Assert ((Read (PathOf $f.Gateway 'dist/src/index.js')) -eq $entry) 'Gateway files changed after child-process rejection.'
        } finally {
            Stop-FixtureProcess $parent
            if ($childId -gt 0) { Stop-Process -Id $childId -Force -ErrorAction SilentlyContinue }
        }
    }

    Run 'WhatIf does not terminate a running gateway' {
        $f = New-Fixture 'whatif-running'
        $process = Start-Gateway $f
        try {
            $null = Invoke-Update $f @('-Component','Gateway','-WhatIf')
            Assert-Alive $process 'WhatIf terminated the gateway.'
            Assert-Old $f
        } finally { Stop-FixtureProcess $process }
    }

    Run 'Running monitor exits through its installed --quit command' {
        $f = New-Fixture 'monitor-graceful'
        $exe = PathOf $f.Monitor 'Agent Monitor.exe'
        Remove-Item -LiteralPath $exe
        $monitorSource = @'
using System;
using System.IO;
using System.Threading;
class MonitorFixture {
  static int Main(string[] args) {
    string marker = Path.Combine(Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location), "state", "quit-requested");
    if (args.Length == 1 && args[0] == "--quit") {
      Directory.CreateDirectory(Path.GetDirectoryName(marker));
      File.WriteAllText(marker, "graceful quit");
      return 0;
    }
    while (!File.Exists(marker)) Thread.Sleep(50);
    return 0;
  }
}
'@
        Add-Type -TypeDefinition $monitorSource -OutputAssembly $exe -OutputType ConsoleApplication
        $monitorProcess = Start-Process -FilePath $exe -NoNewWindow -PassThru
        try {
            Start-Sleep -Milliseconds 300
            Assert-Alive $monitorProcess 'Fixture monitor exited early.'
            $result = Invoke-Update $f @('-Component','Monitor')
            Assert ($result.ExitCode -eq 0) "Monitor update failed: $($result.Output)"
            $monitorProcess.Refresh()
            Assert ($monitorProcess.HasExited) 'Monitor did not exit after --quit.'
            Assert ((Read (PathOf $f.Monitor 'state/quit-requested')) -eq 'graceful quit') 'Installed --quit command was not used.'
            Assert ((Read (PathOf $f.Monitor 'resources/app.asar')) -eq 'new monitor app') 'Monitor was not updated.'
        } finally { Stop-FixtureProcess $monitorProcess }
    }

    Run 'Concurrent update lock blocks a second updater' {
        $f = New-Fixture 'concurrent-lock'
        $lockPath = $f.Gateway + '.update.lock'
        $stream = New-Object IO.FileStream($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        try { Assert-Rejected $f } finally { $stream.Dispose() }
    }

    Run 'Reparse package path is rejected' {
        $f = New-Fixture 'reparse'
        $real = Join-Path $f.Base 'real-source'
        New-Item -ItemType Directory -Path $real | Out-Null
        Put (Join-Path $real 'hidden.txt') 'junction payload'
        $link = Join-Path $f.Package 'gateway\linked'
        $null = & cmd.exe /c "mklink /J `"$link`" `"$real`"" 2>&1
        Assert (Test-Path -LiteralPath $link) 'Could not create junction fixture.'
        try { Assert-Rejected $f } finally { [IO.Directory]::Delete($link) }
    }

    Run 'Locked monitor payload rolls back both installations' {
        $f = New-Fixture 'rollback'
        $locked = PathOf $f.Monitor 'resources/app.asar'
        $stream = New-Object IO.FileStream($locked, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
        try {
            $result = Invoke-Update $f
            Assert ($result.ExitCode -ne 0) "Expected a locked monitor to fail: $($result.Output)"
        } finally { $stream.Dispose() }
        Assert-Old $f
        Assert (@(Get-ChildItem -LiteralPath (Split-Path $f.Gateway -Parent) -Directory -Filter 'gateway.failed-*').Count -ge 1) 'Gateway swap was not exercised before rollback.'
        Assert (@(Get-ChildItem -LiteralPath (Split-Path $f.Monitor -Parent) -Directory -Filter 'monitor.backup-*').Count -eq 0) 'Locked monitor move left a partial backup directory.'
        Assert (@(Get-ChildItem -LiteralPath (Split-Path $f.Gateway -Parent) -Directory -Filter 'gateway.backup-*').Count -eq 0) 'Gateway backup was not restored.'
    }
} finally {
    $resolvedRoot = [IO.Path]::GetFullPath($script:Root).TrimEnd('\')
    $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    $expectedName = 'agent-update-test-[0-9a-f]{32}'
    if (-not $resolvedRoot.StartsWith($resolvedTemp + '\', [StringComparison]::OrdinalIgnoreCase) -or
        (Split-Path -Leaf $resolvedRoot) -notmatch ('^' + $expectedName + '$')) {
        throw "Refusing unsafe fixture cleanup: $resolvedRoot"
    }
    Remove-Item -LiteralPath $resolvedRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "$script:Passed passed; $script:Failed failed"
if ($script:Failed -gt 0) { exit 1 }
