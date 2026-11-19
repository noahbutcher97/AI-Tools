# Run the three stages from an administrator-controlled copy beside the reviewed installer.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Prepare','Start','Run','Cleanup')][string]$Stage,
    [Parameter(Mandatory)][guid]$TrialId,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedPackage,
    [string]$SessionScript,
    [guid]$Target,
    [switch]$RotateBrokerPassword,
    [switch]$Schedule,
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
    return $folder.RegisterTaskDefinition($name,$def,18,$principal,$password,$type,$acl)
}

function Remove-TrialTask($name) {
    $task = @($folder.GetTasks(1) | Where-Object Name -eq $name)
    if (!$task.Count) { return }
    if ($task.Count -ne 1 -or $task[0].Definition.RegistrationInfo.Description -cne $tag -or
        $task[0].Definition.Actions.Item(1).Path -ne $node) { throw 'Unexpected trial task' }
    if ($task[0].State -in 2,4) { throw 'Trial task is still running' }
    $folder.DeleteTask($name,0)
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

if ($MyInvocation.InvocationName -eq '.') { return }
if ($Schedule -and $RotateBrokerPassword) { throw 'Schedule issuance uses the running broker identity' }
if ($Mcp -and !$Schedule) { throw 'The MCP trial requires a schedule' }
$record = Get-Content -LiteralPath $journal -Raw | ConvertFrom-Json
$account = Get-LocalUser -Name $accountName
if ($record.status -cne 'installed' -or $record.package -cne $ExpectedPackage -or
    $record.brokerSid -ne $account.SID.Value -or $account.Description -cne $record.tag -or
    !$account.Enabled -or $record.sessionSid -ne $desktopSid -or $desktopSid -eq $record.brokerSid) { throw 'Installation mismatch' }
$scheduler = New-Object -ComObject Schedule.Service
$scheduler.Connect()
$folder = $scheduler.GetFolder('\')
$broker = $folder.GetTask($brokerTask)
Assert-Protected $root
Assert-Protected $journal
Assert-RegisteredTask $broker $record
Assert-RegisteredTask ($folder.GetTask($workerTask)) $record
$tag = 'RelayWatcherTrial-' + $TrialId.ToString('N')
$trial = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) $tag
$exchange = Join-Path $trial 'session'
$runner = $tag + '-Session'
$issuer = $tag + '-Grant'
$node = Join-Path $root 'runtime/node.exe'
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
    $modeFlag = if ($Mcp) { '--installed-mcp-schedule' } elseif ($Schedule) { '--installed-schedule' } else { '--installed' }
    $argsText = '"'+$SessionScript+'" "'+$providerImage+'" '+$modeFlag+' "'+$exchange+'"'
    $task = Register-TrialTask $runner $desktopSid 3 $argsText $null
    $null = $task.Run($null)
    return
}
Assert-Protected $trial
if ($Stage -eq 'Cleanup') {
    Remove-TrialTask $issuer
    Remove-TrialTask $runner
    Assert-PlainPath $exchange
    # The unelevated runner cleans its output. Never traverse its files for deletion.
    [IO.Directory]::Delete($exchange,$false)
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
    if ([IO.File]::Exists($verifier)) { throw 'Trial already started' }
    [IO.File]::WriteAllText($verifier,$source,$utf)
    $db = Join-Path $root 'completion-state/jobs.sqlite'
    Assert-PlainPath $db
    $lookup = if ($Schedule) { $condition } else { $id }
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
    if ($Schedule) {
        Restart-TrialBroker 'reports_only'
        if ((Get-TrialOutcome $db $lookup) -cne 'issued') { throw 'Expected a new schedule grant' }
        [IO.File]::WriteAllText((Join-Path $trial 'authorized'),$condition,$utf)
        $end = [DateTime]::UtcNow.AddSeconds($leadSeconds+45)
        $resumed = Join-Path $exchange 'resumed.json'
        while (!(Test-Path -LiteralPath $resumed)) {
            if ([DateTime]::UtcNow -gt $end) { throw 'Disposable writer did not resume' }
            Start-Sleep -Milliseconds 250
        }
        if ((Get-TrialOutcome $db $lookup) -cne 'armed') { throw 'The first scheduled tick must follow activation' }
    }
    Set-ApprovedText $flagFile $off $on
    $flagChanged = $true
    Restart-TrialBroker 'watching'
    if (!$Schedule) {
        if ((Get-TrialOutcome $db $id) -cne 'waiting') { throw 'Expected exactly one waiting job for the trial thread' }
        [IO.File]::WriteAllText((Join-Path $trial 'authorized'),'',$utf)
    }
    $end=[DateTime]::UtcNow.AddSeconds(90)
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
