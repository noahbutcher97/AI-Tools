# Run the three stages from an administrator-controlled copy beside the reviewed installer.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Prepare','Start','Run','Cleanup','RecoverSession')][string]$Stage,
    [Parameter(Mandatory)][guid]$TrialId,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedPackage,
    [string]$SessionScript,
    [guid]$Target,
    [switch]$RotateBrokerPassword,
    [switch]$Schedule,
    [switch]$FileWatch,
    [switch]$BranchWatch,
    [switch]$ArchiveVerified,
    [Nullable[long]]$RecordedTaskResult,
    [switch]$Mcp,
    [string]$McpClientImage,
    [ValidatePattern('^[a-f0-9]{64}$')][string]$McpClientDigest
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Install-CompletionWatcher.ps1')
function Register-TrialTask($name,$principal,$type,$arguments,$password) {
    $def = $scheduler.NewTask(0)
    $def.RegistrationInfo.Description = $tag
    $def.Principal.UserId = $principal
    $def.Principal.LogonType = $type
    $def.Principal.RunLevel = 0
    $def.Settings.ExecutionTimeLimit = 'PT12M'
    $def.Settings.MultipleInstances = 2
    $def.Settings.DisallowStartIfOnBatteries = $false
    $def.Settings.StopIfGoingOnBatteries = $false
    $def.Settings.Hidden = $true
    $action = $def.Actions.Create(0)
    $action.Path = $node
    $action.WorkingDirectory = $root
    $action.Arguments = $arguments
    $acl = 'O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)'
    if ($BranchWatch -and $name -ceq $runner -and $type -eq 3 -and $principal -ceq $desktopSid) {
        $acl += "(A;;GR;;;$desktopSid)"
    }
    return $folder.RegisterTaskDefinition($name,$def,18,$principal,$password,$type,$acl)
}

function Get-StoppedTrialTask($name) {
    $task = @($folder.GetTasks(1) | Where-Object Name -eq $name)
    if (!$task.Count) { return }
    if ($task.Count -ne 1 -or $task[0].Definition.RegistrationInfo.Description -cne $tag -or
        $task[0].Definition.Actions.Item(1).Path -ne $node) { throw 'Unexpected trial task' }
    if ($task[0].State -notin 1,3) { throw 'Trial task is running or its stopped state is unknown' }
    return $task[0]
}

function Remove-TrialTask($name) {
    if (Get-StoppedTrialTask $name) { $folder.DeleteTask($name,0) }
}

function Remove-ArchivedExchangeFiles {
    $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Use ordinary desktop PowerShell for session recovery' }
    if (!$ArchiveVerified -or !$Target -or $Target -eq [guid]::Empty) { throw 'Independently verify the archived trial name and raw target in the provider before recovery' }
    Assert-RecoveryEnrollment
    $task = Get-StoppedTrialTask $runner
    if (!$task -or (Resolve-Principal $task.Definition.Principal.UserId) -ne $desktopSid -or
        $task.Definition.Principal.LogonType -ne 3 -or $task.Definition.Principal.RunLevel -ne 0) { throw 'Expected the stopped desktop trial task' }
    Remove-VerifiedExchangeFiles $exchange $Target
}

function Assert-RecoveryEnrollment {
    Assert-Protected $journal
    $enrollment = [IO.File]::ReadAllText($journal) | ConvertFrom-Json
    if ($enrollment.status -cne 'installed' -or $enrollment.package -cne $ExpectedPackage -or
        $enrollment.sessionSid -cne $desktopSid) { throw 'Installation mismatch' }
}

function Remove-VerifiedExchangeFiles($directory,[guid]$archived) {
    Assert-PlainPath $directory
    $files = @()
    foreach ($file in [IO.Directory]::EnumerateFileSystemEntries($directory)) {
        $name = [IO.Path]::GetFileName($file)
        if ($name -cnotin @('target.json','resumed.json','target.json.tmp','resumed.json.tmp')) { throw 'Unexpected exchange entry; preserve for inspection' }
        Assert-PlainPath $file
        $item = Get-Item -LiteralPath $file -Force
        if ($item -isnot [IO.FileInfo] -or $item.Length -gt 1024) { throw 'Unexpected exchange entry; preserve for inspection' }
        if ($name.EndsWith('.json')) {
            $data = [IO.File]::ReadAllText($file) | ConvertFrom-Json
            if ($data.id -cne $archived.ToString('D')) { throw 'Exchange receipt differs from the independently verified archive' }
        }
        $files += $file
    }
    foreach ($file in $files) { [IO.File]::Delete($file) }
}

function Remove-SessionTrial {
    $sessionTask = Get-StoppedTrialTask $runner
    $grantTask = Get-StoppedTrialTask $issuer
    $hasExchange = Test-Path -LiteralPath $exchange -ErrorAction Stop
    if ($BranchWatch -and !$sessionTask -and $grantTask) { throw 'Expected the stopped desktop trial task' }
    if ($BranchWatch -and $sessionTask) {
        $result = $sessionTask.LastTaskResult
        if ($null -eq $result -or ($null -ne $RecordedTaskResult -and $RecordedTaskResult -ne $result)) { throw 'Recorded task result does not match' }
        if ($result -ne 0 -and $null -eq $RecordedTaskResult) {
            throw "Trial failed with task result $result. Keep this result, verify the archived session and complete ordinary desktop recovery before cleanup."
        }
    }
    if ($hasExchange) {
        Assert-PlainPath $exchange
        # Never inspect or traverse the desktop's files from the administrator.
        try { [IO.Directory]::Delete($exchange,$false) }
        catch [IO.IOException] { throw 'Exchange could not be removed. Preserve the task and finish ordinary desktop recovery.' }
    }
    Remove-TrialTask $issuer
    Remove-TrialTask $runner
}

function Set-ApprovedText($file,$expected,$replacement) {
    Assert-Protected $file
    if ([IO.File]::ReadAllText($file) -cne $expected) { throw 'Configuration changed during trial' }
    $temp = Join-Path $root ([guid]::NewGuid().ToString('N')+'.tmp')
    try {
        [IO.File]::WriteAllText($temp,$replacement,$utf)
        [IO.File]::Replace($temp,$file,[System.Management.Automation.Language.NullString]::Value)
    } finally { if ([IO.File]::Exists($temp)) { [IO.File]::Delete($temp) } }
}

function Restart-TrialBroker($expectedMode) {
    $task = $folder.GetTask($brokerTask)
    if ($task.State -in 2,4) { $task.Stop(0) }
    $end = [DateTime]::UtcNow.AddSeconds(15)
    while ($folder.GetTask($brokerTask).State -in 2,4) {
        if ([DateTime]::UtcNow -gt $end) { throw 'Broker stop timed out' }
        Start-Sleep -Milliseconds 150
    }
    try { Start-VerifiedWatcher ($folder.GetTask($brokerTask)) }
    catch {
        # A stopped task once exited before its first restoration heartbeat.
        # Retry only the idle broker after the trial authority has been removed.
        if ($expectedMode -cne 'reports_only' -or $folder.GetTask($brokerTask).State -ne 3 -or
            [IO.File]::ReadAllText($policyFile) -cne '{"v":1,"grants":[]}' -or
            [IO.File]::ReadAllText($flagFile) -cne '{"v":1,"enabled":false}') { throw }
        Start-VerifiedWatcher ($folder.GetTask($brokerTask))
    }
    $beat = Get-Content -LiteralPath (Join-Path $root 'completion-health/watcher.json') -Raw | ConvertFrom-Json
    if ($beat.mode -cne $expectedMode) { throw 'Unexpected watcher mode' }
}

function Get-TrialOutcome($database,$sessionId) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $node
    $info.Arguments = '"'+$verifier+'" "'+$database+'" '+$sessionId
    $info.WorkingDirectory = $trial
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.EnvironmentVariables.Clear()
    $info.EnvironmentVariables['SystemRoot'] = [Environment]::GetFolderPath('Windows')
    $info.EnvironmentVariables['PATH'] = [Environment]::SystemDirectory
    $info.EnvironmentVariables['NODE_NO_WARNINGS'] = '1'
    $process = [Diagnostics.Process]::Start($info)
    try {
        $output = $process.StandardOutput.ReadToEndAsync()
        $errors = $process.StandardError.ReadToEndAsync()
        if (!$process.WaitForExit(5000)) { $process.Kill(); throw 'Status lookup timed out' }
        if ($process.ExitCode -ne 0 -or $errors.Result.Length) { throw 'Status lookup failed' }
        return $output.Result
    } finally { $process.Dispose() }
}

function Assert-McpClient($image,$digest) {
    if (!$image -or ![IO.Path]::IsPathRooted($image) -or [IO.Path]::GetFileName($image) -ine 'codex.exe') {
        throw 'Expected an absolute Codex client executable'
    }
    Assert-PlainPath $image
    $hostImage=Join-Path ([IO.Path]::GetDirectoryName($image)) 'codex-code-mode-host.exe'
    if (![IO.File]::Exists($hostImage)) { throw 'MCP qualification requires the installed code-mode host' }
    Assert-PlainPath $hostImage
    if (!$digest -or (Get-FileHash -LiteralPath $image).Hash -ine $digest) { throw 'Client executable differs from the reviewed session client' }
}

function Get-TrialClientMode {
    if ($BranchWatch) {
        if ($Stage -notin @('Start','Cleanup','RecoverSession') -or $Schedule -or $FileWatch -or $RotateBrokerPassword) {
            throw 'Use the branch client only for Start, Cleanup or RecoverSession with a single condition'
        }
        if ($Mcp) { return '--installed-mcp-branch' }
        return '--installed-branch'
    }
    if (($Schedule -or $FileWatch) -and $RotateBrokerPassword) { throw 'Watch issuance uses the running broker identity' }
    if ($FileWatch -and (!$Mcp -or $Schedule)) { throw 'The file trial requires MCP and a single condition' }
    if ($Mcp -and !($Schedule -or $FileWatch)) { throw 'The MCP trial requires a watch' }
    if ($FileWatch) { return '--installed-mcp-file' }
    if ($Mcp) { return '--installed-mcp-schedule' }
    if ($Schedule) { return '--installed-schedule' }
    return '--installed'
}
if ($MyInvocation.InvocationName -eq '.') { return }
$modeFlag = Get-TrialClientMode
if (($ArchiveVerified -or $Stage -eq 'RecoverSession') -and (!$BranchWatch -or $Stage -ne 'RecoverSession')) { throw 'Archive verification requires branch session recovery' }
if ($null -ne $RecordedTaskResult -and (!$BranchWatch -or $Stage -ne 'Cleanup')) { throw 'Record the failed task result during branch cleanup' }
$tag = 'RelayWatcherTrial-' + $TrialId.ToString('N')
$trial = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) $tag
$exchange = Join-Path $trial 'session'
$runner = $tag + '-Session'
$issuer = $tag + '-Grant'
$node = Join-Path $root 'runtime/node.exe'
$scheduler = New-Object -ComObject Schedule.Service
$scheduler.Connect()
$folder = $scheduler.GetFolder('\')
if ($Stage -eq 'RecoverSession') {
    Assert-Protected $trial
    Remove-ArchivedExchangeFiles
    return
}
$record = Get-Content -LiteralPath $journal -Raw | ConvertFrom-Json
$account = Get-LocalUser -Name $accountName
if ($record.status -cne 'installed' -or $record.package -cne $ExpectedPackage -or
    $record.brokerSid -ne $account.SID.Value -or $account.Description -cne $record.tag -or
    !$account.Enabled -or $record.sessionSid -ne $desktopSid -or $desktopSid -eq $record.brokerSid) { throw 'Installation mismatch' }
$broker = $folder.GetTask($brokerTask)
Assert-Protected $root
Assert-Protected $journal
Assert-RegisteredTask $broker $record
Assert-RegisteredTask ($folder.GetTask($workerTask)) $record
$providerImage = Join-Path $root 'provider/codex.exe'
$brokerModule = Join-Path $root 'relay/completion-broker.mjs'
$policyFile = Join-Path $root 'completion-policy.json'
$flagFile = Join-Path $root 'completion-worker.json'
foreach ($p in @($node,$providerImage,$brokerModule,$policyFile,$flagFile)) { Assert-Protected $p }
$utf = [Text.UTF8Encoding]::new($false)

if ($Stage -eq 'Prepare') {
    # A desktop caller already owns the disposable client and has captured its
    # raw ID. Set up the protected signals without registering a second runner.
    if (!$Mcp -or !$Target -or $Target -eq [guid]::Empty) { throw 'Expected a pinned MCP trial thread' }
    New-AccessDirectory $trial "(A;OICI;GRGX;;;$desktopSid)"
    New-AccessDirectory $exchange "(A;OICI;0x1301bf;;;$desktopSid)"
    return
}
if ($Stage -eq 'Start') {
    if (!$SessionScript -or ![IO.Path]::IsPathRooted($SessionScript) -or
        [IO.Path]::GetFileName($SessionScript) -cne 'Qualify-CodexCompletion.mjs' -or
        ![IO.File]::Exists($SessionScript)) { throw 'Expected the qualification runner' }
    if ($Mcp) {
        Assert-McpClient $McpClientImage $McpClientDigest
        # The desktop session task runs the regular client under the session
        # account. The protected worker keeps its own installed queue image.
        $providerImage=$McpClientImage
    }
    New-AccessDirectory $trial "(A;OICI;GRGX;;;$desktopSid)"
    New-AccessDirectory $exchange "(A;OICI;0x1301bf;;;$desktopSid)"
    $argsText = '"'+$SessionScript+'" "'+$providerImage+'" '+$modeFlag+' "'+$exchange+'"'
    if ($BranchWatch) { $argsText += ' '+$TrialId.ToString('D') }
    $task = Register-TrialTask $runner $desktopSid 3 $argsText $null
    $null = $task.Run($null)
    return
}
Assert-Protected $trial
if ($Stage -eq 'Cleanup') {
    Remove-SessionTrial
    if ($FileWatch) {
        $resource = Join-Path $trial 'resource'
        if ([IO.Directory]::Exists($resource)) {
            Assert-Protected $resource
            $item = Join-Path $resource 'item'
            if ([IO.File]::Exists($item)) { Assert-Protected $item; [IO.File]::Delete($item) }
            [IO.Directory]::Delete($resource,$false)
        }
    }
    foreach ($name in @('authorized','finished','verify.cjs','result.txt')) {
        $file = Join-Path $trial $name
        if ([IO.File]::Exists($file)) { Assert-Protected $file; [IO.File]::Delete($file) }
    }
    [IO.Directory]::Delete($trial,$false)
    return
}
if (!$Target -or $Target -eq [guid]::Empty) { throw 'Run requires a pinned trial target' }
$id = $Target.ToString('D')
$empty = '{"v":1,"grants":[]}'
$off = '{"v":1,"enabled":false}'
$on = '{"v":1,"enabled":true}'
$verifier = Join-Path $trial 'verify.cjs'
$resultFile = Join-Path $trial 'result.txt'
$expires = [DateTime]::UtcNow.AddMinutes(4).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
$trialPolicy = @{v=1;grants=@(@{id=$id;provider='codex';scope='thread-status'})}
if (!$RotateBrokerPassword) { $trialPolicy.v=2; $trialPolicy.startupRun=@{id=$id;expiresAt=$expires} }
if ($Schedule) {
    $condition = $TrialId.ToString('D')
    $leadSeconds = if ($Mcp) { 75 } else { 30 }
    $startsAt = [DateTime]::UtcNow.AddSeconds($leadSeconds).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    $trialPolicy = @{v=3;grants=@();schedules=@(@{condition=$condition;target=$id;provider='codex';scope='thread-schedule';
        intervalSeconds=86400;startsAt=$startsAt;expiresAt=$expires})}
}
if ($FileWatch) {
    $condition = $TrialId.ToString('D')
    $resource = Join-Path $trial 'resource'
    New-AccessDirectory $resource "(A;OICI;GRGX;;;$($record.brokerSid))"
    $item = Join-Path $resource 'item'
    [IO.File]::WriteAllText($item,'fixture',$utf)
    Assert-Protected $item
    $drive = [IO.Path]::GetPathRoot($resource)
    $volumePath = (& (Join-Path ([Environment]::SystemDirectory) 'mountvol.exe') $drive /L | Out-String).Trim()
    if ($LASTEXITCODE -or $volumePath -notmatch '\{([a-fA-F0-9-]{36})\}\\$') { throw 'Expected a fixed local volume' }
    $volume = ([guid]$Matches[1]).ToString('D')
    $directory = $resource.Substring($drive.Length).Replace('\','/')
    $helper = Join-Path $root 'relay/FileObservation.exe'
    Assert-Protected $helper
    $type = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($helper)).GetType('FileObservation',$true)
    $rootId = $type::RootIdentity($volume,$directory)
    $trialPolicy = @{v=4;grants=@();schedules=@();files=@(@{condition=$condition;target=$id;provider='codex';
        scope='thread-file-change';volume=$volume;directory=$directory;rootId=$rootId;file='item';expiresAt=$expires})}
}
$approved = $trialPolicy | ConvertTo-Json -Depth 4 -Compress
$policyChanged = $false
$flagChanged = $false
$createdTask = $false
$lockPath = Join-Path $root 'watcher-install.lock'
Assert-Protected $lockPath
$lock = [IO.File]::Open($lockPath,'Open','ReadWrite','None')
try {
    if ([IO.File]::ReadAllText($flagFile) -cne $off -or [IO.File]::ReadAllText($policyFile) -cne $empty) {
        throw 'Trial requires empty grants and reports-only mode'
    }
    # Query only status for this trial. No handle, transcript text or bearer leaves the store.
    $source = @'
const { DatabaseSync } = require('node:sqlite');
const [file,id] = process.argv.slice(2);
const db = new DatabaseSync(file, {readOnly:true});
try {
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON');
  const rows = db.prepare('SELECT state,code,signal,run_only,provider,handle IS NOT NULL AS reserved FROM jobs WHERE recipient=? LIMIT 2').all(id);
  if (rows.length === 0) process.stdout.write('absent');
  else if (rows.length !== 1 || !rows[0].run_only || rows[0].provider !== 'codex') process.stdout.write('invalid');
  else if (rows[0].state === 'delivered' && rows[0].reserved && rows[0].code === 23 && rows[0].signal === null) process.stdout.write('proved');
  else process.stdout.write(['waiting','claimed','ready','observing','dispatching'].includes(rows[0].state) ? rows[0].state : 'invalid');
} finally { db.close(); }
'@
    if ($Schedule) {
        $source = @'
const { DatabaseSync } = require('node:sqlite');
const [file,condition] = process.argv.slice(2);
const db = new DatabaseSync(file, {readOnly:true});
try {
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON');
  const row = db.prepare('SELECT state,cursor,retry_at FROM schedule_watches WHERE condition=?').get(condition);
  if (!row) process.stdout.write('absent');
  else if (row.state === 'waiting' && row.cursor === -1 && row.retry_at === 0) process.stdout.write('armed');
  else if (row.state === 'waiting' && row.cursor === 0 && row.retry_at > 0) process.stdout.write('proved');
  else process.stdout.write(['issued','waiting','observing','dispatching'].includes(row.state) ? row.state : 'invalid');
} finally { db.close(); }
'@
    }
    if ($FileWatch) {
        $source = @'
const { DatabaseSync } = require('node:sqlite');
const [file,condition] = process.argv.slice(2);
const db = new DatabaseSync(file, {readOnly:true});
try {
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON');
  const row = db.prepare('SELECT w.state, s.baseline IS NOT NULL AS sampled FROM schedule_watches w LEFT JOIN file_samples s USING(condition) WHERE w.condition=?').get(condition);
  process.stdout.write(!row ? 'absent' : row.state === 'delivered' ? 'proved' : row.state === 'waiting' && row.sampled ? 'armed' : row.state);
} finally { db.close(); }
'@
    }
    if ([IO.File]::Exists($verifier)) { throw 'Trial already started' }
    [IO.File]::WriteAllText($verifier,$source,$utf)
    $db = Join-Path $root 'completion-state/jobs.sqlite'
    Assert-PlainPath $db
    $lookup = if ($Schedule -or $FileWatch) { $condition } else { $id }
    if ((Get-TrialOutcome $db $lookup) -cne 'absent') { throw 'Expected a new disposable target' }
    Set-ApprovedText $policyFile $empty $approved
    $policyChanged = $true
    if ($RotateBrokerPassword) {
        $pw = New-BrokerPassword
        try {
            Set-LocalUser -SID $account.SID -Password $pw
            $argsText = '"'+$brokerModule+'" --provision-run '+$id+' 1 '+$expires
            $credential = [pscredential]::new($account.Name,$pw)
            $task = Register-TrialTask $issuer $record.brokerSid 2 $argsText $credential.GetNetworkCredential().Password
            $createdTask = $true
        } finally { $pw.Dispose() }
        $null = $task.Run($null)
        $end = [DateTime]::UtcNow.AddSeconds(30)
        do {
            Start-Sleep -Milliseconds 250
            $task=$folder.GetTask($issuer)
            if ([DateTime]::UtcNow -gt $end) { throw 'Grant provisioning timed out' }
        } while ($task.State -in 2,4 -or $task.LastTaskResult -eq 267011)
        if ($task.LastTaskResult -ne 0) { throw 'Broker declined grant provisioning' }
    }
    if ($Mcp) {
        # Exercise MCP against an already watching broker, as it runs after
        # logon. The CLI trial separately restarts the broker after activation.
        Set-ApprovedText $flagFile $off $on
        $flagChanged=$true
        Restart-TrialBroker 'watching'
    }
    if ($Schedule -or $FileWatch) {
        if (!$Mcp) { Restart-TrialBroker 'reports_only' }
        if ((Get-TrialOutcome $db $lookup) -cne 'issued') { throw 'Expected a new schedule grant' }
        [IO.File]::WriteAllText((Join-Path $trial 'authorized'),$condition,$utf)
        $end = [DateTime]::UtcNow.AddSeconds(120)
        $resumed = Join-Path $exchange 'resumed.json'
        while (!(Test-Path -LiteralPath $resumed)) {
            if ([DateTime]::UtcNow -gt $end) { throw 'Disposable writer did not resume' }
            Start-Sleep -Milliseconds 250
        }
        if ($FileWatch) {
            while ((Get-TrialOutcome $db $lookup) -cne 'armed') {
                if ([DateTime]::UtcNow -gt $end) { throw 'The installed worker could not obtain a file baseline' }
                Start-Sleep -Milliseconds 500
            }
            Assert-Protected $item
            [IO.File]::Delete($item)
        } else {
            if ((Get-TrialOutcome $db $lookup) -cne 'armed') { throw 'The first scheduled tick must follow activation' }
            if ($Mcp -and [DateTime]::UtcNow -ge ([DateTimeOffset]::Parse($startsAt)).UtcDateTime) { throw 'The writer must resume before the first tick' }
        }
    }
    if (!$Mcp) {
        Set-ApprovedText $flagFile $off $on
        $flagChanged = $true
        Restart-TrialBroker 'watching'
    }
    if (!($Schedule -or $FileWatch)) {
        if ((Get-TrialOutcome $db $id) -cne 'waiting') { throw 'Expected exactly one waiting job for the trial thread' }
        [IO.File]::WriteAllText((Join-Path $trial 'authorized'),'',$utf)
    }
    $end=[DateTime]::UtcNow.AddSeconds(90)
    if ($Schedule) {
        $tickDeadline=([DateTimeOffset]::Parse($startsAt)).UtcDateTime.AddSeconds(90)
        if ($tickDeadline -gt $end) { $end=$tickDeadline }
    }
    do {
        $state=Get-TrialOutcome $db $lookup
        if ($state -eq 'invalid') { throw 'Invalid trial outcome' }
        if ($state -eq 'proved') { break }
        if ([DateTime]::UtcNow -gt $end) { throw "Transcript proof timed out ($state)" }
        Start-Sleep -Milliseconds 600
    } while ($true)
    [IO.File]::WriteAllText($resultFile,'proved',$utf)
} catch {
    [IO.File]::WriteAllText($resultFile,('failed at line '+$_.InvocationInfo.ScriptLineNumber+': '+$_.Exception.Message),$utf)
    throw
} finally {
    try {
        try { if ($policyChanged) { Set-ApprovedText $policyFile $approved $empty } }
        finally {
            if ($flagChanged) { Set-ApprovedText $flagFile $on $off; Restart-TrialBroker 'reports_only' }
        }
    } finally {
        $lock.Dispose()
        [IO.File]::WriteAllText((Join-Path $trial 'finished'),'',$utf)
        if ($createdTask) { Remove-TrialTask $issuer }
    }
}
