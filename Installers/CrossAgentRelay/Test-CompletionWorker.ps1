# Exercise only worker authentication with a temporary service-account task.
# Run from a reviewed checkout, in an elevated Windows PowerShell session
# belonging to the signed-in desktop user. No relay keys or providers are used.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'The disposable qualification requires an administrator.'
}
$sessionSid = $identity.User.Value
$brokerSid = 'S-1-5-19'
$tag = [guid]::NewGuid().ToString('N')
$workerName = 'CrossAgentRelayCompletionWorker'
$checkName = 'CrossAgentRelayCheck-' + $tag
$taskUri = 'urn:relay:check:' + $tag
$base = [Environment]::GetFolderPath('ProgramFiles')
$root = Join-Path $base ('CrossAgentRelay-Check-' + $tag)
$source = (Resolve-Path (Join-Path $PSScriptRoot '../../MCP-Servers/bridges/relay')).Path
$scheduler = New-Object -ComObject Schedule.Service
$scheduler.Connect()
$folder = $scheduler.GetFolder('\')
$taskAcl = "O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;$brokerSid)"
$registered = [Collections.Generic.List[string]]::new()
$files = [Collections.Generic.List[string]]::new()
$dirs = [Collections.Generic.List[string]]::new()

function Register-CheckTask([string]$Name, [string]$Sid, [int]$Type, [string]$Arguments) {
    $definition = $scheduler.NewTask(0)
    $definition.RegistrationInfo.Description = $taskUri
    $definition.Principal.UserId = $Sid
    $definition.Principal.LogonType = $Type
    $definition.Principal.RunLevel = 0
    $definition.Settings.MultipleInstances = 0
    $definition.Settings.ExecutionTimeLimit = 'PT1M'
    $definition.Settings.DisallowStartIfOnBatteries = $false
    $definition.Settings.StopIfGoingOnBatteries = $false
    $definition.Settings.Hidden = $true
    $action = $definition.Actions.Create(0)
    $action.Path = Join-Path $root 'CompletionChannel.exe'
    $action.Arguments = $Arguments
    $action.WorkingDirectory = $root
    # TASK_CREATE | TASK_DONT_ADD_PRINCIPAL_ACE. An existing task is never updated.
    $task = $folder.RegisterTaskDefinition($Name, $definition, 18, $Sid, $null, $Type, $taskAcl)
    $registered.Add($Name)
    return $task
}

try {
    $null = New-Item -ItemType Directory -Path $root
    $dirs.Add($root)
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetSecurityDescriptorSddlForm("O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;GRGX;;;$brokerSid)(A;OICI;GRGX;;;$sessionSid)")
    [IO.Directory]::SetAccessControl($root, $acl)
    foreach ($name in @('relay','runtime')) {
        $p = Join-Path $root $name
        $null = New-Item -ItemType Directory -Path $p
        $dirs.Add($p)
    }
    foreach ($name in @('completion-worker','completion-session','completion-protocol','delivery-protocol','local-ping','proof','client','identity','provider-process')) {
        $dest = Join-Path $root ('relay/' + $name + '.mjs')
        $files.Add($dest)
        [IO.File]::Copy((Join-Path $source ($name + '.mjs')), $dest)
    }
    $runtime = Join-Path $root 'runtime/node.exe'
    $files.Add($runtime)
    [IO.File]::Copy((Get-Command node.exe -CommandType Application | Select-Object -First 1).Source, $runtime)
    $config = Join-Path $root 'completion-principals.json'
    $files.Add($config)
    [IO.File]::WriteAllText($config, (@{brokerSid=$brokerSid;sessionSid=$sessionSid} | ConvertTo-Json -Compress))
    $image = Join-Path $root 'CompletionChannel.exe'
    $files.Add($image)
    $compiler = Join-Path ([Environment]::GetFolderPath('Windows')) 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    & $compiler /nologo /target:winexe /r:System.Web.Extensions.dll "/out:$image" (Join-Path $source 'CompletionChannel.cs')
    if ($LASTEXITCODE) { throw 'Helper compilation failed.' }
    $null = Register-CheckTask $workerName $sessionSid 3 'worker $(Arg0)'
    $check = Register-CheckTask $checkName $brokerSid 5 'qualify'
    $instance = $check.Run($null)
    $end = [DateTime]::UtcNow.AddSeconds(65)
    do {
        Start-Sleep -Milliseconds 250
        $check = $folder.GetTask($checkName)
        if ([DateTime]::UtcNow -ge $end) { throw 'Qualification timed out.' }
    } while ($check.State -in @(2,4) -or $check.LastTaskResult -eq 267011)
    if ($check.LastTaskResult -ne 0) {
        $workerResult = $folder.GetTask($workerName).LastTaskResult
        throw ("Qualification failed. Broker result {0}, worker result {1}." -f $check.LastTaskResult,$workerResult)
    }
    'Authenticated worker check passed across distinct Windows principals.'
} finally {
    $registered.Reverse()
    foreach ($name in $registered) {
        $t = $folder.GetTask($name)
        if ($t.Definition.RegistrationInfo.Description -ne $taskUri -or $t.Definition.Actions.Item(1).Path -ne $image) {
            throw 'Task ownership changed during qualification.'
        }
        if ($t.State -in @(2,4)) { $t.Stop(0) }
        $folder.DeleteTask($name, 0)
    }
    # Only remove individually recorded artifacts from this invocation.
    if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($root)) -ne $base) { throw 'Unexpected qualification root.' }
    $dirs.Reverse()
    foreach ($p in @($files.ToArray()) + @($dirs.ToArray())) {
        for ($i=0; $i -lt 20 -and (Test-Path -LiteralPath $p); $i++) {
            try {
                if ([IO.File]::Exists($p)) { [IO.File]::Delete($p) } else { [IO.Directory]::Delete($p, $false) }
            } catch [IO.IOException], [UnauthorizedAccessException] {
                if ($i -eq 19) { throw }
                Start-Sleep -Milliseconds 150
            }
        }
    }
}
