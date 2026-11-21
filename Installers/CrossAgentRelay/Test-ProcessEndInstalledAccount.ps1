# Run from the reviewed administrator-controlled tool directory, in Windows PowerShell.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedPackage,
    [Parameter(Mandatory)][guid]$TrialId,
    [switch]$RotateBrokerPassword
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Install-CompletionWatcher.ps1')
foreach ($path in @($PSScriptRoot,$PSCommandPath,(Join-Path $PSScriptRoot 'Install-CompletionWatcher.ps1'),
        (Join-Path $PSScriptRoot 'fixtures/ProcessEndProbeCommand.ps1'),(Join-Path $PSScriptRoot 'fixtures/ProcessEndObservation.cs'),
        $root,$journal,(Join-Path $root 'watcher-install.lock'),(Join-Path $root 'completion-worker.json'),
        (Join-Path $root 'completion-policy.json'))) { Assert-Protected $path }
. (Join-Path $PSScriptRoot 'fixtures/ProcessEndProbeCommand.ps1')
if ($TrialId -eq [guid]::Empty -or $PSVersionTable.PSEdition -ne 'Desktop' -or
    !([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Use elevated Windows PowerShell and a fresh trial identifier.'
}
$image = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell/v1.0/powershell.exe'
$tag = 'RelayProcessEnd-' + $TrialId.ToString('N')
$scheduler = New-Object -ComObject Schedule.Service
$scheduler.Connect()
$folder = $scheduler.GetFolder('\')

function New-ProbeTask($suffix,$sid,$logon,$arguments,[securestring]$password) {
    $d = $scheduler.NewTask(0)
    $d.RegistrationInfo.Description = $tag
    $d.Principal.UserId = $sid
    $d.Principal.LogonType = $logon
    $d.Principal.RunLevel = 0
    $d.Settings.ExecutionTimeLimit = 'PT2M'
    $d.Settings.MultipleInstances = 2
    $d.Settings.Hidden = $true
    $d.Settings.DisallowStartIfOnBatteries = $false
    $d.Settings.StopIfGoingOnBatteries = $false
    $action = $d.Actions.Create(0)
    $action.Path = $image
    $action.WorkingDirectory = [Environment]::SystemDirectory
    $action.Arguments = $arguments
    $name = $tag + $suffix
    $acl = 'O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)'
    if ($logon -eq 2) {
        $credential = [pscredential]::new($sid,$password)
        return $folder.RegisterTaskDefinition($name,$d,18,$sid,$credential.GetNetworkCredential().Password,$logon,$acl)
    }
    return $folder.RegisterTaskDefinition($name,$d,18,$sid,$null,$logon,$acl)
}

function Remove-ProbeTask($task,$arguments) {
    if (!$task) { return }
    $t = $folder.GetTask($task.Name)
    $d = $t.Definition
    if ($d.RegistrationInfo.Description -cne $tag -or $d.Actions.Count -ne 1 -or
        $d.Actions.Item(1).Path -ine $image -or $d.Actions.Item(1).Arguments -cne $arguments) { throw 'Trial task changed' }
    if ($t.State -in 2,4) {
        $t.Stop(0)
        $end = [datetime]::UtcNow.AddSeconds(10)
        while ($folder.GetTask($task.Name).State -in 2,4) {
            if ([datetime]::UtcNow -ge $end) { throw 'Trial task did not stop' }
            Start-Sleep -Milliseconds 100
        }
    }
    $folder.DeleteTask($task.Name,0)
}

function Get-PinnedTarget($instance,$arguments) {
    $end = [datetime]::UtcNow.AddSeconds(12)
    do {
        $instance.Refresh()
        $engine = [int]$instance.EnginePID
        if ($engine -gt 0) {
            $rows = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' AND (ProcessId=$engine OR ParentProcessId=$engine)" |
                Where-Object { $_.ExecutablePath -ieq $image -and $_.CommandLine.EndsWith($arguments,[StringComparison]::Ordinal) })
            if ($rows.Count -gt 1) { throw 'Ambiguous trial process' }
            if ($rows.Count -eq 1) {
                $row = $rows[0]
                $proc = [Diagnostics.Process]::GetProcessById($row.ProcessId)
                try {
                    $null = $proc.SafeHandle
                    $owner = Invoke-CimMethod -InputObject $row -MethodName GetOwnerSid
                    if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne $desktopSid -or $proc.SessionId -le 0 -or
                        $proc.HasExited -or $proc.MainModule.FileName -ine $image -or
                        [math]::Abs(($proc.StartTime - $row.CreationDate).TotalMilliseconds) -gt 1) { throw 'Trial process changed' }
                    return $proc
                } catch { $proc.Dispose(); throw }
            }
        }
        Start-Sleep -Milliseconds 150
    } while ([datetime]::UtcNow -lt $end)
    throw 'No unique live process matched the ordinary trial task'
}

$targetTask = $observerTask = $target = $null
$lock = [IO.File]::Open((Join-Path $root 'watcher-install.lock'),'Open','ReadWrite','None')
try {
    $record = Get-Content -LiteralPath $journal -Raw | ConvertFrom-Json
    if ($record.status -cne 'installed' -or $record.sessionSid -cne $desktopSid -or
        $record.brokerSid -eq $desktopSid -or $record.package -cne $ExpectedPackage) { throw 'Installation mismatch' }
    $account = Get-LocalUser -Name $accountName
    if (!$account.Enabled -or $account.SID.Value -cne $record.brokerSid -or $account.Description -cne $record.tag) { throw 'Broker account mismatch' }
    foreach ($name in @($brokerTask,$workerTask)) { Assert-RegisteredTask ($folder.GetTask($name)) $record }
    if ($folder.GetTask($brokerTask).State -ne 4 -or $folder.GetTask($workerTask).State -ne 3 -or
        [IO.File]::ReadAllText((Join-Path $root 'completion-policy.json')) -cne '{"v":1,"grants":[]}' -or
        [IO.File]::ReadAllText((Join-Path $root 'completion-worker.json')) -cne '{"v":1,"enabled":false}') { throw 'Trial requires an idle reports-only installation' }
    $seconds = if ($RotateBrokerPassword) { 60 } else { 5 }
    $desktopCode = '$i=[Security.Principal.WindowsIdentity]::GetCurrent();if($i.User.Value -ne '''+$desktopSid+
        ''' -or ([Security.Principal.WindowsPrincipal]::new($i)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){exit 6};'+
        'Start-Sleep -Seconds '+$seconds+';exit 44 #'+$tag
    $targetArgs = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand '+
        [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($desktopCode))
    $targetTask = New-ProbeTask '-Desktop' $desktopSid 3 $targetArgs
    $instance = $targetTask.Run($null)
    $target = Get-PinnedTarget $instance $targetArgs
    if (!$RotateBrokerPassword) {
        if (!$target.WaitForExit(12000) -or $target.ExitCode -ne 44) { throw 'Ordinary target control failed' }
        'Desktop fixture verified. Broker check requires the approved rotation switch.'
        return
    }
    $command = New-ProcessEndProbeCommand $record.brokerSid $target.Id $target.StartTime.ToUniversalTime().ToFileTimeUtc()
    $observerArgs = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand '+$command
    if ($target.HasExited) { throw 'Desktop trial process ended before registration' }
    $password = New-BrokerPassword
    try {
        Set-LocalUser -SID $account.SID -Password $password
        $observerTask = New-ProbeTask '-Observer' $record.brokerSid 2 $observerArgs $password
    } finally { $password.Dispose() }
    $null = $observerTask.Run($null)
    $end = [datetime]::UtcNow.AddSeconds(45)
    do {
        Start-Sleep -Milliseconds 200
        $current = $folder.GetTask($observerTask.Name)
        if ($current.State -eq 3 -and $current.LastTaskResult -in 42,43) { break }
        if ($current.State -eq 3 -and $current.LastTaskResult -notin 0,267009,267011) {
            throw "Broker trial inconclusive. Task result $($current.LastTaskResult)."
        }
        if ($target.HasExited -or [datetime]::UtcNow -ge $end) { throw 'Broker trial deadline or lost target' }
    } while ($true)
    if ($target.HasExited) { throw 'Lost trial process' }
    if (!$target.WaitForExit(65000) -or $target.ExitCode -ne 44) { throw 'Ordinary target control failed' }
    [pscustomobject]@{ enrolledBrokerLogon = $true; ownHandleVerified = $true
        desktopProcessAccess = if ($current.LastTaskResult -eq 42) { 'denied' } else { 'granted' } } | ConvertTo-Json -Compress
} finally {
    try { Remove-ProbeTask $observerTask $observerArgs } finally {
        try { Remove-ProbeTask $targetTask $targetArgs } finally {
            if ($target) { $target.Dispose() }
            $lock.Dispose()
        }
    }
}
