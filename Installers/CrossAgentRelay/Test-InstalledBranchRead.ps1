# Run from protected copies of the three reviewed trial and setup scripts.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$PackageHash,
    [Parameter(Mandatory)][uri]$Endpoint,
    [Parameter(Mandatory)][string]$Ref,
    [Parameter(Mandatory)][ValidatePattern('^([a-f0-9]{40}|[a-f0-9]{64})$')][string]$ExpectedRevision,
    [Parameter(Mandatory)][ValidateSet('ucrt64','mingw64')][string]$Edition,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ImageHash,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$TransportHash
)
$ErrorActionPreference = 'Stop'
if (!$Endpoint.IsAbsoluteUri -or $Endpoint.Scheme -cne 'https' -or $Endpoint.UserInfo -or $Endpoint.Query -or $Endpoint.Fragment) {
    throw 'Expected an anonymous HTTPS repository'
}
$condition = [guid]::NewGuid()
. (Join-Path $PSScriptRoot 'Test-InstalledCodexWatcher.ps1') -Stage Run -TrialId $condition -ExpectedPackage $PackageHash
$fixtureTarget = [guid]::NewGuid()
$record = Get-Content -LiteralPath $journal -Raw | ConvertFrom-Json
if ($record.status -cne 'installed' -or $record.package -cne $PackageHash -or $record.sessionSid -ne $desktopSid) { throw 'Installation mismatch' }
$scheduler = New-Object -ComObject Schedule.Service
$scheduler.Connect()
$folder = $scheduler.GetFolder('\')
foreach ($name in @($workerTask,$brokerTask)) { Assert-RegisteredTask ($folder.GetTask($name)) $record }
$policyFile = Join-Path $root 'completion-policy.json'
$flagFile = Join-Path $root 'completion-worker.json'
$gitFile = Join-Path $root 'completion-git.json'
$node = Join-Path $root 'runtime/node.exe'
$lockFile = Join-Path $root 'watcher-install.lock'
foreach ($file in @($journal,$policyFile,$flagFile,$node,$lockFile)) { Assert-Protected $file }
$trial = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) ('RelayBranchTrial-'+$condition.ToString('N'))
$verifier = Join-Path $trial 'verify.cjs'
$paramsFile = Join-Path $trial 'parameters.json'
$empty = '{"v":1,"grants":[]}'
$off = '{"v":1,"enabled":false}'
$on = '{"v":1,"enabled":true}'
$git = @{v=1;edition=$Edition;imageHash=$ImageHash;transportHash=$TransportHash} | ConvertTo-Json -Compress
$utf = [Text.UTF8Encoding]::new($false)
$created = $false
$profileCreated = $false
$policyChanged = $false
$flagChanged = $false
$lock = [IO.File]::Open($lockFile,'Open','ReadWrite','None')
try {
    if ([IO.File]::ReadAllText($flagFile) -cne $off -or [IO.File]::ReadAllText($policyFile) -cne $empty -or
        [IO.File]::Exists($gitFile)) { throw 'Trial requires idle policy and an unused Git profile' }
    New-AccessDirectory $trial ''
    $created = $true
    $parameters = @{target=$fixtureTarget.ToString('D');revision=$ExpectedRevision} | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($paramsFile,$parameters,$utf)
    $source = @'
const fs = require('node:fs'), path = require('node:path');
const {pathToFileURL} = require('node:url');
const {DatabaseSync} = require('node:sqlite');
const {createHash} = require('node:crypto');
const [file,condition] = process.argv.slice(2);
const root = path.dirname(path.dirname(process.execPath));
const load = name => import(pathToFileURL(path.join(root,'relay',name+'.mjs')).href);
(async () => {
  const {target,revision} = JSON.parse(fs.readFileSync(path.join(__dirname,'parameters.json'),'utf8'));
  const db = new DatabaseSync(file,{readOnly:true});
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON');
    const row = db.prepare('SELECT w.state,s.baseline,w.handle FROM schedule_watches w LEFT JOIN file_samples s USING(condition) WHERE w.condition=?').get(condition);
    if (row?.state === 'issued') {
      const {branchBinding} = await load('schedule-watch');
      const grant = (await load('run-handoff')).readScheduleGrant(root,branchBinding(target,condition),target,condition);
      await (await load('completion-broker')).reportJob(grant,'activate_branch',{session:target});
      process.stdout.write('waiting');
    } else if (row?.state === 'waiting' && row.handle === null) {
      const expected = createHash('sha256').update(revision).digest('hex');
      process.stdout.write(row.baseline === null ? 'waiting' : row.baseline === expected ? 'proved' : 'different');
    } else process.stdout.write('invalid');
  } finally { db.close(); }
})().catch(() => {process.exitCode=1});
'@
    [IO.File]::WriteAllText($verifier,$source,$utf)
    $stream = [IO.File]::Open($gitFile,'CreateNew','Write','None')
    $profileCreated = $true
    try { $bytes=$utf.GetBytes($git); $stream.Write($bytes,0,$bytes.Length) } finally { $stream.Dispose() }
    Assert-Protected $gitFile
    # The minimum observation interval is one minute. This fixture expires
    # before a second sample and cannot generate a change notification.
    $expires = [DateTime]::UtcNow.AddSeconds(50).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    $grant = @{condition=$condition.ToString('D');target=$fixtureTarget.ToString('D');provider='codex';scope='thread-branch-change';
        endpoint=$Endpoint.AbsoluteUri;ref=$Ref;credential=$null;expiresAt=$expires}
    $approved = @{v=5;grants=@();schedules=@();files=@();branches=@($grant)} | ConvertTo-Json -Depth 4 -Compress
    Set-ApprovedText $policyFile $empty $approved
    $policyChanged = $true
    Set-ApprovedText $flagFile $off $on
    $flagChanged = $true
    Restart-TrialBroker 'watching'
    $db = Join-Path $root 'completion-state/jobs.sqlite'
    Assert-PlainPath $db
    do {
        $result = Get-TrialOutcome $db $condition.ToString('D')
        if ($result -eq 'proved') { break }
        if ($result -ne 'waiting' -or [DateTimeOffset]::UtcNow -ge [DateTimeOffset]::Parse($expires)) { throw 'Exact installed branch baseline unproved' }
        Start-Sleep -Milliseconds 500
    } while ($true)
} finally {
    try {
        try {
            if ($policyChanged) { Set-ApprovedText $policyFile $approved $empty }
        } finally {
            try {
                if ($profileCreated) { Assert-Protected $gitFile; [IO.File]::Delete($gitFile) }
            } finally {
                if ($flagChanged) { Set-ApprovedText $flagFile $on $off; Restart-TrialBroker 'reports_only' }
            }
        }
    } finally {
        $lock.Dispose()
        if ($created) {
            foreach ($file in @($verifier,$paramsFile)) { if ([IO.File]::Exists($file)) { Assert-Protected $file; [IO.File]::Delete($file) } }
            [IO.Directory]::Delete($trial,$false)
        }
    }
}
'Installed broker matched the expected branch revision with no notice.'
