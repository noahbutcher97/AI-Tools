# Apply a reviewed broker-only package change while preserving task identities and job state.
[CmdletBinding()]
param(
    [ValidateSet('Plan','Apply')][string]$Operation = 'Plan',
    [string]$PreviousPackage, [string]$PreviousDigest,
    [string]$NextPackage, [string]$NextDigest,
    [ValidateSet('Broker','Jobs','Schedules','Files','Branches','BranchUpdate','Acl')][string]$Component = 'Broker'
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Install-CompletionWatcher.ps1')
$brokerMember = switch ($Component) {
    'Jobs' { 'relay/completion-jobs.mjs' }
    'Acl' { 'relay/completion-acl.ps1' }
    default { 'relay/completion-broker.mjs' }
}

function Get-ReviewedHashes($dir,$PackageDigest,[switch]$AllowLegacy) {
    if (![IO.Path]::IsPathRooted($dir) -or $PackageDigest -cnotmatch '^[a-f0-9]{64}$') { throw 'Expected a reviewed package and digest' }
    return Read-Package $dir -AllowLegacy:$AllowLegacy
}

function Get-RollbackStoreFormat($dir,$expectedHash) {
    $file = Join-Path $dir 'relay/completion-jobs.mjs'
    Assert-PlainPath $file
    $bytes = [IO.File]::ReadAllBytes($file)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-','') }
    finally { $sha.Dispose() }
    if ($hash -ne $expectedHash) { throw 'Store module changed' }
    $versions = [regex]::Matches([Text.Encoding]::UTF8.GetString($bytes), '(?m)^const BROKER_STORE_VERSION = ([1-9][0-9]*);\r?$')
    if ($versions.Count -ne 1) { throw 'Unknown rollback store format. Use a qualified whole-package upgrade.' }
    return $versions[0].Groups[1].Value
}

function Assert-BrokerDelta($previous,$next) {
    if ($Component -eq 'BranchUpdate') {
        $allowed = @($branchModule,'relay/schedule-watch.mjs','relay/completion-broker.mjs')
        $changed = $false
        foreach ($member in $members) {
            if (!$previous.ContainsKey($member) -or !$next.ContainsKey($member)) { throw 'Expected complete branch packages' }
            if ($previous[$member] -eq $next[$member]) { continue }
            if ($member -cnotin $allowed) { throw 'Unexpected branch update member' }
            $changed = $true
        }
        if (!$changed) { throw 'Branch modules are unchanged' }
        return
    }
    if ($Component -in @('Files','Branches')) {
        $allowed = @('completion-broker','completion-jobs','completion-protocol','completion-session','schedule-watch','watcher-health') | ForEach-Object { "relay/$_.mjs" }
        $allowed += @('relay/completion-acl.ps1',$branchModule)
        if ($Component -eq 'Files') {
            foreach ($member in $fileAdditions) {
                if ($previous.ContainsKey($member) -or !$next.ContainsKey($member)) { throw 'Expected the first file watch package migration' }
            }
            $allowed += $fileAdditions
        } elseif ($previous.ContainsKey($branchModule) -or !$previous.ContainsKey('relay/FileObservation.exe') -or !$next.ContainsKey($branchModule)) {
            throw 'Expected the first branch watch package migration'
        }
        if (!$previous.ContainsKey('relay/schedule-watch.mjs')) { throw 'Expected a schedule package' }
        foreach ($member in $members) {
            if ($member -cnotin $allowed -and $previous[$member] -ne $next[$member]) { throw 'Unexpected file watch package change' }
        }
        return
    }
    if ($Component -eq 'Schedules') {
        $allowed = @('client','completion-broker','completion-jobs','completion-protocol','completion-session','run-handoff','schedule-watch','watcher-health') | ForEach-Object { "relay/$_.mjs" }
        $allowed += @('relay/completion-acl.ps1',$branchModule)
        foreach ($member in $members) {
            if ($member -cnotin $allowed -and $member -cnotin $fileAdditions -and $previous[$member] -ne $next[$member]) { throw 'Unexpected schedule package change' }
        }
        if ($previous.ContainsKey('relay/schedule-watch.mjs') -or !$next.ContainsKey('relay/schedule-watch.mjs')) {
            throw 'Expected the first schedule package migration'
        }
        return
    }
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

function Assert-ModuleTree($directory,$hashes) {
    Assert-Protected $directory
    $files = @(Get-ChildItem -LiteralPath $directory -Force)
    $expected = @($hashes.Keys | Where-Object { $_.StartsWith('relay/') })
    if ($files.Count -ne $expected.Count) { throw 'Unexpected module directory contents' }
    foreach ($file in $files) {
        $member = 'relay/' + $file.Name
        Assert-Protected $file.FullName
        if ($file.PSIsContainer -or $member -cnotin $expected -or (Get-FileHash -LiteralPath $file.FullName).Hash -ne $hashes[$member]) {
            throw 'Unexpected module directory contents'
        }
    }
}

function Update-ScheduleModules($previous,$next,$record) {
    $live = Join-Path $root 'relay'
    $kind = if ($Component -in @('Branches','BranchUpdate')) { 'branch' } elseif ($Component -eq 'Files') { 'file' } else { 'schedule' }
    $stage = Join-Path $root ($kind+'-stage-'+$NextDigest)
    $backup = Join-Path $root ($kind+'-previous-'+$PreviousDigest)
    foreach ($dir in @($live,$stage,$backup)) {
        if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($dir)) -ne [IO.Path]::GetFullPath($root)) { throw 'Invalid module directory' }
        if (Test-Path -LiteralPath $dir) { Assert-Protected $dir }
    }
    $saved = Test-Path -LiteralPath $backup
    $active = Test-Path -LiteralPath $live
    if (!$saved -and !$active) { throw 'Installed modules missing' }
    if ($saved) { Assert-ModuleTree $backup $previous }
    if ($active) {
        if ($saved) { Assert-ModuleTree $live $next }
        else { Assert-ModuleTree $live $previous }
    }
    if ($Operation -eq 'Plan') {
        [pscustomobject]@{previous=$PreviousDigest;next=$NextDigest;changed=($kind+' modules');delivery='reports_only'} | ConvertTo-Json -Compress
        return
    }
    if (!$saved -or !$active) {
        if (!(Test-Path -LiteralPath $stage)) { New-AccessDirectory $stage "(A;OICI;GRGX;;;$($record.brokerSid))(A;OICI;GRGX;;;$desktopSid)" }
        foreach ($member in $next.Keys | Where-Object { $_.StartsWith('relay/') }) {
            $dest = Join-Path $stage $member.Substring(6)
            if (!(Test-Path -LiteralPath $dest)) { Copy-ReviewedFile (Join-Path $NextPackage $member) $dest $next[$member] }
        }
        Assert-ModuleTree $stage $next
    } elseif (Test-Path -LiteralPath $stage) { throw 'Unexpected extra staged directory' }
    Stop-BrokerForUpdate
    try {
        if (!$saved) { [IO.Directory]::Move($live,$backup) }
        if (!(Test-Path -LiteralPath $live)) { [IO.Directory]::Move($stage,$live) }
        Assert-ModuleTree $live $next
        Start-UpdatedBroker
        $record.package = $NextDigest
        Save-Record $record
    } catch {
        Stop-BrokerForUpdate
        if (Test-Path -LiteralPath $backup) {
            Assert-ModuleTree $backup $previous
            if (Test-Path -LiteralPath $live) {
                Assert-ModuleTree $live $next
                [IO.Directory]::Move($live,$stage)
            }
            [IO.Directory]::Move($backup,$live)
        }
        Assert-ModuleTree $live $previous
        Start-UpdatedBroker
        $record.package = $PreviousDigest
        Save-Record $record
        throw
    }
    "$kind watch modules verified in reports-only mode."
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
        if ($Component -in @('Branches','BranchUpdate','Files','Schedules') -and $member.StartsWith('relay/')) { continue }
        $file = Join-Path $root $member
        Assert-Protected $file
        $hash = (Get-FileHash $file).Hash
        if ($member -eq $brokerMember) {
            $current = $hash
            if ($current -notin @($previous[$member],$next[$member])) { throw 'Unrecognized installed broker' }
        } elseif ($hash -ne $previous[$member]) { throw 'Installed package member differs' }
    }
    if ($Component -in @('Branches','BranchUpdate','Files','Schedules')) {
        Update-ScheduleModules $previous $next $record
        return
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
$previous = Get-ReviewedHashes $PreviousPackage $PreviousDigest -AllowLegacy:($Component -in @('Branches','Files','Schedules'))
$next = Get-ReviewedHashes $NextPackage $NextDigest
Assert-BrokerDelta $previous $next
$jobs = 'relay/completion-jobs.mjs'
if ($previous[$jobs] -ne $next[$jobs]) {
    $priorFormat = Get-RollbackStoreFormat $PreviousPackage $previous[$jobs]
    if ($priorFormat -cne (Get-RollbackStoreFormat $NextPackage $next[$jobs])) {
        throw 'Incompatible rollback store format. Use a qualified whole-package upgrade.'
    }
}
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
