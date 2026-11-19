# Started by the installed broker under its dedicated Windows account.
$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $PSHOME 'Modules'
function Assert-BrokerAcl {
    param([string]$Path, [string[]]$Authorities, [switch]$PrivateState)
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Broker path is redirected' }
    $acl = Get-Acl -LiteralPath $item.FullName
    $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
    if ($null -eq $descriptor.DiscretionaryAcl) { throw 'Missing broker access restrictions' }
    foreach ($entry in $descriptor.DiscretionaryAcl) {
        if ($entry.AceType -notin @('AccessAllowed','AccessDenied')) { throw 'Unsupported broker access rule' }
    }
    $sidType = [Security.Principal.SecurityIdentifier]
    if ($acl.GetOwner($sidType).Value -notin $Authorities) { throw 'Unexpected broker file owner' }
    $mask = [Security.AccessControl.FileSystemRights]'Write, Delete, DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership'
    if ($PrivateState) { $mask = $mask -bor [Security.AccessControl.FileSystemRights]::ReadData }
    foreach ($ace in $acl.GetAccessRules($true, $true, $sidType)) {
        if ($ace.AccessControlType -ne 'Allow' -or $ace.IdentityReference.Value -in $Authorities) { continue }
        if (-not $PrivateState -and ($ace.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)) { continue }
        $genericMask = 0x50000000 # GENERIC_ALL or GENERIC_WRITE
        if ($PrivateState) { $genericMask = $genericMask -bor [int]::MinValue }
        if (($ace.FileSystemRights -band $mask) -or (([int]$ace.FileSystemRights) -band $genericMask)) {
            throw 'Excessive broker file access'
        }
    }
}

function Get-CompletionRoot {
    $root = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'CrossAgentRelay'
    $admin = @('S-1-5-18', 'S-1-5-32-544',
        ([Security.Principal.NTAccount]'NT SERVICE\TrustedInstaller').Translate([Security.Principal.SecurityIdentifier]).Value)
    Assert-BrokerAcl $root $admin
    $identityFile = Join-Path $root 'completion-principals.json'
    Assert-BrokerAcl $identityFile $admin
    Assert-BrokerAcl (Join-Path $root 'completion-policy.json') $admin
    $assignment = Get-Content -LiteralPath $identityFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    $agentSid = [Security.Principal.SecurityIdentifier]::new([string]$assignment.sessionSid)
    if ($identity.User.Value -cne $assignment.brokerSid -or $agentSid.Value -eq $identity.User.Value -or
        $identity.User.Value -in ($admin + @('S-1-5-19','S-1-5-20')) -or
        $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Broker requires its designated separate non-administrative account'
    }
    $state = Join-Path $root 'completion-state'
    $trusted = $admin + @($identity.User.Value)
    Assert-BrokerAcl $state $trusted -PrivateState
    Assert-BrokerAcl (Join-Path $state 'jobs.sqlite') $trusted -PrivateState
    foreach ($file in Get-ChildItem -LiteralPath $state -Force) {
        if ($file.PSIsContainer -or $file.Name -notin @('jobs.sqlite','jobs.sqlite-journal','jobs.sqlite-wal','jobs.sqlite-shm')) {
            throw 'Unexpected broker state file'
        }
        Assert-BrokerAcl $file.FullName $trusted -PrivateState
    }
    $root
}

if ($MyInvocation.InvocationName -ne '.') {
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    Get-CompletionRoot
}
