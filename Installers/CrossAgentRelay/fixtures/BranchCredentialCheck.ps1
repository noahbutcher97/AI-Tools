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
