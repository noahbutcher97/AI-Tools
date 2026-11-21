# Live kernel access check on a disposable hosted Windows runner. The target
# is this PowerShell process. The observer task has no triggers or input frame.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted') {
    throw 'This two-account qualification runs on a disposable hosted Windows runner.'
}
$tag = 'RelayProcessTrial-' + [Guid]::NewGuid().ToString('N')
$sid = 'S-1-5-19' # Local Service
$source = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'fixtures/ProcessEndObservation.cs') -Raw
$creation = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToFileTimeUtc()
$probe = @'
$ErrorActionPreference = 'Stop'
try {
    if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ne 'S-1-5-19') { exit 2 }
    Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('SOURCE_BYTES')))
    $self = [Diagnostics.Process]::GetCurrentProcess()
    $own = [ProcessEndObservationFixture]::Open($self)
    try {
        if ([ProcessEndObservationFixture]::Observe($own, $self.StartTime.ToUniversalTime().ToFileTimeUtc(), 0) -ne 'running') { exit 3 }
    } finally { $own.Dispose(); $self.Dispose() }
    $target = [Diagnostics.Process]::GetProcessById(TARGET_PID)
    try {
        try { $other = [ProcessEndObservationFixture]::Open($target) }
        catch {
            $cause = $_.Exception.GetBaseException()
            if ($cause -is [ComponentModel.Win32Exception] -and $cause.NativeErrorCode -eq 5) { exit 42 }
            throw
        }
        try {
            if ([ProcessEndObservationFixture]::Observe($other, TARGET_TIME, 0) -eq 'running') { exit 43 }
        } finally { $other.Dispose() }
    } finally { $target.Dispose() }
} catch { exit 4 }
exit 5
'@
$probe = $probe.Replace('SOURCE_BYTES', [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($source)))
$probe = $probe.Replace('TARGET_PID', [string]$PID).Replace('TARGET_TIME', [string]$creation + 'L')
$command = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($probe))
$service = New-Object -ComObject Schedule.Service
$service.Connect()
$folder = $service.GetFolder('\')
$definition = $service.NewTask(0)
$definition.RegistrationInfo.Description = $tag
$definition.Principal.UserId = $sid
$definition.Principal.LogonType = 5
$definition.Principal.RunLevel = 0
$definition.Settings.ExecutionTimeLimit = 'PT1M'
$action = $definition.Actions.Create(0)
$action.Path = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell/v1.0/powershell.exe'
$action.WorkingDirectory = [Environment]::SystemDirectory
$action.Arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ' + $command
$task = $folder.RegisterTaskDefinition($tag, $definition, 2, $sid, $null, 5, 'D:P(A;;FA;;;SY)(A;;FA;;;BA)')
try {
    $null = $task.Run($null)
    $deadline = [DateTime]::UtcNow.AddSeconds(70)
    do {
        Start-Sleep -Milliseconds 200
        $task = $folder.GetTask($tag)
        if ($task.State -eq 3 -and $task.LastTaskResult -in @(42,43)) { break }
        if ($task.State -eq 3 -and $task.LastTaskResult -notin @(0,267009,267011)) { throw "Observer failed with task result $($task.LastTaskResult)." }
        if ([DateTime]::UtcNow -ge $deadline) { throw 'Observer deadline elapsed.' }
    } while ($true)
    [pscustomobject]@{ ownHandleVerified = $true; otherProcessAccess = if ($task.LastTaskResult -eq 42) { 'denied' } else { 'granted' } } | ConvertTo-Json -Compress
} finally {
    $current = $folder.GetTask($tag)
    if ($current.Definition.RegistrationInfo.Description -cne $tag -or $current.Definition.Actions.Item(1).Arguments -cne $action.Arguments) {
        throw 'Trial task changed. Cleanup withheld.'
    }
    if ($current.State -in @(2,4)) { $current.Stop(0) }
    $folder.DeleteTask($tag, 0)
}
