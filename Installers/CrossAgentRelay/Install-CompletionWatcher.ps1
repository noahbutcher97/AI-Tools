# Stage and install the Windows logon watcher from a reviewed private package.
# Plan is read-only. Apply and Rollback require Windows PowerShell as an administrator.
[CmdletBinding()]
param(
    [ValidateSet('Plan','Apply','Rollback')][string]$Mode = 'Plan',
    [string]$Package,
    [string]$PackageDigest,
    [switch]$RenewBrokerPassword
)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $PSHOME 'Modules'
$accountName = 'RelayWatchBroker'
$brokerTask = 'CrossAgentRelayCompletionBroker'
$workerTask = 'CrossAgentRelayCompletionWorker'
$root = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'CrossAgentRelay'
$journal = Join-Path $root 'watcher-install.json'
$admin = 'S-1-5-32-544'
$system = 'S-1-5-18'
$trustedInstaller = ([Security.Principal.NTAccount]'NT SERVICE\TrustedInstaller').Translate([Security.Principal.SecurityIdentifier]).Value
$authority = @($admin,$system,$trustedInstaller)
$sidType = [Security.Principal.SecurityIdentifier]
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$desktopSid = $identity.User.Value
$members = @('CompletionChannel.exe','runtime/node.exe','provider/claude.exe','provider/codex.exe','initial/jobs.sqlite',
    'relay/CompletionChannel.cs','relay/completion-acl.ps1')
foreach ($module in @('client','completion-broker','completion-jobs','completion-protocol','completion-session',
    'completion-worker','delivery-protocol','fleet','identity','local-ping','proof','provider-process','run-handoff','schedule-watch','watcher-health')) {
    $members += "relay/$module.mjs"
}
$directories = @('runtime','provider','relay','worker-cwd','completion-state','completion-health','completion-grants')

function Assert-PlainPath([string]$p) {
    $item = Get-Item -LiteralPath $p -Force
    while ($null -ne $item) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Redirected installation path' }
        if ($item -is [IO.FileInfo]) { $item = $item.Directory } else { $item = $item.Parent }
    }
}

function Assert-Protected([string]$p) {
    Assert-PlainPath $p
    $acl = Get-Acl -LiteralPath $p
    $sd = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0)
    if ($null -eq $sd.DiscretionaryAcl -or $acl.GetOwner($sidType).Value -notin $authority) { throw 'Untrusted installation owner or DACL' }
    foreach ($ace in $sd.DiscretionaryAcl) {
        if ($ace.AceType -notin @('AccessAllowed','AccessDenied')) { throw 'Unsupported installation ACL' }
    }
    $writes = [int][Security.AccessControl.FileSystemRights]'Write,Delete,DeleteSubdirectoriesAndFiles,TakeOwnership,ChangePermissions'
    foreach ($rule in $acl.GetAccessRules($true,$true,$sidType)) {
        if ($rule.AccessControlType -ne 'Allow' -or $rule.IdentityReference.Value -in $authority -or
            ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)) { continue }
        if (([int]$rule.FileSystemRights -band ($writes -bor 0x50000000)) -ne 0) { throw 'Installation path is writable outside setup' }
    }
}

function Read-Package([string]$dir,[switch]$AllowLegacy) {
    $file = Join-Path $dir 'package.json'
    Assert-PlainPath $file
    if ((Get-Item -LiteralPath $file).Length -gt 8192) { throw 'Oversize package manifest' }
    $bytes = [IO.File]::ReadAllBytes($file)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $actual = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-','').ToLowerInvariant() }
    finally { $sha.Dispose() }
    if ($actual -cne $PackageDigest) { throw 'The package has a different digest from the reviewed plan' }
    $meta = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
    $files = @{}
    $expected = $members
    if ($AllowLegacy -and $meta.files.Count -eq ($members.Count-1)) { $expected = @($members | Where-Object { $_ -cne 'relay/schedule-watch.mjs' }) }
    if ($meta.v -ne 1 -or $meta.files.Count -ne $expected.Count) { throw 'Unexpected package version or size' }
    foreach ($row in $meta.files) {
        if ($row.Count -ne 2 -or $row[0] -cnotin $expected -or $row[1] -cnotmatch '^[0-9a-f]{64}$' -or
            $files.ContainsKey($row[0])) { throw 'Invalid package member' }
        $src = Join-Path $dir $row[0]
        Assert-PlainPath $src
        if ((Get-FileHash -LiteralPath $src -Algorithm SHA256).Hash -ne $row[1]) { throw 'Package content changed' }
        $files.Add($row[0],$row[1])
    }
    return $files
}

function New-AccessDirectory([string]$p,[string]$extra) {
    if (Test-Path -LiteralPath $p) { throw 'Destination already exists' }
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetSecurityDescriptorSddlForm("O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)$extra")
    $null = [IO.Directory]::CreateDirectory($p,$acl)
}

function Save-Record($record) {
    $tmp = Join-Path $root ([guid]::NewGuid().ToString('N') + '.tmp')
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($record | ConvertTo-Json -Compress))
    $stream = [IO.File]::Open($tmp,'CreateNew','Write','None')
    try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Close() }
    if ([IO.File]::Exists($journal)) { [IO.File]::Replace($tmp,$journal,[System.Management.Automation.Language.NullString]::Value) } else { [IO.File]::Move($tmp,$journal) }
}

function New-BrokerPassword {
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    $bytes = New-Object byte[] 48
    try { $rng.GetBytes($bytes); ConvertTo-SecureString ('Aa1!'+[Convert]::ToBase64String($bytes)) -AsPlainText -Force }
    finally { [Array]::Clear($bytes,0,$bytes.Length); $rng.Dispose() }
}

function Get-TaskDefinition([string]$name,[string]$sid,[int]$logon,[string]$tag) {
    $definition = $scheduler.NewTask(0)
    $definition.RegistrationInfo.Description = $tag
    $definition.Principal.UserId = $sid
    $definition.Principal.LogonType = $logon
    $definition.Principal.RunLevel = 0
    $definition.Settings.MultipleInstances = 2
    $definition.Settings.ExecutionTimeLimit = 'PT1M'
    $definition.Settings.Hidden = $true
    $definition.Settings.DisallowStartIfOnBatteries = $false
    $definition.Settings.StopIfGoingOnBatteries = $false
    $action = $definition.Actions.Create(0)
    $action.WorkingDirectory = $root
    if ($name -eq $workerTask) {
        $action.Path = Join-Path $root 'CompletionChannel.exe'
        $action.Arguments = 'worker $(Arg0)'
    } else {
        $trigger = $definition.Triggers.Create(9)
        $trigger.UserId = $desktopSid
        $definition.Settings.ExecutionTimeLimit = 'PT0S'
        $definition.Settings.RestartCount = 3
        $definition.Settings.RestartInterval = 'PT1M'
        $action.Path = Join-Path $root 'runtime/node.exe'
        $action.Arguments = '"' + (Join-Path $root 'relay/completion-broker.mjs') + '"'
    }
    return $definition
}

function Set-LogonTask([string]$name,[string]$sid,[int]$logon,[string]$tag,[string]$brokerSid,[securestring]$password) {
    $definition = Get-TaskDefinition $name $sid $logon $tag
    $sddl = "O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;$brokerSid)"
    if ($name -eq $brokerTask) {
        if ($logon -ne 2 -or $sid -ne $brokerSid -or !$password) { throw 'Missing S4U broker registration credential' }
        # Task Scheduler authenticates the different principal during registration.
        # S4U does not store the credential. Keep the plaintext at the COM boundary.
        $credential = [pscredential]::new($sid,$password)
        $null = $folder.RegisterTaskDefinition($name,$definition,18,$sid,$credential.GetNetworkCredential().Password,$logon,$sddl)
    } else {
        $null = $folder.RegisterTaskDefinition($name,$definition,18,$sid,$null,$logon,$sddl)
    }
}

function Resolve-Principal([string]$principalName) {
    if ($principalName -like 'S-1-*') { return $principalName }
    return ([Security.Principal.NTAccount]$principalName).Translate($sidType).Value
}

function Assert-RegisteredTask($task,$record) {
    $sd = [Security.AccessControl.RawSecurityDescriptor]::new($task.GetSecurityDescriptor(7))
    if ($sd.Owner.Value -notin @($admin,$system) -or $null -eq $sd.DiscretionaryAcl) { throw 'Untrusted task owner' }
    foreach ($ace in $sd.DiscretionaryAcl) {
        if ($ace.AceType -eq 'AccessDenied') { continue }
        if ($ace.AceType -ne 'AccessAllowed') { throw 'Unsupported task ACL' }
        if ($ace.SecurityIdentifier.Value -notin @($admin,$system) -and
            ($ace.AccessMask -band (-bnot [int]0xA01200A9)) -ne 0) { throw 'Writable task outside setup' }
    }
    $isWorker = $task.Name -eq $workerTask
    $sid = if ($isWorker) { $desktopSid } else { $record.brokerSid }
    $logon = if ($isWorker) { 3 } else { 2 }
    $expected = Get-TaskDefinition $task.Name $sid $logon $record.tag
    $actual = $task.Definition
    if ($actual.RegistrationInfo.Description -cne $record.tag -or (Resolve-Principal $actual.Principal.UserId) -ne $sid -or
        $actual.Principal.LogonType -ne $logon -or $actual.Principal.RunLevel -ne 0 -or $actual.Actions.Count -ne 1 -or
        $actual.Settings.MultipleInstances -ne 2 -or $actual.Triggers.Count -ne $expected.Triggers.Count) { throw 'Managed task definition changed' }
    $action = $actual.Actions.Item(1)
    $want = $expected.Actions.Item(1)
    if ($action.Type -ne 0 -or $action.Path -ne $want.Path -or $action.Arguments -cne $want.Arguments -or
        $action.WorkingDirectory -ne $root) { throw 'Managed task action changed' }
    if (!$isWorker -and ($actual.Triggers.Item(1).Type -ne 9 -or
        (Resolve-Principal $actual.Triggers.Item(1).UserId) -ne $desktopSid)) { throw 'Unexpected watcher logon trigger' }
}

function Copy-ReviewedFile([string]$src,[string]$dest,[string]$hash) {
    $dir = [IO.Path]::GetDirectoryName($dest)
    Assert-Protected $dir
    $temp = Join-Path $dir ([guid]::NewGuid().ToString('N')+'.tmp')
    try {
        [IO.File]::Copy($src,$temp,$false)
        Assert-Protected $temp
        if ((Get-FileHash -LiteralPath $temp -Algorithm SHA256).Hash -ne $hash) { throw 'Source changed during staging' }
        [IO.File]::Move($temp,$dest)
    } finally { if ([IO.File]::Exists($temp)) { [IO.File]::Delete($temp) } }
}

function Grant-StateAccess([string]$brokerSid,[string]$brokerModify) {
    $state = Join-Path $root 'completion-state'
    $stateAcl = Get-Acl -LiteralPath $state
    $hasBrokerAccess = @($stateAcl.GetAccessRules($true,$true,$sidType) | Where-Object { $_.IdentityReference.Value -eq $brokerSid })
    if (!$hasBrokerAccess.Count) {
        Assert-Protected $state
        $stateAcl.SetSecurityDescriptorSddlForm("O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)$brokerModify")
        [IO.Directory]::SetAccessControl($state,$stateAcl)
    }
}

function Test-BrokerInstance($scheduler,$processId) {
    if ($processId -isnot [long] -and $processId -isnot [int]) { return $false }
    # GetInstances(0) can omit this hidden task even while it is running.
    $instances = @($scheduler.GetRunningTasks(1) | Where-Object { $_.Path -eq "\$brokerTask" })
    return $processId -gt 0 -and $instances.Count -eq 1 -and $instances[0].State -eq 4 -and
        $instances[0].EnginePID -eq $processId
}

function Start-VerifiedWatcher($broker) {
    if ($broker.State -ne 4) { $null = $broker.Run($null) }
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        Start-Sleep -Milliseconds 300
        $health = Join-Path $root 'completion-health/watcher.json'
        if ([IO.File]::Exists($health)) {
            Assert-PlainPath $health
            # The broker owns the projection. Bound the read and discard malformed
            # records without disclosing their contents in administrator output.
            $beat = $null
            try {
                $stream = [IO.File]::Open($health,'Open','Read',[IO.FileShare]'ReadWrite,Delete')
                try {
                    $size = $stream.Length
                    if ($size -gt 0 -and $size -le 8192) {
                        $reader = [IO.BinaryReader]::new($stream)
                        $bytes = $reader.ReadBytes([int]$size)
                        if ($bytes.Length -eq $size -and $stream.Length -eq $size) {
                            $beat = [Text.UTF8Encoding]::new($false,$true).GetString($bytes) | ConvertFrom-Json
                        }
                    }
                } finally { $stream.Dispose() }
            } catch { $beat = $null }
            if ($beat -and (Test-BrokerInstance $scheduler $beat.pid) -and
                $beat.mode -in @('reports_only','watching') -and
                [math]::Abs(([DateTime]::UtcNow-[DateTimeOffset]::Parse($beat.heartbeat).UtcDateTime).TotalSeconds) -lt 10 -and
                $folder.GetTask($brokerTask).State -eq 4) {
                return
            }
        }
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Watcher startup is unproven. Inspect the managed task and heartbeat before enabling delivery.'
}

function Invoke-WatcherSetup($scheduler,$folder) {
    $tasks = @($folder.GetTasks(1) | Where-Object Name -in @($workerTask,$brokerTask))
    $account = Get-LocalUser -Name $accountName -ErrorAction SilentlyContinue
    $record = $null
    Assert-Protected ([Environment]::GetFolderPath('ProgramFiles'))
    if (Test-Path -LiteralPath $root) { Assert-Protected $root }
    if (Test-Path -LiteralPath $journal) {
        Assert-Protected $journal
        $record = Get-Content -LiteralPath $journal -Raw | ConvertFrom-Json
        if ($record.v -ne 1 -or $record.tag -cnotmatch '^relay-watcher-[0-9a-f]{32}$' -or
            $record.package -cnotmatch '^[0-9a-f]{64}$' -or ($Mode -ne 'Rollback' -and $record.package -cne $PackageDigest) -or
            $record.status -notin @('installing','installed','disabled') -or $record.initialized -isnot [bool] -or
            ($record.brokerSid -and $record.brokerSid -cnotmatch '^S-1-5-21-(\d+-){3}\d+$') -or $record.sessionSid -cne $desktopSid) { throw 'Unrecognized watcher installation record' }
    }
    if ($account -and (!$record -or $account.Description -cne $record.tag -or
        ($record.brokerSid -and $record.brokerSid -ne $account.SID.Value))) { throw 'The broker account name is already in use' }
    foreach ($task in $tasks) {
        if (!$record -or $task.Definition.RegistrationInfo.Description -cne $record.tag) { throw 'A task name belongs to another installation' }
        Assert-RegisteredTask $task $record
    }
    $fixed = $directories + @('CompletionChannel.exe','completion-principals.json','completion-policy.json','completion-worker.json')
    if (!$record) {
        foreach ($n in $fixed) { if (Test-Path -LiteralPath (Join-Path $root $n)) { throw 'A watcher destination is already managed elsewhere' } }
    }
    if ($Mode -eq 'Plan') {
        # Materialize both definitions with the local scheduler without registering anything.
        $null = Get-TaskDefinition $workerTask $desktopSid 3 'qualification'
        $null = Get-TaskDefinition $brokerTask $desktopSid 2 'qualification'
        [pscustomobject]@{package=$PackageDigest; managed=[bool]$record; brokerAccountPresent=[bool]$account;
            tasksPresent=$tasks.Count; logon='S4U'; providerDelivery='disabled on initial installation'} | ConvertTo-Json -Compress
        return
    }
    if ($Mode -eq 'Rollback') {
        if (!$record) { return }
        foreach ($task in $tasks) {
            if ($task.State -in @(2,4)) { $task.Stop(0) }
            $folder.DeleteTask($task.Name,0)
        }
        if ($account) { Disable-LocalUser -SID $account.SID }
        $record.status = 'disabled'
        Save-Record $record
        'Logon tasks removed and broker account disabled. Protected grants and state retained.'
        return
    }
    if (!$record) {
        Assert-Protected $root
        $record = [pscustomobject]@{v=1;tag=('relay-watcher-'+[guid]::NewGuid().ToString('N'));package=$PackageDigest;
            sessionSid=$desktopSid;brokerSid='';initialized=$false;status='installing'}
        Save-Record $record
    }

    $password = $null
    try {
        if (!$account) {
            if ($record.brokerSid) { throw 'Assigned broker identity is missing' }
            $password = New-BrokerPassword
            $account = New-LocalUser -Name $accountName -Password $password -Description $record.tag -PasswordNeverExpires -UserMayNotChangePassword
        } elseif ($brokerTask -notin $tasks.Name) {
            if (!$RenewBrokerPassword -or !$record.brokerSid -or $record.status -notin @('installing','disabled')) {
                throw 'Missing broker task requires explicit password recovery for the assigned installation account'
            }
        }
        Complete-Installation $account $record $tasks $password
    } finally { if ($password) { $password.Dispose() } }
}

function Complete-Installation($account,$record,$tasks,[securestring]$password) {
    $brokerSid = $account.SID.Value
    if (!$record.brokerSid) { $record.brokerSid=$brokerSid; Save-Record $record }
    if (!$account.Enabled -and $record.status -ne 'disabled') { throw 'Broker account is disabled outside setup' }
    $desktopRead = "(A;OICI;GRGX;;;$desktopSid)"
    $brokerRead = "(A;OICI;GRGX;;;$brokerSid)"
    $brokerModify = "(A;OICI;0x1301bf;;;$brokerSid)"
    foreach ($n in $directories) {
        $dest = Join-Path $root $n
        if (!(Test-Path -LiteralPath $dest)) {
            if ($record.initialized) { throw 'Expected installation directory is missing' }
            $extra = switch ($n) {
                'completion-state' { '' }
                'completion-health' { $brokerModify+$desktopRead }
                'completion-grants' { $brokerModify+$desktopRead }
                default { $brokerRead+$desktopRead }
            }
            New-AccessDirectory $dest $extra
        }
        Assert-PlainPath $dest
        if (!$record.initialized -and ![IO.Directory]::Exists($dest)) { throw 'Expected installation directory' }
        if (!$n.StartsWith('completion-')) { Assert-Protected $dest }
    }
    foreach ($member in $members) {
        $initial = $member -ceq 'initial/jobs.sqlite'
        $dest = if ($initial) { Join-Path $root 'completion-state/jobs.sqlite' } else { Join-Path $root $member }
        if ($initial -and $record.initialized) {
            if (![IO.File]::Exists($dest)) { throw 'The initialized job database is missing' }
            continue
        }
        if (![IO.File]::Exists($dest)) {
            if ($record.initialized) { throw 'Expected installed file is missing' }
            Copy-ReviewedFile (Join-Path $Package $member) $dest $hashes[$member]
        }
        Assert-PlainPath $dest
        if (!$initial) { Assert-Protected $dest }
        if ((Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash -ne $hashes[$member]) { throw 'Installed content differs from reviewed package' }
    }
    $utf8 = [Text.UTF8Encoding]::new($false)
    foreach ($pair in @(
        @{name='completion-principals.json'; json=(@{sessionSid=$desktopSid;brokerSid=$brokerSid}|ConvertTo-Json -Compress)},
        @{name='completion-policy.json'; json='{"v":1,"grants":[]}'},
        @{name='completion-worker.json'; json='{"v":1,"enabled":false}'}
    )) {
        $dest = Join-Path $root $pair.name
        if (!(Test-Path -LiteralPath $dest)) {
            if ($record.initialized) { throw 'Expected installation setting is missing' }
            [IO.File]::WriteAllText($dest,$pair.json,$utf8)
        }
        Assert-Protected $dest
    }
    $verified = Get-Content -LiteralPath (Join-Path $root 'completion-principals.json') -Raw | ConvertFrom-Json
    if ($verified.sessionSid -cne $desktopSid -or $verified.brokerSid -cne $brokerSid) { throw 'Principal assignment changed' }
    $record.initialized = $true
    Save-Record $record
    Grant-StateAccess $brokerSid $brokerModify
    if (!$account.Enabled) { Enable-LocalUser -SID $account.SID }
    if ($workerTask -notin $tasks.Name) { Set-LogonTask $workerTask $desktopSid 3 $record.tag $brokerSid }
    if ($brokerTask -notin $tasks.Name) {
        if ($password) {
            Set-LogonTask $brokerTask $brokerSid 2 $record.tag $brokerSid $password
        } else {
            $replacement = New-BrokerPassword
            try {
                Set-LocalUser -SID $account.SID -Password $replacement
                Set-LogonTask $brokerTask $brokerSid 2 $record.tag $brokerSid $replacement
            } finally { $replacement.Dispose() }
        }
    }
    $broker = $folder.GetTask($brokerTask)
    Assert-RegisteredTask $broker $record
    Assert-RegisteredTask ($folder.GetTask($workerTask)) $record
    Start-VerifiedWatcher $broker
    $record.status='installed'; Save-Record $record
    'Watcher started with a current heartbeat.'
}

if ($MyInvocation.InvocationName -eq '.') { return }
if ($PSVersionTable.PSEdition -ne 'Desktop' -or -not [Environment]::Is64BitProcess) { throw 'Use 64-bit Windows PowerShell' }
if ($Mode -ne 'Rollback') {
    if (!$Package -or ![IO.Path]::IsPathRooted($Package) -or $PackageDigest -cnotmatch '^[0-9a-f]{64}$') {
        throw 'Supply the absolute package path and reviewed digest'
    }
    $Package = (Get-Item -LiteralPath $Package).FullName
    $hashes = Read-Package $Package
}
$scheduler = New-Object -ComObject Schedule.Service
$scheduler.Connect()
$folder = $scheduler.GetFolder('\')
Assert-Protected ([Environment]::GetFolderPath('ProgramFiles'))
if ($Mode -eq 'Plan') { Invoke-WatcherSetup $scheduler $folder; return }
if (-not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Applying or rolling back an approved watcher plan requires an administrator'
}
if (!(Test-Path -LiteralPath $root)) {
    if ($Mode -eq 'Rollback') { return }
    New-AccessDirectory $root '(A;OICI;GRGX;;;BU)'
}
Assert-Protected $root
$lockFile = Join-Path $root 'watcher-install.lock'
if ([IO.File]::Exists($lockFile)) { Assert-Protected $lockFile }
$lock = [IO.File]::Open($lockFile,'OpenOrCreate','ReadWrite','None')
try { Invoke-WatcherSetup $scheduler $folder } finally { $lock.Dispose() }
