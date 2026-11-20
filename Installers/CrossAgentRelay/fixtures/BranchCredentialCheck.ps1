param([Parameter(Mandatory)][string]$FixtureRoot)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../../MCP-Servers/bridges/relay/completion-acl.ps1')
Add-Type -AssemblyName System.Security
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$dir = Join-Path $FixtureRoot 'branch-credential-trial'
$health = Join-Path $FixtureRoot 'completion-health'
$null = [IO.Directory]::CreateDirectory($dir)
$null = [IO.Directory]::CreateDirectory($health)
$acl = [IO.Directory]::GetAccessControl($dir)
$acl.SetAccessRuleProtection($true,$false)
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
[IO.Directory]::SetAccessControl($dir,$acl)
$authorities = @($sid.Value,$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value)
$file = Join-Path $dir 'challenge.bin'
$receipt = Join-Path $health 'branch-challenge.sha256'
$marker = [Text.Encoding]::ASCII.GetBytes(('x'*32))
$entropy = [Text.Encoding]::ASCII.GetBytes('relay-branch-credential-challenge-v1')
$sealed = [Security.Cryptography.ProtectedData]::Protect($marker,$entropy,'LocalMachine')
$sha = [Security.Cryptography.SHA256]::Create()
try { $expected = [BitConverter]::ToString($sha.ComputeHash($marker)).Replace('-','').ToLowerInvariant() }
finally { $sha.Dispose() }
function Denied {
    $failed=$false
    try { Test-BranchCredentialChallenge $FixtureRoot $authorities $sid.Value } catch { $failed=$true }
    if (!$failed -or [IO.File]::Exists($receipt)) { throw 'Invalid challenge produced a receipt' }
}
[IO.File]::WriteAllBytes($file,$sealed)
Test-BranchCredentialChallenge $FixtureRoot $authorities $sid.Value
if ([IO.File]::ReadAllText($receipt) -cne $expected) { throw 'Unexpected challenge projection' }
[IO.File]::WriteAllText($receipt,'existing')
try { Test-BranchCredentialChallenge $FixtureRoot $authorities $sid.Value } catch [IO.IOException] {}
if ([IO.File]::ReadAllText($receipt) -cne 'existing') { throw 'Existing receipt was overwritten' }
[IO.File]::Delete($receipt)
foreach ($bad in @([byte[]](1,2,3),[byte[]]::new(1025),
    [Security.Cryptography.ProtectedData]::Protect($marker,$null,'LocalMachine'),
    [Security.Cryptography.ProtectedData]::Protect([byte[]](1),$entropy,'LocalMachine'))) {
    [IO.File]::WriteAllBytes($file,$bad)
    Denied
}
[IO.File]::WriteAllBytes($file,$sealed)
$unsafe = Get-Acl -LiteralPath $file
$unsafe.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
    [Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'Read','Allow'))
[IO.File]::SetAccessControl($file,$unsafe)
Denied

$records = Join-Path $FixtureRoot 'branch-credentials'
$null = [IO.Directory]::CreateDirectory($records)
$recordsAcl = [IO.Directory]::GetAccessControl($records)
$recordsAcl.SetAccessRuleProtection($true,$false)
$recordsAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
[IO.Directory]::SetAccessControl($records,$recordsAcl)
$binding = 'a'*64
$member = $binding+'-'+('b'*64)
$record = Join-Path $records ($member+'.bin')
[IO.File]::WriteAllBytes($record,[byte[]](1))
function Assert-NoInventory {
    $failed=$false
    try { $null=@(Get-BranchCredentialBindings $FixtureRoot $authorities $sid.Value) } catch { $failed=$true }
    if (!$failed) { throw 'Unsafe credential inventory accepted' }
}
$inventory = @(Get-BranchCredentialBindings $FixtureRoot $authorities $sid.Value)
if ($inventory.Count -ne 1 -or $inventory[0] -cne $member) { throw 'Expected one authorized credential binding' }
$duplicate = Join-Path $records ($binding+'-'+('c'*64)+'.bin')
[IO.File]::WriteAllBytes($duplicate,[byte[]](2))
Assert-NoInventory
[IO.File]::Delete($duplicate)
$unsafeRecord = Get-Acl -LiteralPath $record
$unsafeRecord.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
    [Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'Read','Allow'))
[IO.File]::SetAccessControl($record,$unsafeRecord)
Assert-NoInventory
[IO.File]::Delete($record)
foreach ($i in 1..33) {
    $leaf = $i.ToString('x64')+'-'+('d'*64)+'.bin'
    [IO.File]::WriteAllBytes((Join-Path $records $leaf),[byte[]](1))
}
Assert-NoInventory
& {
    . (Join-Path $PSScriptRoot '../Install-CompletionWatcher.ps1')
    . (Join-Path $PSScriptRoot '../Test-InstalledCredentialIsolation.ps1')
    $fixtureReceipt = Join-Path $FixtureRoot 'result'
    $expectedDigest = 'f'*64
    [IO.File]::WriteAllText($fixtureReceipt,$expectedDigest)
    Assert-TrialDigest $fixtureReceipt $expectedDigest
    foreach ($length in @(0,63,64,65,65536)) {
        [IO.File]::WriteAllBytes($fixtureReceipt,[byte[]]::new($length))
        $failed = $false
        try { Assert-TrialDigest $fixtureReceipt $expectedDigest } catch { $failed=$true }
        if (!$failed) { throw 'Invalid trial digest accepted' }
    }
}
& {
    $endpoint = 'https://'+(('fixture','invalid') -join '.')+'/fixture'
    $parameters = @{PackageHash='a'*64;ImageHash='a'*64;TransportHash='b'*64;Edition='ucrt64';
        Ref='refs/heads/fixture';ExpectedRevision='a'*40;Endpoint=$endpoint}
    . (Join-Path $PSScriptRoot '../Test-InstalledBranchRead.ps1') @parameters
    & {
        . (Join-Path $PSScriptRoot '../Test-InstalledCodexWatcher.ps1') -Stage Run -TrialId ([guid]::NewGuid()) -ExpectedPackage ('a'*64)
        $trial = Join-Path $FixtureRoot 'reader-preflight'
        $runtime = Join-Path $trial 'runtime'
        $modules = Join-Path $trial 'relay'
        $null = [IO.Directory]::CreateDirectory($runtime)
        $null = [IO.Directory]::CreateDirectory($modules)
        $node = Join-Path $runtime 'node.exe'
        [IO.File]::Copy((Get-Command node.exe -CommandType Application | Select-Object -First 1).Source,$node)
        $verifier = Join-Path $trial 'verify.cjs'
        $paramsFile = Join-Path $trial 'input.json'
        $condition = [guid]::NewGuid()
        $utf = [Text.UTF8Encoding]::new($false)
        [IO.File]::WriteAllText((Join-Path $modules 'branch-observation.mjs'),'export function installedCredentialRecord() {}')
        $moduleFile = Join-Path $modules 'schedule-watch.mjs'
        $env:NODE_OPTIONS='--require=missing-fixture-preload'
        $env:RELAY_TRIAL_CANARY='fixture'
        try {
            [IO.File]::WriteAllText($moduleFile,'export const validBranchWatch=(g,opt)=>opt===true && g.credential==="fixture" && !process.env.RELAY_TRIAL_CANARY;')
            Assert-PrivateBranchSupport @{credential='fixture'}
            [IO.File]::WriteAllText($moduleFile,'export const validBranchWatch=g=>g.credential===null;')
            $failed=$false
            try { Assert-PrivateBranchSupport @{credential='fixture'} } catch { $failed=$true }
            if (!$failed) { throw 'Old anonymous-only package accepted a credentialed preflight' }
        } finally {
            Remove-Item Env:NODE_OPTIONS,Env:RELAY_TRIAL_CANARY -ErrorAction SilentlyContinue
        }
    }
    $binding = [byte[]]::new(32)
    $secret = ConvertTo-SecureString 'synthetic-password' -AsPlainText -Force
    try {
        $sealed = Protect-TrialReader $secret 'fixture' $binding
        $plain = [Security.Cryptography.ProtectedData]::Unprotect($sealed,$binding,'LocalMachine')
        if ([Text.Encoding]::ASCII.GetString($plain) -cne 'fixture:synthetic-password') { throw 'Credential mismatch' }
        [Array]::Clear($plain,0,$plain.Length)
    } finally { $secret.Dispose() }
    # Installed ownership and ACLs have separate checks. Exercise recovery
    # transactions against real files with a recording restart.
    function Assert-Protected($p) { if (!(Test-Path -LiteralPath $p)) { throw 'Missing fixture artifact' } }
    function Restart-TrialBroker($mode) { if ($mode -cne 'reports_only') { throw 'Unexpected recovery mode' } }
    function Set-ApprovedText($p,$before,$after) {
        if ([IO.File]::ReadAllText($p) -cne $before) { throw 'Fixture changed' }
        [IO.File]::WriteAllText($p,$after)
    }
    $root = Join-Path $FixtureRoot 'private-recovery'
    $null = [IO.Directory]::CreateDirectory($root)
    $store = Join-Path $root 'branch-credentials'
    $trial = Join-Path $root 'trial'
    $recovery = Join-Path $trial 'recovery.json'
    $paramsFile = Join-Path $trial 'parameters.json'
    $verifier = Join-Path $trial 'verify.cjs'
    $flagFile = Join-Path $root 'worker.json'
    $policyFile = Join-Path $root 'policy.json'
    $gitFile = Join-Path $root 'git.json'
    $condition = [guid]::NewGuid()
    $empty='{"v":1,"grants":[]}'; $on='{"v":1,"enabled":true}'; $off='{"v":1,"enabled":false}'
    & {
        $lockFile=Join-Path $root 'lock'
        $journal=Join-Path $root 'journal'
        $node=Join-Path $root 'image'
        foreach ($file in @($lockFile,$flagFile,$policyFile,$node)) { [IO.File]::WriteAllText($file,'fixture') }
        $desktopSid='fixture-principal'; $workerTask='worker'; $brokerTask='broker'
        $folder=[pscustomobject]@{}
        $folder | Add-Member ScriptMethod GetTask {param($name) return $name}
        function Assert-RegisteredTask($task,$installed) {
            try { $extra=[IO.File]::Open($lockFile,'Open','ReadWrite','None') } catch [IO.IOException] { return }
            $extra.Dispose(); throw 'Task identity checked outside lock'
        }
        $installed=@{package=$PackageHash;status='installed';sessionSid=$desktopSid}
        [IO.File]::WriteAllText($journal,($installed|ConvertTo-Json))
        $verified=Enter-BranchTrial
        $verified.lock.Dispose()
        $installed.package='0'*64
        [IO.File]::WriteAllText($journal,($installed|ConvertTo-Json))
        $rejected=$false
        try { $unexpected=Enter-BranchTrial; $unexpected.lock.Dispose() } catch { $rejected=$_.Exception.Message -eq 'Installation mismatch' }
        if (!$rejected) { throw 'Stale package accepted' }
        $extra=[IO.File]::Open($lockFile,'Open','ReadWrite','None'); $extra.Dispose()
    }
    $approved = @{v=6;branches=@(@{condition=$condition.ToString('D')})}|ConvertTo-Json -Depth 3 -Compress
    $draft = Join-Path $root 'publication.pending'
    $published = Join-Path $root 'publication'
    Publish-TrialFile $published $draft ([byte[]](1,2,3))
    if (([IO.File]::ReadAllBytes($published) -join ',') -cne '1,2,3' -or [IO.File]::Exists($draft)) { throw 'Incomplete publication' }
    $denied = $false
    try { Publish-TrialFile $published $draft ([byte[]](4)) } catch [IO.IOException] { $denied = $true }
    if (!$denied -or ([IO.File]::ReadAllBytes($published) -join ',') -cne '1,2,3') { throw 'Existing publication changed' }
    foreach ($state in @('before-grant','partial-credential','partial-profile','after-activation','unrelated')) {
        $null = [IO.Directory]::CreateDirectory($trial)
        $null = [IO.Directory]::CreateDirectory($store)
        $file = Join-Path $store 'temp'
        [IO.File]::WriteAllText($file,'synthetic-ciphertext')
        $leaf = ('a'*64)+'-'+(Get-FileHash $file).Hash.ToLowerInvariant()+'.bin'
        [IO.File]::Move($file,(Join-Path $store $leaf))
        $plan = @{v=1;condition=$condition.ToString('D');package=$PackageHash;member=$leaf;profile='fixture';policy=$approved}
        [IO.File]::WriteAllText($recovery,($plan|ConvertTo-Json -Compress))
        $staging = 'branch-'+$condition.ToString('N')+'.pending'
        $profileStage = Join-Path $root $staging
        if ($state -eq 'unrelated') {
            $plan.v = 2
            $plan.staging = 'publication'
            [IO.File]::WriteAllText($recovery,($plan|ConvertTo-Json -Compress))
            $denied = $false
            try { Restore-PrivateBranchTrial } catch { $denied = $_.Exception.Message -ceq 'Unrecognized trial staging name' }
            if (!$denied -or ([IO.File]::ReadAllBytes($published) -join ',') -cne '1,2,3') { throw 'Recovery accepted an unrelated staging name' }
            $plan.staging = $staging
            [IO.File]::WriteAllText($recovery,($plan|ConvertTo-Json -Compress))
        }
        if ($state -like 'partial-*') {
            $plan.v = 2
            $plan.staging = $staging
            [IO.File]::WriteAllText($recovery,($plan|ConvertTo-Json -Compress))
            if ($state -eq 'partial-credential') {
                [IO.File]::Delete((Join-Path $store $leaf))
                [IO.File]::WriteAllBytes((Join-Path $store $staging),[byte[]](1))
            } else { [IO.File]::WriteAllBytes($profileStage,[byte[]]::new(0)) }
        }
        if ($state -in @('before-grant','partial-credential','partial-profile')) {
            [IO.File]::WriteAllText($flagFile,$off); [IO.File]::WriteAllText($policyFile,$empty)
        } else {
            [IO.File]::WriteAllText($flagFile,$on); [IO.File]::WriteAllText($policyFile,$approved)
            [IO.File]::WriteAllText($gitFile,'fixture')
        }
        if ($state -eq 'unrelated') {
            [IO.File]::WriteAllText((Join-Path $store 'other'),'preserve')
            $denied=$false
            try { Restore-PrivateBranchTrial } catch { $denied=$true }
            if (!$denied -or ![IO.File]::Exists($recovery) -or [IO.File]::ReadAllText($flagFile) -cne $on) { throw 'Foreign record changed during recovery' }
        } else {
            Restore-PrivateBranchTrial
            if ([IO.Directory]::Exists($trial) -or [IO.Directory]::Exists($store) -or [IO.File]::Exists($gitFile) -or [IO.File]::Exists($profileStage) -or
                [IO.File]::ReadAllText($flagFile) -cne $off -or [IO.File]::ReadAllText($policyFile) -cne $empty) { throw 'Incomplete private recovery' }
        }
    }
}
