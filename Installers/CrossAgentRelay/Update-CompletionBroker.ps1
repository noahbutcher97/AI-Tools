# Apply a reviewed broker-only package change while preserving task identities and job state.
[CmdletBinding()]
param(
    [ValidateSet('Plan','Apply')][string]$Operation = 'Plan',
    [string]$PreviousPackage, [string]$PreviousDigest,
    [string]$NextPackage, [string]$NextDigest
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Install-CompletionWatcher.ps1')
$brokerMember = 'relay/completion-broker.mjs'

function Get-ReviewedHashes($dir,$PackageDigest) {
    if (![IO.Path]::IsPathRooted($dir) -or $PackageDigest -cnotmatch '^[a-f0-9]{64}$') { throw 'Expected a reviewed package and digest' }
    return Read-Package $dir
}

function Assert-BrokerDelta($previous,$next) {
    foreach ($member in $members) {
        if ($member -ne $brokerMember -and $previous[$member] -ne $next[$member]) {
            throw 'This updater accepts only a broker module change'
        }
    }
    if ($previous[$brokerMember] -eq $next[$brokerMember]) { throw 'The broker module is unchanged' }
}

function Set-ReviewedBroker($source,$expected,$replacement) {
    $dest = Join-Path $root $brokerMember
    Assert-Protected $dest
    if ((Get-FileHash $dest).Hash -ne $expected) { throw 'Installed broker changed' }
    $staged = Join-Path ([IO.Path]::GetDirectoryName($dest)) ([guid]::NewGuid().ToString('N')+'.tmp')
    try {
        Copy-ReviewedFile (Join-Path $source $brokerMember) $staged $replacement
        [IO.File]::Replace($staged,$dest,[System.Management.Automation.Language.NullString]::Value)
    } finally { if ([IO.File]::Exists($staged)) { [IO.File]::Delete($staged) } }
}

function Stop-BrokerForUpdate {
    $task = $folder.GetTask($brokerTask)
    if ($task.State -in 2,4) { $task.Stop(0) }
    $end = [DateTime]::UtcNow.AddSeconds(15)
    while ($folder.GetTask($brokerTask).State -in 2,4) {
        if ([DateTime]::UtcNow -gt $end) { throw 'Broker stop timed out' }
        Start-Sleep -Milliseconds 150
    }
}

function Start-UpdatedBroker {
    # A logon trigger may have fired while the module was being replaced.
    Stop-BrokerForUpdate
    Start-VerifiedWatcher ($folder.GetTask($brokerTask))
    $beat = Get-Content (Join-Path $root 'completion-health/watcher.json') -Raw | ConvertFrom-Json
    if ($beat.mode -cne 'reports_only') { throw 'Unexpected broker delivery mode' }
}

function Invoke-BrokerUpdate($previous,$next) {
    Assert-Protected $root
    Assert-Protected $journal
    $record = Get-Content $journal -Raw | ConvertFrom-Json
    $account = Get-LocalUser -Name $accountName
    if ($record.v -ne 1 -or !$record.initialized -or $record.status -cne 'installed' -or
        $record.package -cnotin @($PreviousDigest,$NextDigest) -or $record.sessionSid -ne $desktopSid -or
        !$account.Enabled -or $account.SID.Value -ne $record.brokerSid -or $account.Description -cne $record.tag) {
        throw 'Expected the installed package and assigned principals'
    }
    foreach ($taskName in @($brokerTask,$workerTask)) { Assert-RegisteredTask ($folder.GetTask($taskName)) $record }
    foreach ($name in @('completion-worker.json','completion-policy.json')) { Assert-Protected (Join-Path $root $name) }
    $settings = Get-Content (Join-Path $root 'completion-worker.json') -Raw | ConvertFrom-Json
    $policy = Get-Content (Join-Path $root 'completion-policy.json') -Raw | ConvertFrom-Json
    if ($settings.v -ne 1 -or $settings.enabled -isnot [bool] -or $settings.enabled -or $policy.v -ne 1 -or
        $policy.grants -isnot [array] -or $policy.grants.Count -or $folder.GetTask($workerTask).State -ne 3) {
        throw 'Broker update requires idle worker, disabled delivery and empty policy'
    }
    foreach ($member in $members) {
        if ($member -eq 'initial/jobs.sqlite') { continue }
        $file = Join-Path $root $member
        Assert-Protected $file
        $hash = (Get-FileHash $file).Hash
        if ($member -eq $brokerMember) {
            $current = $hash
            if ($current -notin @($previous[$member],$next[$member])) { throw 'Unrecognized installed broker' }
        } elseif ($hash -ne $previous[$member]) { throw 'Installed package member differs' }
    }
    if ($Operation -eq 'Plan') {
        [pscustomobject]@{previous=$PreviousDigest;next=$NextDigest;changed=$brokerMember;delivery='reports_only'} | ConvertTo-Json -Compress
        return
    }
    # Either component may already be current after interruption between file and journal writes.
    Stop-BrokerForUpdate
    try {
        if ($current -ne $next[$brokerMember]) { Set-ReviewedBroker $NextPackage $current $next[$brokerMember] }
        Start-UpdatedBroker
        $record.package=$NextDigest
        Save-Record $record
    } catch {
        Stop-BrokerForUpdate
        $observed=(Get-FileHash (Join-Path $root $brokerMember)).Hash
        if ($observed -ne $previous[$brokerMember]) { Set-ReviewedBroker $PreviousPackage $next[$brokerMember] $previous[$brokerMember] }
        Start-UpdatedBroker
        $record.package=$PreviousDigest
        Save-Record $record
        throw
    }
    'Updated broker verified in reports-only mode.'
}

if ($MyInvocation.InvocationName -eq '.') { return }
if ($PSVersionTable.PSEdition -ne 'Desktop' -or ![Environment]::Is64BitProcess) { throw 'Use 64-bit Windows PowerShell' }
$previous = Get-ReviewedHashes $PreviousPackage $PreviousDigest
$next = Get-ReviewedHashes $NextPackage $NextDigest
Assert-BrokerDelta $previous $next
$scheduler = New-Object -ComObject Schedule.Service
$scheduler.Connect()
$folder = $scheduler.GetFolder('\')
Assert-Protected ([Environment]::GetFolderPath('ProgramFiles'))
if ($Operation -eq 'Plan') { Invoke-BrokerUpdate $previous $next; return }
if (!([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Applying a reviewed package update requires an administrator'
}
$lockFile = Join-Path $root 'watcher-install.lock'
Assert-Protected $lockFile
$lock = [IO.File]::Open($lockFile,'Open','ReadWrite','None')
try { Invoke-BrokerUpdate $previous $next } finally { $lock.Dispose() }
