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
