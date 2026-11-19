# Exercise the installer against an isolated directory and in-memory task and account adapters.
param([Parameter(Mandatory)][string]$FixtureRoot,[Parameter(Mandatory)][string]$Bundle,[Parameter(Mandatory)][string]$Digest)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../Update-CompletionBroker.ps1')
$root = Join-Path $FixtureRoot 'destination'
$null = [IO.Directory]::CreateDirectory($root)
$journal = Join-Path $root 'watcher-install.json'
$Package = $Bundle
$PackageDigest = $Digest
$hashes = Read-Package $Package
$scheduler = New-Object -ComObject Schedule.Service
$scheduler.Connect()
$script:registered = @{}
$script:fixtureUser = $null
$script:starts = 0
$script:renewals = 0
$script:interrupt = $true
$script:fixtureSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-21-1-2-3-1001')
function Must([bool]$ok,[string]$msg) { if (!$ok) { throw $msg } }
function Denied([scriptblock]$op,[string]$reason) {
    try { & $op | Out-Null } catch { if ($_.Exception.Message -like $reason) { return }; throw }
    throw 'A prohibited operation succeeded'
}
# The fixture grants no OS accounts or task registrations. Use the Windows
# scheduler's real definition objects to validate actions, triggers and SIDs.
$folder = [pscustomobject]@{}
$folder | Add-Member ScriptMethod GetTasks { param($flags) return $script:registered.Values }
$folder | Add-Member ScriptMethod GetTask { param($name) return $script:registered[$name] }
$folder | Add-Member ScriptMethod DeleteTask { param($name,$flags) $script:registered.Remove($name) }
$folder | Add-Member ScriptMethod RegisterTaskDefinition {
    param($name,$definition,$flags,$sid,$password,$type,$sddl)
    Must ($flags -eq 18) 'Unexpected registration flags'
    if ($name -eq $brokerTask) {
        Must ($type -eq 2 -and $sid -eq $script:fixtureSid.Value -and $password -and
            $password -ceq $script:fixtureCredential.GetNetworkCredential().Password) 'Wrong S4U registration credential'
    } else { Must ($type -eq 3 -and $null -eq $password) 'Interactive task received a credential' }
    if ($script:interrupt -and $name -eq $brokerTask) { throw 'Fixture interruption' }
    $task = [pscustomobject]@{Name=$name;Definition=$definition;State=3;Acl=$sddl}
    $task | Add-Member ScriptMethod GetSecurityDescriptor { param($flags) return $this.Acl }
    $task | Add-Member ScriptMethod Stop { param($flags) $this.State=3 }
    $script:registered.Add($name,$task)
    return $task
}
function Get-LocalUser { param($Name,$ErrorAction) return $script:fixtureUser }
function New-LocalUser {
    param($Name,[securestring]$Password,$Description,[switch]$PasswordNeverExpires,[switch]$UserMayNotChangePassword)
    Must ($null -eq $script:fixtureUser) 'Duplicate account creation'
    Must ($Name -eq $accountName -and $Password.Length -gt 20) 'Unexpected account credentials'
    $script:fixtureCredential = [pscredential]::new($Name,$Password.Copy())
    $script:fixtureUser = [pscustomobject]@{Description=$Description;SID=$script:fixtureSid;Enabled=$true}
    return $script:fixtureUser
}
function Set-LocalUser {
    param($SID,[securestring]$Password)
    Must ($SID -eq $script:fixtureSid -and $Password.Length -gt 20) 'Unexpected credential recovery target'
    $script:fixtureCredential.Password.Dispose()
    $script:fixtureCredential = [pscredential]::new($accountName,$Password.Copy())
    $script:renewals++
}
function Disable-LocalUser { param($SID) Must ($SID.Value -eq $script:fixtureSid.Value) 'Wrong user'; $script:fixtureUser.Enabled=$false }
function Enable-LocalUser { param($SID) Must ($SID.Value -eq $script:fixtureSid.Value) 'Wrong user'; $script:fixtureUser.Enabled=$true }
function Assert-Protected([string]$p) { Assert-PlainPath $p }
function New-AccessDirectory([string]$p,[string]$extra) {
    Must ([IO.Path]::GetDirectoryName($p) -eq $root) 'Unexpected fixture destination'
    $null = [IO.Directory]::CreateDirectory($p)
}
function Grant-StateAccess([string]$brokerSid,[string]$rights) { Must ($brokerSid -eq $script:fixtureSid.Value) 'Unexpected broker' }
function Start-VerifiedWatcher($broker) { $script:starts++; $broker.State=4 }

$inventory = [pscustomobject]@{}
$inventory | Add-Member ScriptMethod GetRunningTasks {
    param($flags)
    Must ($flags -eq 1) 'Hidden task enumeration required'
    return $script:runningRows
}
$actual = [pscustomobject]@{ Path="\$brokerTask"; EnginePID=123; State=4 }
$other = [pscustomobject]@{ Path="\other\$brokerTask"; EnginePID=456; State=4 }
$script:runningRows = @($other,$actual)
Must (Test-BrokerInstance $inventory 123) 'Hidden broker was missed'
Must (!(Test-BrokerInstance $inventory 456)) 'Same name in another folder was accepted'
Must (!(Test-BrokerInstance $inventory '123')) 'Invalid heartbeat PID was accepted'
$actual.State = 3
Must (!(Test-BrokerInstance $inventory 123)) 'Inactive instance was accepted'
$actual.State = 4
$script:runningRows = @($actual,$actual)
Must (!(Test-BrokerInstance $inventory 123)) 'Duplicate instances were accepted'

$Mode = 'Plan'
$before = @(Get-ChildItem -LiteralPath $root -Force).Count
$plan = Invoke-WatcherSetup $scheduler $folder | ConvertFrom-Json
Must (!$plan.managed -and (Get-ChildItem -LiteralPath $root -Force | Measure-Object).Count -eq $before) 'Plan modified the fixture'
$Mode = 'Apply'
Denied { Invoke-WatcherSetup $scheduler $folder } '*Fixture interruption*'
Must ($script:registered.Count -eq 1 -and $script:starts -eq 0) 'Interrupted installation started'
$script:interrupt = $false
Denied { Invoke-WatcherSetup $scheduler $folder } 'Missing broker task requires explicit password recovery*'
Must ($script:renewals -eq 0) 'Unapproved password reset'
$RenewBrokerPassword = $true
$script:fixtureUser.Description = 'unmanaged'
Denied { Invoke-WatcherSetup $scheduler $folder } 'The broker account name is already in use'
Must ($script:renewals -eq 0) 'Unmanaged password reset'
$script:fixtureUser.Description = (Get-Content $journal -Raw | ConvertFrom-Json).tag
Invoke-WatcherSetup $scheduler $folder | Out-Null
Must ($script:registered.Count -eq 2 -and $script:starts -eq 1 -and $script:renewals -eq 1) 'Setup did not recover'
$policy = Join-Path $root 'completion-policy.json'
[IO.File]::WriteAllText($policy,'{"v":1,"grants":[],"fixture":true}')
$state = Join-Path $root 'completion-state/jobs.sqlite'
[IO.File]::AppendAllText($state,'fixture-live-state')
$beforeHash = (Get-FileHash -LiteralPath $state).Hash
Invoke-WatcherSetup $scheduler $folder | Out-Null
Must ($script:renewals -eq 1) 'Healthy account password was reset'
Must ((Get-FileHash -LiteralPath $state).Hash -eq $beforeHash -and [IO.File]::ReadAllText($policy).Contains('fixture')) 'Reinstallation reset state'
$broker = $folder.GetTask($brokerTask)
Must ($broker.Definition.Principal.LogonType -eq 2 -and $broker.Definition.Triggers.Item(1).Type -eq 9) 'Unexpected broker logon'
Must ($folder.GetTask($workerTask).Definition.Triggers.Count -eq 0) 'Worker got an independent trigger'
$broker.Definition.Actions.Item(1).Arguments = 'unexpected'
Denied { Invoke-WatcherSetup $scheduler $folder } 'Managed task action changed'
$broker.Definition.Actions.Item(1).Arguments = '"' + (Join-Path $root 'relay/completion-broker.mjs') + '"'
$acl = $broker.Acl
$broker.Acl = 'O:BAG:BAD:(A;;GA;;;WD)'
Denied { Invoke-WatcherSetup $scheduler $folder } 'Writable task outside setup'
$broker.Acl = $acl
$Mode='Rollback'
Invoke-WatcherSetup $scheduler $folder | Out-Null
Must ($script:registered.Count -eq 0 -and !$script:fixtureUser.Enabled) 'Activation survived rollback'
Must ((Get-FileHash -LiteralPath $state).Hash -eq $beforeHash) 'Rollback lost state'
$Mode='Apply'
Invoke-WatcherSetup $scheduler $folder | Out-Null
Must ($script:registered.Count -eq 2 -and $script:fixtureUser.Enabled) 'Explicit reactivation failed'
$PreviousDigest=$Digest
$NextDigest='a'*64
$PreviousPackage=$Bundle
$NextPackage=Join-Path $FixtureRoot 'update'
$null=[IO.Directory]::CreateDirectory((Join-Path $NextPackage 'relay'))
$candidate=Join-Path $NextPackage $brokerMember
[IO.File]::WriteAllText($candidate,'fixture update')
$next=@{}+$hashes
$next[$brokerMember]=(Get-FileHash $candidate).Hash
$different=@{}+$next
$different['runtime/node.exe']='0'*64
Denied { Assert-BrokerDelta $hashes $different } 'This updater accepts only a broker module change'
Assert-BrokerDelta $hashes $next
$brokerMember='relay/completion-jobs.mjs'
Denied { Assert-BrokerDelta $hashes $next } 'This updater accepts only a broker module change'
$jobHashes=@{}+$hashes
$jobHashes[$brokerMember]='b'*64
Assert-BrokerDelta $hashes $jobHashes
$jobHashes['relay/completion-broker.mjs']='c'*64
Denied { Assert-BrokerDelta $hashes $jobHashes } 'This updater accepts only a broker module change'
$brokerMember='relay/completion-broker.mjs'
$Operation='Plan'
$plan=Invoke-BrokerUpdate $hashes $next | ConvertFrom-Json
Must ($plan.changed -ceq $brokerMember -and (Get-FileHash (Join-Path $root $brokerMember)).Hash -eq $hashes[$brokerMember]) 'Update plan changed installation'
function Stop-BrokerForUpdate { $folder.GetTask($brokerTask).State=3 }
function Start-UpdatedBroker {
    if ($script:failOnce) { $script:failOnce=$false; throw 'Fixture heartbeat absent' }
    $folder.GetTask($brokerTask).State=4
}
$Operation='Apply'
$script:failOnce=$true
Denied { Invoke-BrokerUpdate $hashes $next } 'Fixture heartbeat absent'
Must ((Get-FileHash (Join-Path $root $brokerMember)).Hash -eq $hashes[$brokerMember] -and
    (Get-Content $journal -Raw|ConvertFrom-Json).package -ceq $Digest) 'Update failed to restore original package'
Invoke-BrokerUpdate $hashes $next | Out-Null
Must ((Get-FileHash (Join-Path $root $brokerMember)).Hash -eq $next[$brokerMember] -and
    (Get-Content $journal -Raw|ConvertFrom-Json).package -ceq $NextDigest) 'New package was not recorded'
$oldRecord=Get-Content $journal -Raw|ConvertFrom-Json
$oldRecord.package=$Digest;Save-Record $oldRecord
Invoke-BrokerUpdate $hashes $next | Out-Null
Must ((Get-Content $journal -Raw|ConvertFrom-Json).package -ceq $NextDigest -and
    (Get-FileHash $state).Hash -eq $beforeHash -and $script:registered.Count -eq 2) 'Interrupted update lost state'
$PackageDigest=$NextDigest
& {
    $Component='Schedules'
    $PreviousDigest='1'*64
    $NextDigest=$Digest
    $NextPackage=$Bundle
    $previous=@{}+$hashes
    $previous.Remove('relay/schedule-watch.mjs')
    foreach ($member in $fileAdditions) { $previous.Remove($member) }
    $unexpected=@{}+$hashes
    $unexpected['provider/codex.exe']='2'*64
    Denied { Assert-BrokerDelta $previous $unexpected } 'Unexpected schedule package change'
    Assert-BrokerDelta $previous $hashes
    $Component='Files'
    $scheduleBase=@{}+$hashes
    foreach ($member in $fileAdditions) { $scheduleBase.Remove($member) }
    Assert-BrokerDelta $scheduleBase $hashes
    Denied { Assert-BrokerDelta $scheduleBase $unexpected } 'Unexpected file watch package change'
    Denied { Assert-BrokerDelta $hashes $hashes } 'Expected the first file watch package migration'
    $Component='Schedules'
    $root=Join-Path $FixtureRoot 'migration'
    $live=Join-Path $root 'relay'
    $null=[IO.Directory]::CreateDirectory($live)
    foreach ($name in $previous.Keys | Where-Object { $_.StartsWith('relay/') }) {
        [IO.File]::Copy((Join-Path $Bundle $name),(Join-Path $root $name))
    }
    $journal=Join-Path $root 'fixture.json'
    $record=[pscustomobject]@{package=$PreviousDigest;brokerSid=$script:fixtureSid.Value}
    $Operation='Plan'
    Update-ScheduleModules $previous $hashes $record | Out-Null
    Must (@(Get-ChildItem $root).Count -eq 1) 'Schedule plan wrote to disk'
    $Operation='Apply'
    $script:failOnce=$true
    Denied { Update-ScheduleModules $previous $hashes $record } 'Fixture heartbeat absent'
    Assert-ModuleTree $live $previous
    Must ($record.package -eq $PreviousDigest) 'Failed schedule migration changed journal'
    # Simulate interruption between the two same-parent directory renames.
    $backup=Join-Path $root ('schedule-previous-'+$PreviousDigest)
    if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($backup)) -ne [IO.Path]::GetFullPath($root) -or
        [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($live)) -ne [IO.Path]::GetFullPath($root)) { throw 'Invalid fixture directory' }
    [IO.Directory]::Move($live,$backup)
    Update-ScheduleModules $previous $hashes $record | Out-Null
    Assert-ModuleTree $live $hashes
    Assert-ModuleTree $backup $previous
    Must ($record.package -eq $NextDigest) 'Recovered schedule package missing journal'
}
[IO.File]::Delete($state)
Denied { Invoke-WatcherSetup $scheduler $folder } 'The initialized job database is missing'
. (Join-Path $PSScriptRoot '../Test-InstalledCodexWatcher.ps1') -Stage Start -TrialId ([guid]::NewGuid()) -ExpectedPackage $Digest
& {
    $image=Join-Path $FixtureRoot 'codex.exe'
    [IO.File]::WriteAllText($image,'fixture')
    $hash=(Get-FileHash -LiteralPath $image).Hash
    Denied { Assert-McpClient 'codex.exe' $hash } 'Expected an absolute Codex client executable'
    Denied { Assert-McpClient $image $hash } 'MCP qualification requires the installed code-mode host'
    [IO.File]::WriteAllText((Join-Path $FixtureRoot 'codex-code-mode-host.exe'),'fixture')
    Denied { Assert-McpClient $image ('0'*64) } 'Client executable differs from the reviewed session client'
    Assert-McpClient $image $hash
}
& {
    $root=Join-Path $FixtureRoot 'restore'
    $null=[IO.Directory]::CreateDirectory((Join-Path $root 'completion-health'))
    $policyFile=Join-Path $root 'policy'
    $flagFile=Join-Path $root 'flag'
    [IO.File]::WriteAllText($policyFile,'{"v":1,"grants":[]}')
    [IO.File]::WriteAllText($flagFile,'{"v":1,"enabled":false}')
    [IO.File]::WriteAllText((Join-Path $root 'completion-health/watcher.json'),'{"mode":"reports_only"}')
    $script:restoreStarts=0
    $folder.GetTask($brokerTask).State=3
    function Start-VerifiedWatcher($task) {
        $script:restoreStarts++
        if ($script:restoreStarts -eq 1) { throw 'Fixture startup failure' }
    }
    Restart-TrialBroker 'reports_only'
    Must ($script:restoreStarts -eq 2) 'Idle restoration was not recovered'
    $script:restoreStarts=0
    Denied { Restart-TrialBroker 'watching' } 'Fixture startup failure'
    Must ($script:restoreStarts -eq 1) 'Delivery startup was retried'
    [IO.File]::WriteAllText($policyFile,'{"v":3,"grants":[],"schedules":[]}')
    $script:restoreStarts=0
    Denied { Restart-TrialBroker 'reports_only' } 'Fixture startup failure'
    Must ($script:restoreStarts -eq 1) 'A trial policy was still present during retry'
}
$node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
$trial = $FixtureRoot
$verifier = Join-Path $FixtureRoot 'environment.cjs'
[IO.File]::WriteAllText($verifier,"process.stdout.write([process.env.NODE_OPTIONS,process.env.NODE_PATH,process.env.RELAY_TEST_PARENT].every(x=>x===undefined)?'clean':'inherited')")
$env:RELAY_TEST_PARENT='fixture'
$env:NODE_OPTIONS='--require=missing-fixture-preload'
Must ((Get-TrialOutcome $FixtureRoot ([guid]::NewGuid())) -ceq 'clean') 'Verifier inherited parent environment'
'Isolated setup, recovery, refusal, rollback and reactivation passed.'
