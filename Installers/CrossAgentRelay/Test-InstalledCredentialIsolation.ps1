# Offline qualification with an ephemeral synthetic challenge on an idle installation.
[CmdletBinding()]
param(
    [ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedPackage,
    [switch]$DesktopRead
)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $PSHOME 'Modules'
$trialId = [guid]::NewGuid()
. (Join-Path $PSScriptRoot 'Test-InstalledCodexWatcher.ps1') -Stage Run -TrialId $trialId -ExpectedPackage $ExpectedPackage
$directory = Join-Path $root 'branch-credential-trial'
$challenge = Join-Path $directory 'challenge.bin'
$receipt = Join-Path $root 'completion-health/branch-challenge.sha256'
$record = Get-Content -LiteralPath $journal -Raw | ConvertFrom-Json
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($record.sessionSid -ne $desktopSid -or $record.brokerSid -eq $desktopSid -or
    $record.package -cne $ExpectedPackage -or $record.status -cne 'installed') { throw 'Installation mismatch' }
if ($DesktopRead) {
    if ($elevated) { throw 'Expected ordinary desktop token' }
    foreach ($access in @('Read','Write')) {
        try { $stream = [IO.File]::Open($challenge,'Open',$access,'ReadWrite'); $stream.Dispose() }
        catch [UnauthorizedAccessException] { continue }
        throw 'Ordinary desktop could open the challenge'
    }
    exit 32
}
if (!$elevated -or $PSVersionTable.PSEdition -ne 'Desktop') { throw 'Run this check from elevated Windows PowerShell' }
foreach ($file in @($PSCommandPath,(Join-Path $PSScriptRoot 'Test-InstalledCodexWatcher.ps1'),
    (Join-Path $PSScriptRoot 'Install-CompletionWatcher.ps1'),$root,$journal)) { Assert-Protected $file }
$scheduler = New-Object -ComObject Schedule.Service
$scheduler.Connect()
$folder = $scheduler.GetFolder('\')
foreach ($name in @($brokerTask,$workerTask)) { Assert-RegisteredTask ($folder.GetTask($name)) $record }
$policyFile = Join-Path $root 'completion-policy.json'
$flagFile = Join-Path $root 'completion-worker.json'
$lockFile = Join-Path $root 'watcher-install.lock'
foreach ($file in @($policyFile,$flagFile,$lockFile)) { Assert-Protected $file }
$name = 'RelayCredentialCheck-' + [guid]::NewGuid().ToString('N')
$lock = [IO.File]::Open($lockFile,'Open','ReadWrite','None')
$created = $false
$task = $null
try {
    if ([IO.File]::ReadAllText($policyFile) -cne '{"v":1,"grants":[]}' -or
        [IO.File]::ReadAllText($flagFile) -cne '{"v":1,"enabled":false}' -or
        $folder.GetTask($workerTask).State -ne 3 -or (Test-Path -LiteralPath $receipt)) { throw 'Trial requires idle installation' }
    $brokerSid = [Security.Principal.SecurityIdentifier]::new($record.brokerSid).Value
    New-AccessDirectory $directory "(A;OICI;GRGX;;;$brokerSid)"
    $created = $true
    Add-Type -AssemblyName System.Security
    $marker = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $rng.GetBytes($marker)
        $entropy = [Text.Encoding]::ASCII.GetBytes('relay-branch-credential-challenge-v1')
        $sealed = [Security.Cryptography.ProtectedData]::Protect($marker,$entropy,'LocalMachine')
        $expected = [BitConverter]::ToString($sha.ComputeHash($marker)).Replace('-','').ToLowerInvariant()
        [IO.File]::WriteAllBytes($challenge,$sealed)
    } finally { $sha.Dispose(); $rng.Dispose(); [Array]::Clear($marker,0,$marker.Length) }
    $def = $scheduler.NewTask(0)
    $def.Principal.UserId = $desktopSid
    $def.Principal.LogonType = 3
    $def.Principal.RunLevel = 0
    $def.Settings.Hidden = $true
    $def.Settings.ExecutionTimeLimit = 'PT1M'
    $def.Settings.DisallowStartIfOnBatteries = $false
    $def.Settings.StopIfGoingOnBatteries = $false
    $action = $def.Actions.Create(0)
    $action.Path = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell/v1.0/powershell.exe'
    $action.WorkingDirectory = $PSScriptRoot
    $action.Arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "'+$PSCommandPath+'" -DesktopRead -ExpectedPackage '+$ExpectedPackage
    # TASK_CREATE refuses replacement of any existing registration.
    $task = $folder.RegisterTaskDefinition($name,$def,2,$desktopSid,$null,3,'O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)')
    $null = $task.Run($null)
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $status = $folder.GetTask($name)
        if ($status.State -eq 3 -and $status.LastTaskResult -eq 32) { break }
        if ([DateTime]::UtcNow -gt $deadline) { throw 'Desktop access denial unproved' }
        Start-Sleep -Milliseconds 200
    } while ($true)
    Restart-TrialBroker 'reports_only'
    if (![IO.File]::Exists($receipt) -or [IO.File]::ReadAllText($receipt) -cne $expected) {
        throw 'Broker challenge response unproved'
    }
} finally {
    try {
        if ($task) {
            if ($task.State -in 2,4) { $task.Stop(0) }
            $folder.DeleteTask($name,0)
        }
    } finally {
        try {
            if ($created) {
                [IO.File]::Delete($challenge)
                [IO.Directory]::Delete($directory,$false)
                [IO.File]::Delete($receipt)
            }
        } finally { $lock.Dispose() }
    }
}
'Installed broker decrypted the synthetic record. The ordinary desktop was denied read and write access.'
