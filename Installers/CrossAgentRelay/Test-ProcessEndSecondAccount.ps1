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
$creation = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToFileTimeUtc()
. (Join-Path $PSScriptRoot 'fixtures/ProcessEndProbeCommand.ps1')
$command = New-ProcessEndProbeCommand $sid $PID $creation
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
