# Run from protected copies of the three reviewed trial and setup scripts.
[CmdletBinding(DefaultParameterSetName='Read')]
param(
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$PackageHash,
    [Parameter(Mandatory,ParameterSetName='Read')][uri]$Endpoint,
    [Parameter(Mandatory,ParameterSetName='Read')][string]$Ref,
    [Parameter(Mandatory,ParameterSetName='Read')][ValidatePattern('^([a-f0-9]{40}|[a-f0-9]{64})$')][string]$ExpectedRevision,
    [Parameter(Mandatory,ParameterSetName='Read')][ValidateSet('ucrt64','mingw64')][string]$Edition,
    [Parameter(Mandatory,ParameterSetName='Read')][ValidatePattern('^[a-f0-9]{64}$')][string]$ImageHash,
    [Parameter(Mandatory,ParameterSetName='Read')][ValidatePattern('^[a-f0-9]{64}$')][string]$TransportHash,
    [Parameter(ParameterSetName='Read')][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')][string]$ReaderUser,
    [Parameter(ParameterSetName='Read')][guid]$MovementTarget,
    [Parameter(ParameterSetName='Read')][guid]$MovementCondition,
    [Parameter(Mandatory,ParameterSetName='Recover')][guid]$RecoverTrial
)
$ErrorActionPreference = 'Stop'
$movement = $PSBoundParameters.ContainsKey('MovementTarget') -or $PSBoundParameters.ContainsKey('MovementCondition')
if ($movement -and (!$ReaderUser -or !$MovementTarget -or !$MovementCondition -or
    $MovementTarget -eq [guid]::Empty -or $MovementCondition -eq [guid]::Empty)) {
    throw 'Private movement requires a reader, a disposable raw target and a fresh condition ID'
}
if (!$RecoverTrial -and (!$Endpoint.IsAbsoluteUri -or $Endpoint.Scheme -cne 'https' -or $Endpoint.UserInfo -or $Endpoint.Query -or $Endpoint.Fragment)) {
    throw 'Expected an HTTPS repository without embedded credentials'
}
function Protect-TrialReader([securestring]$Password,[string]$Username,[byte[]]$Binding) {
    $prefix = [Text.Encoding]::ASCII.GetBytes($Username+':')
    if ($Password.Length -lt 1 -or $Password.Length+$prefix.Length -gt 4096) { throw 'Invalid reader credential' }
    $bytes = [byte[]]::new($prefix.Length+$Password.Length)
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Password)
    try {
        [Array]::Copy($prefix,$bytes,$prefix.Length)
        for ($i=0; $i -lt $Password.Length; $i++) {
            $n = [Runtime.InteropServices.Marshal]::ReadInt16($ptr,$i*2)
            if ($n -lt 33 -or $n -gt 126) { throw 'Unsupported reader credential format' }
            $bytes[$prefix.Length+$i] = [byte]$n
        }
        Add-Type -AssemblyName System.Security
        return ,([Security.Cryptography.ProtectedData]::Protect($bytes,$Binding,'LocalMachine'))
    } finally {
        [Array]::Clear($bytes,0,$bytes.Length)
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    }
}
function Assert-PrivateBranchSupport($inputGrant) {
    $validate = @'
const fs=require('node:fs'), path=require('node:path'), {pathToFileURL}=require('node:url');
const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const dir=path.join(path.dirname(path.dirname(process.execPath)),'relay');
const load=name=>import(pathToFileURL(path.join(dir,name+'.mjs')));
Promise.all([load('branch-observation'),load('schedule-watch')]).then(([m,s])=>{
  if(typeof m.installedCredentialRecord==='function' && s.validBranchWatch(input,true))process.stdout.write('valid');
}).catch(()=>{process.exitCode=1});
'@
    [IO.File]::WriteAllText($verifier,$validate,$utf)
    [IO.File]::WriteAllText($paramsFile,($inputGrant|ConvertTo-Json -Compress),$utf)
    if ((Get-TrialOutcome $paramsFile $condition.ToString('D')) -cne 'valid') {
        throw 'Invalid repository or ref, or installed credential reader unavailable'
    }
}
function Enter-BranchTrial {
    Assert-Protected $lockFile
    $handle = [IO.File]::Open($lockFile,'Open','ReadWrite','None')
    try {
        foreach ($file in @($journal,$policyFile,$flagFile,$node)) { Assert-Protected $file }
        $installed = Get-Content -LiteralPath $journal -Raw | ConvertFrom-Json
        if ($installed.status -cne 'installed' -or $installed.package -cne $PackageHash -or $installed.sessionSid -ne $desktopSid) {
            throw 'Installation mismatch'
        }
        foreach ($name in @($workerTask,$brokerTask)) { Assert-RegisteredTask ($folder.GetTask($name)) $installed }
        return [pscustomobject]@{lock=$handle;record=$installed}
    } catch { $handle.Dispose(); throw }
}
function Write-BaselineVerifier {
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
}
function Write-MovementVerifier {
    $source = @'
const fs = require('node:fs'), path = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const {createHash} = require('node:crypto');
const [file,condition] = process.argv.slice(2);
const input = JSON.parse(fs.readFileSync(path.join(__dirname,'parameters.json'),'utf8'));
const digest = value => createHash('sha256').update(value).digest('hex');
const db = new DatabaseSync(file,{readOnly:true});
function outcome() {
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON');
  if (input.check === 'unused') {
    const used = db.prepare('SELECT condition FROM schedule_watches WHERE condition=? UNION ALL SELECT condition FROM file_samples WHERE condition=? LIMIT 1').get(condition,condition);
    return used ? 'used' : 'unused';
  }
  const g = input.grant;
  if (input.check !== 'movement' || g.condition !== condition) return 'invalid';
  // The installed schema binds the recipient and resource in the grant revision.
  const revision = digest(JSON.stringify([g.condition,g.target,g.provider,g.scope,g.endpoint,g.ref,g.credential,g.expiresAt]));
  const row = db.prepare('SELECT w.revision,w.state,w.cursor,w.batch IS NOT NULL AS hasBatch,w.handle IS NOT NULL AS hasHandle,s.condition AS sample,s.baseline FROM schedule_watches w LEFT JOIN file_samples s USING(condition) WHERE w.condition=?').get(condition);
  if (!row || row.revision !== revision) return 'invalid';
  const clear = !row.hasBatch && !row.hasHandle;
  if (row.state === 'issued' && row.sample === null && row.cursor === null && clear) return 'waiting';
  if (row.sample !== condition) return 'invalid';
  if (row.state === 'waiting' && row.cursor === -1 && clear && row.baseline === null) return 'waiting';
  if (row.baseline !== digest(input.revision)) return 'invalid';
  if (row.state === 'waiting' && row.cursor === -1 && clear) return 'armed';
  if (row.state === 'delivered' && row.cursor === 0 && clear) return 'proved';
  if (row.state === 'ready' && row.cursor === -1 && clear) return 'pending';
  if (row.state === 'dispatching' && row.cursor === -1 && row.hasBatch && !row.hasHandle) return 'pending';
  if (row.state === 'observing' && row.cursor === 0 && row.hasBatch && row.hasHandle) return 'pending';
  return 'invalid';
}
try { process.stdout.write(outcome()); } finally { db.close(); }
'@
    [IO.File]::WriteAllText($verifier,$source,$utf)
}
function Wait-BranchMovement($db,[DateTimeOffset]$deadline) {
    $armed = $false
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        $result = Get-TrialOutcome $db $condition.ToString('D')
        if ([DateTimeOffset]::UtcNow -ge $deadline) { break }
        if ($result -ceq 'armed') {
            if (!$armed) { Write-Host 'Private branch baseline matched. The separate writer can now advance the watched branch.' }
            $armed = $true
        } elseif ($armed -and $result -ceq 'proved') {
            return
        } elseif (!(($armed -and $result -ceq 'pending') -or (!$armed -and $result -ceq 'waiting'))) {
            throw 'Private movement did not follow the expected baseline and delivery sequence'
        }
        Start-Sleep -Milliseconds 500
    }
    throw 'Private branch movement delivery unproved before grant expiry'
}
function Publish-TrialFile([string]$destination,[string]$staging,[byte[]]$bytes) {
    $stream = [IO.File]::Open($staging,'CreateNew','Write','None')
    try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    [IO.File]::Move($staging,$destination)
}
function Restore-PrivateBranchTrial {
    Assert-Protected $trial
    Assert-Protected $recovery
    if ((Get-Item -LiteralPath $recovery).Length -gt 16384) { throw 'Oversize private trial record' }
    $plan = [IO.File]::ReadAllText($recovery) | ConvertFrom-Json
    if ($plan.v -notin @(1,2) -or $plan.package -cne $PackageHash -or $plan.condition -cne $condition.ToString('D') -or
        $plan.member -cnotmatch '^[a-f0-9]{64}-[a-f0-9]{64}\.bin$') { throw 'Private trial identity mismatch' }
    $grantPolicy = $plan.policy | ConvertFrom-Json
    if ($grantPolicy.v -ne 6 -or $grantPolicy.branches.Count -ne 1 -or $grantPolicy.branches[0].condition -cne $plan.condition) {
        throw 'Invalid private trial grant'
    }
    foreach ($item in [IO.Directory]::EnumerateFileSystemEntries($trial)) {
        if ($item -notin @($paramsFile,$verifier,$recovery)) { throw 'Unexpected trial artifact' }
        Assert-Protected $item
    }
    $member = Join-Path $store $plan.member
    $credentialStage = $null
    $profileStage = $null
    if ($plan.v -eq 2) {
        if ($plan.staging -cne ('branch-'+$condition.ToString('N')+'.pending')) { throw 'Unrecognized trial staging name' }
        $credentialStage = Join-Path $store $plan.staging
        $profileStage = Join-Path $root $plan.staging
        if (Test-Path -LiteralPath $profileStage) {
            Assert-Protected $profileStage
            if (![IO.File]::Exists($profileStage) -or (Test-Path -LiteralPath $gitFile)) { throw 'Unexpected staged Git profile' }
        }
    }
    if (Test-Path -LiteralPath $store) {
        Assert-Protected $store
        foreach ($item in [IO.Directory]::EnumerateFileSystemEntries($store)) {
            if ($item -cne $member -and $item -cne $credentialStage) { throw 'Unrelated credential present' }
            Assert-Protected $item
            if ($item -ceq $credentialStage -and (![IO.File]::Exists($item) -or (Test-Path -LiteralPath $member))) { throw 'Unexpected staged credential' }
            if ($item -ceq $member -and (Get-FileHash -LiteralPath $item).Hash -ine $plan.member.Substring(65,64)) { throw 'Credential record changed' }
        }
    }
    $currentPolicy = [IO.File]::ReadAllText($policyFile)
    $currentFlag = [IO.File]::ReadAllText($flagFile)
    if ($currentPolicy -cnotin @($empty,$plan.policy) -or $currentFlag -cnotin @($on,$off)) { throw 'Watcher authority changed' }
    if (Test-Path -LiteralPath $gitFile) {
        Assert-Protected $gitFile
        if ([IO.File]::ReadAllText($gitFile) -cne $plan.profile) { throw 'Git profile changed' }
    }
    if ($currentPolicy -cne $empty) { Set-ApprovedText $policyFile $plan.policy $empty }
    if ($currentFlag -ceq $on) { Set-ApprovedText $flagFile $on $off }
    Restart-TrialBroker 'reports_only'
    [IO.File]::Delete($gitFile)
    if ($profileStage) { [IO.File]::Delete($profileStage) }
    if ([IO.Directory]::Exists($store)) {
        if ($credentialStage) { [IO.File]::Delete($credentialStage) }
        [IO.File]::Delete($member)
        [IO.Directory]::Delete($store,$false)
    }
    foreach ($file in @($verifier,$paramsFile,$recovery)) { [IO.File]::Delete($file) }
    [IO.Directory]::Delete($trial,$false)
}
if ($MyInvocation.InvocationName -eq '.') { return }
$condition = if ($RecoverTrial) { $RecoverTrial } elseif ($movement) { $MovementCondition } else { [guid]::NewGuid() }
. (Join-Path $PSScriptRoot 'Test-InstalledCodexWatcher.ps1') -Stage Run -TrialId $condition -ExpectedPackage $PackageHash
$fixtureTarget = if ($movement) { $MovementTarget } else { [guid]::NewGuid() }
$scheduler = New-Object -ComObject Schedule.Service
$scheduler.Connect()
$folder = $scheduler.GetFolder('\')
$policyFile = Join-Path $root 'completion-policy.json'
$flagFile = Join-Path $root 'completion-worker.json'
$gitFile = Join-Path $root 'completion-git.json'
$node = Join-Path $root 'runtime/node.exe'
$lockFile = Join-Path $root 'watcher-install.lock'
$trial = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) ('RelayBranchTrial-'+$condition.ToString('N'))
$verifier = Join-Path $trial 'verify.cjs'
$paramsFile = Join-Path $trial 'parameters.json'
$recovery = Join-Path $trial 'recovery.json'
$empty = '{"v":1,"grants":[]}'
$off = '{"v":1,"enabled":false}'
$on = '{"v":1,"enabled":true}'
$git = @{v=1;edition=$Edition;imageHash=$ImageHash;transportHash=$TransportHash} | ConvertTo-Json -Compress
$utf = [Text.UTF8Encoding]::new($false)
$created = $false
$profileCreated = $false
$recorded = $false
$credential = $null
$store = Join-Path $root 'branch-credentials'
$db = Join-Path $root 'completion-state/jobs.sqlite'
$policyChanged = $false
$flagChanged = $false
$verified = Enter-BranchTrial
$lock = $verified.lock
$record = $verified.record
if ($RecoverTrial) {
    try {
        foreach ($script in @($PSCommandPath,(Join-Path $PSScriptRoot 'Test-InstalledCodexWatcher.ps1'),
            (Join-Path $PSScriptRoot 'Install-CompletionWatcher.ps1'))) { Assert-Protected $script }
        Restore-PrivateBranchTrial
    } finally { $lock.Dispose() }
    'Recovered private branch trial in reports-only mode.'
    return
}
try {
    if ([IO.File]::ReadAllText($flagFile) -cne $off -or [IO.File]::ReadAllText($policyFile) -cne $empty -or
        [IO.File]::Exists($gitFile)) { throw 'Trial requires idle policy and an unused Git profile' }
    New-AccessDirectory $trial ''
    $created = $true
    if ($ReaderUser) {
        # The trial must never replace an enrolled record or share its directory.
        if (Test-Path -LiteralPath $store) { throw 'Private trial needs an unused credential directory' }
        $staging = 'branch-'+$condition.ToString('N')+'.pending'
        $profileStage = Join-Path $root $staging
        if (Test-Path -LiteralPath $profileStage) { throw 'Private trial needs an unused staging name' }
        foreach ($script in @($PSCommandPath,(Join-Path $PSScriptRoot 'Test-InstalledCodexWatcher.ps1'),
            (Join-Path $PSScriptRoot 'Install-CompletionWatcher.ps1'))) { Assert-Protected $script }
        if ($Endpoint.OriginalString -cne $Endpoint.AbsoluteUri) { throw 'Use the exact canonical repository URL' }
        $credential = [guid]::NewGuid().ToString('D')
        $inputGrant = @{condition=$condition.ToString('D');target=$fixtureTarget.ToString('D');provider='codex';scope='thread-branch-change';
            endpoint=$Endpoint.AbsoluteUri;ref=$Ref;credential=$credential;expiresAt=[DateTime]::UtcNow.AddMinutes(1).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')}
        Assert-PrivateBranchSupport $inputGrant
        if ($movement) {
            Assert-PlainPath $db
            Write-MovementVerifier
            [IO.File]::WriteAllText($paramsFile,'{"check":"unused"}',$utf)
            if ((Get-TrialOutcome $db $condition.ToString('D')) -cne 'unused') { throw 'Movement requires an unused condition ID' }
        }
        $brokerSid = [Security.Principal.SecurityIdentifier]::new($record.brokerSid).Value
        $tuple = ConvertTo-Json -InputObject @('branch-basic-v1',$credential,$Endpoint.AbsoluteUri,$Ref) -Compress
        $sha = [Security.Cryptography.SHA256]::Create()
        try {
            $binding = $sha.ComputeHash($utf.GetBytes($tuple))
            $secret = Read-Host ('Read-only credential for '+$Endpoint.AbsoluteUri+' '+$Ref) -AsSecureString
            try { $sealed = Protect-TrialReader $secret $ReaderUser $binding } finally { $secret.Dispose() }
            $bindingHex = [BitConverter]::ToString($binding).Replace('-','').ToLowerInvariant()
            $sealedHash = [BitConverter]::ToString($sha.ComputeHash($sealed)).Replace('-','').ToLowerInvariant()
            $leaf = $bindingHex+'-'+$sealedHash+'.bin'
        } finally { $sha.Dispose() }
    }
    # Baseline-only authority expires before the second poll. Movement allows
    # time for the intended client to subscribe and for a later ref sample.
    $seconds = if ($movement) { 300 } else { 50 }
    $expires = [DateTime]::UtcNow.AddSeconds($seconds).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    $grant = @{condition=$condition.ToString('D');target=$fixtureTarget.ToString('D');provider='codex';scope='thread-branch-change';
        endpoint=$Endpoint.AbsoluteUri;ref=$Ref;credential=$credential;expiresAt=$expires}
    $version = if ($ReaderUser) { 6 } else { 5 }
    $approved = @{v=$version;grants=@();schedules=@();files=@();branches=@($grant)} | ConvertTo-Json -Depth 4 -Compress
    if ($movement) {
        if ((Get-TrialOutcome $db $condition.ToString('D')) -cne 'unused') { throw 'Movement condition changed before publication' }
        $parameters = @{check='movement';grant=$grant;revision=$ExpectedRevision} | ConvertTo-Json -Depth 3 -Compress
        [IO.File]::WriteAllText($paramsFile,$parameters,$utf)
    } else { Write-BaselineVerifier }
    if ($ReaderUser) {
        $plan = @{v=2;package=$PackageHash;condition=$condition.ToString('D');member=$leaf;profile=$git;policy=$approved;staging=$staging}
        [IO.File]::WriteAllText($recovery,($plan|ConvertTo-Json -Compress),$utf)
        $recorded = $true
        Write-Host ('Private trial recovery ID '+$condition.ToString('D'))
        New-AccessDirectory $store "(A;OICI;GRGX;;;$brokerSid)"
        Publish-TrialFile (Join-Path $store $leaf) (Join-Path $store $staging) $sealed
        Publish-TrialFile $gitFile $profileStage ($utf.GetBytes($git))
    } else {
        $stream = [IO.File]::Open($gitFile,'CreateNew','Write','None')
        $profileCreated = $true
        try { $bytes=$utf.GetBytes($git); $stream.Write($bytes,0,$bytes.Length) } finally { $stream.Dispose() }
    }
    Assert-Protected $gitFile
    Set-ApprovedText $policyFile $empty $approved
    $policyChanged = $true
    Set-ApprovedText $flagFile $off $on
    $flagChanged = $true
    Restart-TrialBroker 'watching'
    Assert-PlainPath $db
    if ($movement) {
        Wait-BranchMovement $db ([DateTimeOffset]::Parse($expires))
    } else {
        do {
            $result = Get-TrialOutcome $db $condition.ToString('D')
            if ($result -eq 'proved') { break }
            if ($result -ne 'waiting' -or [DateTimeOffset]::UtcNow -ge [DateTimeOffset]::Parse($expires)) { throw 'Exact installed branch baseline unproved' }
            Start-Sleep -Milliseconds 500
        } while ($true)
    }
} finally {
  if ($recorded) {
    try { Restore-PrivateBranchTrial } finally { $lock.Dispose() }
  } else {
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
        try {
          if ($created) {
            foreach ($file in @($verifier,$paramsFile)) { if ([IO.File]::Exists($file)) { Assert-Protected $file; [IO.File]::Delete($file) } }
            [IO.Directory]::Delete($trial,$false)
          }
        } finally { $lock.Dispose() }
    }
  }
}
if ($movement) { 'Installed broker proved the branch-change notice in the granted thread.' }
else { 'Installed broker matched the expected branch revision with no notice.' }
