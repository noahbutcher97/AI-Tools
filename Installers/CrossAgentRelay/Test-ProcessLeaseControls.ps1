# Synthetic Windows check, including on non-interactive CI. Only locally launched children are eligible.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Requires Windows.' }
Add-Type -Path @((Join-Path $PSScriptRoot 'fixtures/ProcessEndObservation.cs'),(Join-Path $PSScriptRoot 'fixtures/ProcessLeaseTable.cs'))
function Expect($actual,$expected) {
    if ($actual -cne $expected) { throw "Expected $expected, observed $actual." }
}

$name = 'Local\relay-lease-fixture-' + [guid]::NewGuid().ToString('N')
$gate = [Threading.EventWaitHandle]::new($false,'ManualReset',$name)
$children = @()
$grants = @{}
$table = [ProcessLeaseTable]::new({
    param($attachment,$candidateId,$creation)
    $grant = $grants[$attachment]
    if (!$grant -or $grant.pid -ne $candidateId -or $grant.creation -cne $creation) { return $false }
    $grant.checks++
    if ($grant.cancelBeforeOpen) { $table.Revoke($attachment) }
    if ($grant.pauseAfterOpen -and $grant.checks -eq 2) {
        $timer = [Diagnostics.Stopwatch]::StartNew()
        while ($table.Closed -lt $grant.expectedCloses -and $timer.ElapsedMilliseconds -lt 2000) { Start-Sleep -Milliseconds 20 }
        $grant.expiredDuringPause = $table.Closed -eq $grant.expectedCloses
    }
    return !$grant.once -or $grant.checks -eq 1
})
function New-Grant($child,$creation,[switch]$Once) {
    $id = [guid]::NewGuid()
    $grants[$id] = @{pid=$child.Id;creation=$creation;checks=0;once=$Once.IsPresent}
    return $id
}

try {
    foreach ($counter in 1,2) {
        $image = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell/v1.0/powershell.exe'
        $command = "[void][Threading.EventWaitHandle]::OpenExisting('$name').WaitOne(20000)"
        $info = [Diagnostics.ProcessStartInfo]::new($image,('-NoProfile -NonInteractive -Command "'+$command+'"'))
        $info.UseShellExecute = $false
        $info.CreateNoWindow = $true
        $children += [Diagnostics.Process]::Start($info)
    }
    $child = $children[0]
    $tick = [ProcessEndObservationFixture]::CreationFileTime($child.SafeHandle)
    $creation = $tick.ToString([CultureInfo]::InvariantCulture)
    foreach ($bad in @($null,'','0','01','+1','-1','1.0','1e4',' 1',"1`n",'18446744073709551616')) {
        Expect ([ProcessLeaseTable]::ValidCreation($bad)) $false
        Expect ($table.Attach([guid]::NewGuid(),$child,$bad,1000)) 'invalid'
    }
    Expect ([ProcessLeaseTable]::ValidCreation('18446744073709551615')) $true
    $first = New-Grant $child $creation
    Expect ($table.Attach([guid]::NewGuid(),$child,$creation,1000)) 'denied'
    Expect ($table.Attach($first,$children[1],$creation,1000)) 'denied'
    foreach ($ms in @(0,30001)) { Expect ($table.Attach($first,$child,$creation,$ms)) 'invalid' }
    $cancelled = New-Grant $child $creation
    $grants[$cancelled].cancelBeforeOpen = $true
    Expect ($table.Attach($cancelled,$child,$creation,1000)) 'unknown'
    Expect ($table.Attach($cancelled,$child,$creation,1000)) 'duplicate'
    Expect $table.Attempts 0

    # A granted token for a different instance is discovered only after a limited open.
    $adjacent = $tick+1
    if ([double]$adjacent -ne [double]$tick) { $adjacent = $tick-1 }
    Expect ([double]$adjacent -eq [double]$tick) $true
    $other = $adjacent.ToString([CultureInfo]::InvariantCulture)
    $stale = New-Grant $child $other
    Expect ($table.Attach($stale,$child,$other,1000)) 'unknown'
    Expect ($table.Sample($stale)) 'unknown'
    $lost = New-Grant $child $creation -Once
    Expect ($table.Attach($lost,$child,$creation,1000)) 'unknown'
    Expect ($table.Sample($lost)) 'unknown'
    Expect $table.Opened 2
    Expect $table.Closed 2

    Expect ($table.Attach($first,$child,$creation,30000)) 'attached'
    Expect ($table.Attach($first,$child,$creation,30000)) 'duplicate'
    $secondToken = [ProcessEndObservationFixture]::CreationFileTime($children[1].SafeHandle).ToString([CultureInfo]::InvariantCulture)
    $second = New-Grant $children[1] $secondToken
    Expect ($table.Attach($second,$children[1],$secondToken,30000)) 'attached'
    $short = New-Grant $child $creation
    Expect ($table.Attach($short,$child,$creation,100)) 'full'
    Expect $table.Attempts 4
    Expect ($table.Sample($first)) 'running'
    Expect ($table.Sample($second)) 'running'
    $table.Revoke($first)
    $table.Revoke($first)
    Expect ($table.Sample($first)) 'unknown'
    Expect ($table.Attach($first,$child,$creation,30000)) 'duplicate'
    Expect $table.Closed 3
    Expect ($table.Attach($short,$child,$creation,100)) 'attached'
    # No sampling or expiry calls. The counter alone cannot expire an attachment.
    $wait = [Diagnostics.Stopwatch]::StartNew()
    while ($table.Closed -eq 3 -and $wait.ElapsedMilliseconds -lt 2000) { Start-Sleep -Milliseconds 20 }
    Expect $table.Closed 4
    Expect ($table.Sample($short)) 'unknown'
    Expect ($table.Attach($short,$child,$creation,30000)) 'duplicate'
    Expect ($table.Sample($second)) 'running'
    $table.Revoke($second)
    $peer = New-Grant $child $creation
    Expect ($table.Attach($peer,$child,$creation,500)) 'attached'
    $paused = New-Grant $children[1] $secondToken
    $grants[$paused].pauseAfterOpen = $true
    $grants[$paused].expectedCloses = 7
    Expect ($table.Attach($paused,$children[1],$secondToken,500)) 'unknown'
    Expect $grants[$paused].expiredDuringPause $true
    Expect ($table.Sample($peer)) 'unknown'
    Expect ($table.Sample($paused)) 'unknown'
    $last = New-Grant $child $creation
    Expect ($table.Attach($last,$child,$creation,30000)) 'attached'
    $table.Dispose()
    $table.Dispose()
    $table.Revoke($last)
    Expect ($table.Sample($last)) 'unknown'
    Expect ($table.Attach([guid]::NewGuid(),$child,$creation,1000)) 'unavailable'
    Expect $table.Attempts 8
    Expect $table.Opened 8
    Expect $table.Closed 8
    'Binding, authorization, capacity, revocation and lease expiry during idle input and a paused guard passed. Eight limited opens, eight closes.'
} finally {
    $table.Dispose()
    [void]$gate.Set()
    $finished = 0
    foreach ($child in $children) {
        try { if ($child.WaitForExit(6000) -and $child.ExitCode -eq 0) { $finished++ } }
        finally { $child.Dispose() }
    }
    $gate.Dispose()
    if ($finished -ne $children.Count) { throw 'Disposable child cleanup unproved.' }
}
