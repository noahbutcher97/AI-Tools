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
    & {
        # The ordinary fixture SID stands in for the installation's setup authority.
        $authority = $authorities
        $cleanupDir = Join-Path $dir 'cleanup'
        $saved = $cleanupDir+'.cleanup.json'
        $metadata = Join-Path $cleanupDir 'trial.json'
        $text = '{"v":1,"task":"fixture"}'
        $null = [IO.Directory]::CreateDirectory($cleanupDir)
        [IO.File]::WriteAllText($metadata,$text)
        $previous = [Environment]::CurrentDirectory
        try {
            [Environment]::CurrentDirectory = $cleanupDir
            $failed = $false
            try { Remove-CredentialTrialDirectory $cleanupDir $text } catch [IO.IOException] { $failed = $true }
            if (!$failed -or ![IO.Directory]::Exists($cleanupDir) -or [IO.File]::ReadAllText($saved) -cne $text) {
                throw 'Locked directory lost its recovery record'
            }
        } finally { [Environment]::CurrentDirectory = $previous }
        [IO.Directory]::Delete($cleanupDir,$false)
        [IO.File]::Delete($saved)

        $null = [IO.Directory]::CreateDirectory($cleanupDir)
        [IO.File]::WriteAllText($metadata,$text)
        [IO.File]::WriteAllText($saved,'preserve')
        $failed = $false
        try { Remove-CredentialTrialDirectory $cleanupDir $text } catch [IO.IOException] { $failed = $true }
        if (!$failed -or [IO.File]::ReadAllText($saved) -cne 'preserve' -or [IO.File]::ReadAllText($metadata) -cne $text) {
            throw 'Existing recovery record was replaced'
        }
        [IO.File]::Delete($saved)
        $failed = $false
        try { Remove-CredentialTrialDirectory $cleanupDir ($text.Replace('fixture','another')) } catch { $failed = $true }
        if (!$failed -or ![IO.File]::Exists($metadata) -or [IO.File]::Exists($saved)) { throw 'Unexpected trial record removed' }
        $redirected = Join-Path $dir 'redirected-cleanup'
        $null = New-Item -ItemType Junction -Path $redirected -Target $cleanupDir
        try {
            $failed = $false
            try { Remove-CredentialTrialDirectory $redirected $text } catch { $failed = $true }
            if (!$failed -or [IO.File]::ReadAllText($metadata) -cne $text -or [IO.File]::Exists($redirected+'.cleanup.json')) {
                throw 'Redirected cleanup changed the target'
            }
        } finally { [IO.Directory]::Delete($redirected,$false) }
        Remove-CredentialTrialDirectory $cleanupDir $text
        if ([IO.Directory]::Exists($cleanupDir) -or [IO.File]::Exists($saved)) { throw 'Credential trial cleanup incomplete' }
    }
}
& {
    $endpoint = 'https://'+(('fixture','invalid') -join '.')+'/fixture'
    $parameters = @{PackageHash='a'*64;ImageHash='a'*64;TransportHash='b'*64;Edition='ucrt64';
        Ref='refs/heads/fixture';ExpectedRevision='a'*40;Endpoint=$endpoint}
    . (Join-Path $PSScriptRoot '../Test-InstalledBranchRead.ps1') @parameters
    & {
        . (Join-Path $PSScriptRoot '../Test-InstalledCodexWatcher.ps1') -Stage Run -TrialId ([guid]::NewGuid()) -ExpectedPackage ('a'*64)
        $trial = Join-Path $FixtureRoot 'reader-preflight'
        $runtime = Join-Path $trial 'runtime'
        $modules = Join-Path $trial 'relay'
        $null = [IO.Directory]::CreateDirectory($runtime)
        $null = [IO.Directory]::CreateDirectory($modules)
        $node = Join-Path $runtime 'node.exe'
        [IO.File]::Copy((Get-Command node.exe -CommandType Application | Select-Object -First 1).Source,$node)
        $verifier = Join-Path $trial 'verify.cjs'
        $paramsFile = Join-Path $trial 'input.json'
        $condition = [guid]::NewGuid()
        $utf = [Text.UTF8Encoding]::new($false)
        [IO.File]::WriteAllText((Join-Path $modules 'branch-observation.mjs'),'export function installedCredentialRecord() {}')
        $moduleFile = Join-Path $modules 'schedule-watch.mjs'
        $env:NODE_OPTIONS='--require=missing-fixture-preload'
        $env:RELAY_TRIAL_CANARY='fixture'
        try {
            [IO.File]::WriteAllText($moduleFile,'export const validBranchWatch=(g,opt)=>opt===true && g.credential==="fixture" && !process.env.RELAY_TRIAL_CANARY;')
            Assert-PrivateBranchSupport @{credential='fixture'}
            [IO.File]::WriteAllText($moduleFile,'export const validBranchWatch=g=>g.credential===null;')
            $failed=$false
            try { Assert-PrivateBranchSupport @{credential='fixture'} } catch { $failed=$true }
            if (!$failed) { throw 'Old anonymous-only package accepted a credentialed preflight' }
        } finally {
            Remove-Item Env:NODE_OPTIONS,Env:RELAY_TRIAL_CANARY -ErrorAction SilentlyContinue
        }
        foreach ($options in @(@{MovementTarget=$condition},@{MovementCondition=$condition},
            @{MovementTarget=[guid]::Empty;MovementCondition=$condition;ReaderUser='fixture'},
            @{MovementTarget=$condition;MovementCondition=[guid]::NewGuid()})) {
            $failed=$false
            try { . (Join-Path $PSScriptRoot '../Test-InstalledBranchRead.ps1') @parameters @options }
            catch { $failed=$_.Exception.Message -ceq 'Private movement requires a reader, a disposable raw target and a fresh condition ID' }
            if (!$failed) { throw 'Incomplete movement binding accepted' }
        }
        $paramsFile = Join-Path $trial 'parameters.json'
        $fixtureGrant = @{condition=$condition.ToString('D');target=[guid]::NewGuid().ToString('D');provider='codex';
            scope='thread-branch-change';endpoint=$endpoint;ref=$parameters.Ref;credential=[guid]::NewGuid().ToString('D');
            expiresAt=[DateTime]::UtcNow.AddHours(1).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')}
        $inputFile=Join-Path $trial 'fixture.json'
        [IO.File]::WriteAllText($inputFile,($fixtureGrant|ConvertTo-Json -Compress),$utf)
        Write-MovementVerifier
        # Exercise the reader against rows written by the real watcher. The
        # branch sampler, transport, and subsequent receipt are local fixtures.
        $fixtureFile=Join-Path $trial 'exercise.mjs'
        $exercise=@'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL,fileURLToPath} from 'node:url';
const [moduleFile] = process.argv.slice(2);
const {scheduleWatches,scheduleTable} = await import(pathToFileURL(moduleFile));
const dir = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(dir,'movement.sqlite');
const db = new DatabaseSync(file);
const g = JSON.parse(fs.readFileSync(path.join(dir,'fixture.json'),'utf8'));
const baseline = 'a'.repeat(40);
const movement = {check:'movement',grant:g,revision:baseline};
function verify(input, condition=g.condition) {
  fs.writeFileSync(path.join(dir,'parameters.json'),JSON.stringify(input));
  const result=spawnSync(process.execPath,[path.join(dir,'verify.cjs'),file,condition],{
    cwd:dir,encoding:'utf8',windowsHide:true,timeout:5000,env:{SystemRoot:process.env.SystemRoot,NODE_NO_WARNINGS:'1'}
  });
  assert.equal(result.status,0);
  return result.stdout;
}
try {
  db.exec(scheduleTable);
  fs.mkdirSync(path.join(dir,'completion-grants'));
  let now=Date.now(), sample=baseline, delivered=false;
  const target={id:g.target,kind:'codex',addressable:true,pid:null,startedAt:null};
  const watches=scheduleWatches(db,fn=>fn(),{root:dir,policy:()=>[g],now:()=>now,sampleBranch:()=>sample,
    send:async (id,body,options)=>{
      assert.equal(id,g.target);
      options.onHandle('local-proof.'+'a'.repeat(48),target);
      return {state:'pending'};
    },status:async ()=>({state:delivered?'delivered':'pending',to:g.target})});
  assert.equal(verify({check:'unused'}),'unused');
  db.prepare('INSERT INTO file_samples(condition,next_poll) VALUES(?,0)').run(g.condition);
  assert.equal(verify({check:'unused'}),'used');
  db.prepare('DELETE FROM file_samples WHERE condition=?').run(g.condition);
  assert.equal(verify(movement),'invalid');
  watches.provision();
  assert.equal(verify({check:'unused'}),'used');
  assert.equal(verify(movement),'waiting');
  assert.equal(db.prepare('SELECT state FROM schedule_watches').get().state,'issued');
  watches.activate({id:g.condition,op:'activate_branch',event:{session:g.target}},()=>true);
  assert.equal(verify(movement),'waiting');
  await watches.pollChanges();
  assert.equal(verify(movement),'armed');
  assert.equal(verify({...movement,revision:'c'.repeat(40)}),'invalid');
  assert.equal(verify({...movement,grant:{...g,target:g.credential}}),'invalid');
  assert.equal(verify(movement,g.credential),'invalid');
  now+=60000;
  await watches.pollChanges();
  assert.equal(verify(movement),'armed');
  sample='b'.repeat(40);
  now+=60000;
  await watches.pollChanges();
  assert.equal(verify(movement),'pending');
  await watches.dispatchDue();
  assert.equal(verify(movement),'pending');
  now+=10000;
  await watches.dispatchDue();
  assert.equal(verify(movement),'pending');
  delivered=true;
  now+=10000;
  await watches.dispatchDue();
  assert.equal(verify(movement),'proved');
  db.prepare("UPDATE schedule_watches SET handle='unretired' WHERE condition=?").run(g.condition);
  assert.equal(verify(movement),'invalid');
  db.prepare("UPDATE schedule_watches SET handle=NULL WHERE condition=?").run(g.condition);
} finally {db.close();}
'@
        [IO.File]::WriteAllText($fixtureFile,$exercise,$utf)
        & $node --no-warnings $fixtureFile (Join-Path $PSScriptRoot '../../../MCP-Servers/bridges/relay/schedule-watch.mjs')
        if ($LASTEXITCODE -ne 0) { throw 'Movement verifier fixture failed' }
        $db=Join-Path $trial 'movement.sqlite'
        $failed=$false
        try { Wait-BranchMovement $db ([DateTimeOffset]::UtcNow.AddSeconds(3)) }
        catch { $failed=$_.Exception.Message -ceq 'Private movement did not follow the expected baseline and delivery sequence' }
        if (!$failed) { throw 'Premature completed watch was credited' }
        & {
            $outcomes = [Collections.Generic.Queue[string]]::new()
            foreach ($state in @('waiting','armed','armed','pending','proved')) { $outcomes.Enqueue($state) }
            $announcements = [Collections.Generic.List[string]]::new()
            function Get-TrialOutcome($file,$id) { return $outcomes.Dequeue() }
            function Start-Sleep($Milliseconds) {}
            function Write-Host($message) { $announcements.Add($message) }
            Wait-BranchMovement $db ([DateTimeOffset]::UtcNow.AddSeconds(3))
            if ($outcomes.Count -ne 0 -or $announcements.Count -ne 1 -or
                $announcements[0] -cnotlike '*Before advancing*resumed raw target is addressable*hosted ref still has the expected starting revision*') {
                throw 'Writer cue omitted an independent gate'
            }
            $expired=$false
            try { Wait-BranchMovement $db ([DateTimeOffset]::UtcNow) }
            catch { $expired=$_.Exception.Message -ceq 'Private branch movement delivery unproved before grant expiry' }
            if (!$expired) { throw 'Expired movement accepted' }
        }
    }
    $binding = [byte[]]::new(32)
    $secret = ConvertTo-SecureString 'synthetic-password' -AsPlainText -Force
    try {
        $sealed = Protect-TrialReader $secret 'fixture' $binding
        $plain = [Security.Cryptography.ProtectedData]::Unprotect($sealed,$binding,'LocalMachine')
        if ([Text.Encoding]::ASCII.GetString($plain) -cne 'fixture:synthetic-password') { throw 'Credential mismatch' }
        [Array]::Clear($plain,0,$plain.Length)
    } finally { $secret.Dispose() }
    # Installed ownership and ACLs have separate checks. Exercise recovery
    # transactions against real files with a recording restart.
    function Assert-Protected($p) { if (!(Test-Path -LiteralPath $p)) { throw 'Missing fixture artifact' } }
    function Restart-TrialBroker($mode) { if ($mode -cne 'reports_only') { throw 'Unexpected recovery mode' } }
    function Set-ApprovedText($p,$before,$after) {
        if ([IO.File]::ReadAllText($p) -cne $before) { throw 'Fixture changed' }
        [IO.File]::WriteAllText($p,$after)
    }
    $root = Join-Path $FixtureRoot 'private-recovery'
    $null = [IO.Directory]::CreateDirectory($root)
    $store = Join-Path $root 'branch-credentials'
    $trial = Join-Path $root 'trial'
    $recovery = Join-Path $trial 'recovery.json'
    $paramsFile = Join-Path $trial 'parameters.json'
    $verifier = Join-Path $trial 'verify.cjs'
    $flagFile = Join-Path $root 'worker.json'
    $policyFile = Join-Path $root 'policy.json'
    $gitFile = Join-Path $root 'git.json'
    $condition = [guid]::NewGuid()
    $empty='{"v":1,"grants":[]}'; $on='{"v":1,"enabled":true}'; $off='{"v":1,"enabled":false}'
    & {
        $lockFile=Join-Path $root 'lock'
        $journal=Join-Path $root 'journal'
        $node=Join-Path $root 'image'
        foreach ($file in @($lockFile,$flagFile,$policyFile,$node)) { [IO.File]::WriteAllText($file,'fixture') }
        $desktopSid='fixture-principal'; $workerTask='worker'; $brokerTask='broker'
        $folder=[pscustomobject]@{}
        $folder | Add-Member ScriptMethod GetTask {param($name) return $name}
        function Assert-RegisteredTask($task,$installed) {
            try { $extra=[IO.File]::Open($lockFile,'Open','ReadWrite','None') } catch [IO.IOException] { return }
            $extra.Dispose(); throw 'Task identity checked outside lock'
        }
        $installed=@{package=$PackageHash;status='installed';sessionSid=$desktopSid}
        [IO.File]::WriteAllText($journal,($installed|ConvertTo-Json))
        $verified=Enter-BranchTrial
        $verified.lock.Dispose()
        $installed.package='0'*64
        [IO.File]::WriteAllText($journal,($installed|ConvertTo-Json))
        $rejected=$false
        try { $unexpected=Enter-BranchTrial; $unexpected.lock.Dispose() } catch { $rejected=$_.Exception.Message -eq 'Installation mismatch' }
        if (!$rejected) { throw 'Stale package accepted' }
        $extra=[IO.File]::Open($lockFile,'Open','ReadWrite','None'); $extra.Dispose()
    }
    $approved = @{v=6;branches=@(@{condition=$condition.ToString('D')})}|ConvertTo-Json -Depth 3 -Compress
    $draft = Join-Path $root 'publication.pending'
    $published = Join-Path $root 'publication'
    Publish-TrialFile $published $draft ([byte[]](1,2,3))
    if (([IO.File]::ReadAllBytes($published) -join ',') -cne '1,2,3' -or [IO.File]::Exists($draft)) { throw 'Incomplete publication' }
    $denied = $false
    try { Publish-TrialFile $published $draft ([byte[]](4)) } catch [IO.IOException] { $denied = $true }
    if (!$denied -or ([IO.File]::ReadAllBytes($published) -join ',') -cne '1,2,3') { throw 'Existing publication changed' }
    foreach ($state in @('before-grant','partial-credential','partial-profile','after-activation','unrelated')) {
        $null = [IO.Directory]::CreateDirectory($trial)
        $null = [IO.Directory]::CreateDirectory($store)
        $file = Join-Path $store 'temp'
        [IO.File]::WriteAllText($file,'synthetic-ciphertext')
        $leaf = ('a'*64)+'-'+(Get-FileHash $file).Hash.ToLowerInvariant()+'.bin'
        [IO.File]::Move($file,(Join-Path $store $leaf))
        $plan = @{v=1;condition=$condition.ToString('D');package=$PackageHash;member=$leaf;profile='fixture';policy=$approved}
        [IO.File]::WriteAllText($recovery,($plan|ConvertTo-Json -Compress))
        $staging = 'branch-'+$condition.ToString('N')+'.pending'
        $profileStage = Join-Path $root $staging
        if ($state -eq 'unrelated') {
            $plan.v = 2
            $plan.staging = 'publication'
            [IO.File]::WriteAllText($recovery,($plan|ConvertTo-Json -Compress))
            $denied = $false
            try { Restore-PrivateBranchTrial } catch { $denied = $_.Exception.Message -ceq 'Unrecognized trial staging name' }
            if (!$denied -or ([IO.File]::ReadAllBytes($published) -join ',') -cne '1,2,3') { throw 'Recovery accepted an unrelated staging name' }
            $plan.staging = $staging
            [IO.File]::WriteAllText($recovery,($plan|ConvertTo-Json -Compress))
        }
        if ($state -like 'partial-*') {
            $plan.v = 2
            $plan.staging = $staging
            [IO.File]::WriteAllText($recovery,($plan|ConvertTo-Json -Compress))
            if ($state -eq 'partial-credential') {
                [IO.File]::Delete((Join-Path $store $leaf))
                [IO.File]::WriteAllBytes((Join-Path $store $staging),[byte[]](1))
            } else { [IO.File]::WriteAllBytes($profileStage,[byte[]]::new(0)) }
        }
        if ($state -in @('before-grant','partial-credential','partial-profile')) {
            [IO.File]::WriteAllText($flagFile,$off); [IO.File]::WriteAllText($policyFile,$empty)
        } else {
            [IO.File]::WriteAllText($flagFile,$on); [IO.File]::WriteAllText($policyFile,$approved)
            [IO.File]::WriteAllText($gitFile,'fixture')
        }
        if ($state -eq 'unrelated') {
            [IO.File]::WriteAllText((Join-Path $store 'other'),'preserve')
            $denied=$false
            try { Restore-PrivateBranchTrial } catch { $denied=$true }
            if (!$denied -or ![IO.File]::Exists($recovery) -or [IO.File]::ReadAllText($flagFile) -cne $on) { throw 'Foreign record changed during recovery' }
        } else {
            Restore-PrivateBranchTrial
            if ([IO.Directory]::Exists($trial) -or [IO.Directory]::Exists($store) -or [IO.File]::Exists($gitFile) -or [IO.File]::Exists($profileStage) -or
                [IO.File]::ReadAllText($flagFile) -cne $off -or [IO.File]::ReadAllText($policyFile) -cne $empty) { throw 'Incomplete private recovery' }
        }
    }
}
