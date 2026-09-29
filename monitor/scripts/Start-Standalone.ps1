[CmdletBinding()]
param(
    [string]$Executable = (Join-Path $env:LOCALAPPDATA 'Programs\Agent Monitor\Agent Monitor.exe')
)

$ErrorActionPreference = 'Stop'
$appPath = (Resolve-Path -LiteralPath $Executable).ProviderPath
if ([IO.Path]::GetFileName($appPath) -ne 'Agent Monitor.exe') {
    throw 'Executable must point to Agent Monitor.exe.'
}

# Start-Process may inherit the terminal host's Windows Job Object. WMI
# creates the process outside that job so closing the host cannot kill it.
# This is a local, current-user launch; no service, task or logon trigger is installed.
$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow = [uint16]0}
$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = '"' + $appPath + '"'
    CurrentDirectory = (Split-Path -Parent $appPath)
    ProcessStartupInformation = $startup
}
if ($result.ReturnValue -ne 0) {
    throw "Independent launch failed (Win32_Process.Create: $($result.ReturnValue))."
}
[pscustomobject]@{ProcessId = $result.ProcessId; Executable = $appPath; Launcher = 'Windows WMI'}
