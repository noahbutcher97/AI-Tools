# Started by the installed broker under its dedicated Windows account.
$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $PSHOME 'Modules'
function Assert-BrokerAcl {
    param([string]$Path, [string[]]$Authorities, [switch]$PrivateState, [string[]]$Readers)
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
        if (-not $PrivateState -and -not $Readers -and ($ace.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)) { continue }
        if ($Readers -and $ace.IdentityReference.Value -notin $Readers -and
            (($ace.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ReadData) -or
             (([int]$ace.FileSystemRights) -band [int]::MinValue))) { throw 'Unexpected watcher health reader' }
        $genericMask = 0x50000000 # GENERIC_ALL or GENERIC_WRITE
        if ($PrivateState) { $genericMask = $genericMask -bor [int]::MinValue }
        if (($ace.FileSystemRights -band $mask) -or (([int]$ace.FileSystemRights) -band $genericMask)) {
            throw 'Excessive broker file access'
        }
    }
}

function Assert-GrantDirectory {
    param([string]$Path, [string[]]$Authorities, [string]$SessionSid)
    Assert-BrokerAcl $Path $Authorities -Readers @($SessionSid)
    $sidType = [Security.Principal.SecurityIdentifier]
    $rules = (Get-Acl -LiteralPath $Path).GetAccessRules($true, $true, $sidType)
    # Require an inheritable DACL for newly published files. A directory with
    # only effective rules can leave a new file to the creator's default DACL.
    $reads = @($rules | Where-Object {
        $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -eq $SessionSid -and
        ($_.InheritanceFlags -band [Security.AccessControl.InheritanceFlags]::ObjectInherit) -and
        ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ReadData)
    })
    if (-not $reads.Count) { throw 'Grant files require an inherited desktop read rule' }
    foreach ($item in Get-ChildItem -LiteralPath $Path -Force) {
        if ($item.PSIsContainer) { throw 'Unexpected grant directory' }
        Assert-BrokerAcl $item.FullName $Authorities -Readers @($SessionSid)
    }
}

function Get-BranchGit($root,$admin) {
    $profile = Join-Path $root 'completion-git.json'
    if (![IO.File]::Exists($profile)) { return $null }
    Assert-BrokerAcl $profile $admin
    if ((Get-Item -LiteralPath $profile).Length -gt 1024) { throw 'Invalid Git profile' }
    $policy = Get-Content -LiteralPath $profile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($policy.v -ne 1 -or $policy.edition -cnotin @('mingw64','ucrt64') -or
        $policy.imageHash -cnotmatch '^[a-f0-9]{64}$' -or $policy.transportHash -cnotmatch '^[a-f0-9]{64}$' -or
        @($policy.PSObject.Properties).Count -ne 4) { throw 'Invalid Git profile' }
    $programs = [Environment]::GetFolderPath('ProgramFiles')
    $git = Join-Path $programs 'Git'
    $runtime = Join-Path $git $policy.edition
    $bin = Join-Path $runtime 'bin'
    $exec = Join-Path $runtime 'libexec/git-core'
    $cwd = Join-Path $root 'worker-cwd'
    foreach ($dir in @($programs,$git,$runtime,$bin,(Join-Path $runtime 'libexec'),$exec,$cwd)) {
        Assert-BrokerAcl $dir $admin
    }
    if (@(Get-ChildItem -LiteralPath $cwd -Force).Count) { throw 'Unexpected Git working directory' }
    foreach ($dir in @($bin,$exec)) {
        foreach ($item in Get-ChildItem -LiteralPath $dir -File -Force) {
            if ($item.Extension -in @('.dll','.exe','.config','.manifest')) { Assert-BrokerAcl $item.FullName $admin }
        }
    }
    $image = Join-Path $bin 'git.exe'
    $transport = Join-Path $exec 'git-remote-https.exe'
    if ((Get-FileHash -LiteralPath $image).Hash -ine $policy.imageHash -or
        (Get-FileHash -LiteralPath $transport).Hash -ine $policy.transportHash) { throw 'Git installation changed' }
    return @{image=$image;execPath=$exec;cwd=$cwd;windows=[Environment]::GetFolderPath('Windows');
        profileHash=(Get-FileHash -LiteralPath $profile).Hash.ToLowerInvariant();imageHash=$policy.imageHash;transportHash=$policy.transportHash}
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
    $installed = Test-Path -LiteralPath (Join-Path $root 'CompletionChannel.exe')
    $enabled = $false
    if ($installed) {
        foreach ($name in @('CompletionChannel.exe','relay','runtime','runtime/node.exe','provider','provider/claude.exe','worker-cwd')) {
            Assert-BrokerAcl (Join-Path $root $name) $admin
        }
        $queueImage = Join-Path $root 'provider/codex.exe'
        if (Test-Path -LiteralPath $queueImage) { Assert-BrokerAcl $queueImage $admin }
        foreach ($file in Get-ChildItem -LiteralPath (Join-Path $root 'relay') -File -Force) {
            Assert-BrokerAcl $file.FullName $admin
        }
        if (@(Get-ChildItem -LiteralPath (Join-Path $root 'worker-cwd') -Force).Count) { throw 'Worker directory must be empty' }
        $flag = Join-Path $root 'completion-worker.json'
        if (Test-Path -LiteralPath $flag) {
            Assert-BrokerAcl $flag $admin
            $setting = Get-Content -LiteralPath $flag -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($setting.v -ne 1 -or $setting.enabled -isnot [bool]) { throw 'Invalid worker setting' }
            $enabled = $setting.enabled
        }
    }
    $healthPath = Join-Path $root 'completion-health'
    $health = Test-Path -LiteralPath $healthPath
    if ($health) {
        Assert-BrokerAcl $healthPath $trusted -Readers @($agentSid.Value)
        foreach ($item in Get-ChildItem -LiteralPath $healthPath -Force) { Assert-BrokerAcl $item.FullName $trusted -Readers @($agentSid.Value) }
    }
    $grantPath = Join-Path $root 'completion-grants'
    $handoff = Test-Path -LiteralPath $grantPath -PathType Container
    if ($handoff) {
        # Bearers may be read only by the assigned local user and the authorities.
        if ($agentSid.Value -notmatch '^S-1-5-21-(\d+-){3}\d+$') { throw 'Expected a session account SID' }
        Assert-GrantDirectory $grantPath $trusted $agentSid.Value
    }
    $git = $null
    if ($installed) {
        try { $git = Get-BranchGit $root $admin } catch { $git = $null }
    }
    [pscustomobject]@{root=$root; installed=$installed; enabled=$enabled; health=$health; handoff=$handoff;git=$git} | ConvertTo-Json -Compress
}

if ($MyInvocation.InvocationName -ne '.') {
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    Get-CompletionRoot
}
