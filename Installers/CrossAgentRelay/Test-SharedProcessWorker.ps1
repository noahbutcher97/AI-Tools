# Opt-in ordinary desktop fixture. The worker can only observe children it starts here.
[CmdletBinding()]
param([switch]$Worker)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Requires Windows.' }
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -or
    [Diagnostics.Process]::GetCurrentProcess().SessionId -le 0) { throw 'Run from ordinary interactive desktop PowerShell.' }
$image = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell/v1.0/powershell.exe'

function Start-HiddenFixture($arguments,[switch]$WithInput) {
    $start = [Diagnostics.ProcessStartInfo]::new($image,$arguments)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $WithInput
    $start.RedirectStandardOutput = $true
    return [Diagnostics.Process]::Start($start)
}

function Attach-FixtureChild([int]$exitCode) {
    $name = 'Local\relay-fixture-' + [guid]::NewGuid().ToString('N')
    $gate = [Threading.EventWaitHandle]::new($false,'ManualReset',$name)
    $command = "if ([Threading.EventWaitHandle]::OpenExisting('$name').WaitOne(20000)) { [Console]::WriteLine('ending $exitCode'); exit $exitCode }; exit 94"
    $child = $output = $null
    $attachment = [guid]::NewGuid()
    try {
        $child = Start-HiddenFixture ('-NoLogo -NoProfile -NonInteractive -Command "'+$command+'"')
        $script:started++
        $creation = [ProcessEndObservationFixture]::CreationFileTime($child.SafeHandle).ToString([CultureInfo]::InvariantCulture)
        $grants[$attachment] = @{pid=$child.Id;creation=$creation}
        if ($leases.Attach($attachment,$child,$creation,30000) -cne 'attached' -or
            $leases.Sample($attachment) -cne 'running') { throw 'Creation binding failed.' }
        $output = $child.StandardOutput
        $eof = $output.ReadToEndAsync()
        return @{id=$child.Id; gate=$gate; attachment=$attachment; code=$exitCode; output=$output; eof=$eof}
    } catch {
        [void]$gate.Set()
        $grants.Remove($attachment)
        $leases.Revoke($attachment)
        if ($child -and !$child.WaitForExit(6000)) { throw 'Failed attachment did not release its child.' }
        if ($output) { $output.Dispose() }
        $gate.Dispose()
        throw
    } finally {
        if ($child) { $child.Dispose() } # Drop the launcher handle even on successful attachment.
    }
}

function Close-Observer($child) {
    $grants.Remove($child.attachment)
    $leases.Revoke($child.attachment)
}

function Confirm-FixtureExit($child) {
    # The child's inherited stdout stays open until exit. Check its release ACK and EOF.
    if (!$child.eof.Wait(6000) -or $child.eof.Result.TrimEnd() -cne "ending $($child.code)") { throw 'Missing child completion.' }
}

function Observe-Fixture($child) {
    return $leases.Sample($child.attachment)
}

function Invoke-FixtureWorker {
    Add-Type -Path @((Join-Path $PSScriptRoot 'fixtures/ProcessEndObservation.cs'),(Join-Path $PSScriptRoot 'fixtures/ProcessLeaseTable.cs'))
    $script:started = 0
    $grants = @{}
    $leases = [ProcessLeaseTable]::new({
        param($attachment,$processId,$creation)
        $grant = $grants[$attachment]
        return $null -ne $grant -and $grant.pid -eq $processId -and $grant.creation -ceq $creation
    })
    $children = @()
    $inputReader = [IO.StreamReader]::new([Console]::OpenStandardInput())
    try {
        $children += Attach-FixtureChild 7
        $children += Attach-FixtureChild 19
        [Console]::WriteLine("ready $($children[0].id) $($children[1].id)")
        while ($true) {
            $request = $inputReader.ReadLineAsync()
            if (!$request.Wait(8000)) { throw 'Fixture controller timed out.' }
            switch -CaseSensitive ($request.Result) {
                'health' {
                    $live = @($children | Where-Object { (Observe-Fixture $_) -ceq 'running' }).Count
                    [Console]::WriteLine("healthy $live")
                }
                'revoke-second' {
                    if ((Observe-Fixture $children[1]) -cne 'running') { throw 'Second attachment was not live.' }
                    Close-Observer $children[1]
                    [Console]::WriteLine((Observe-Fixture $children[1]))
                }
                'end-first' {
                    [void]$children[0].gate.Set()
                    Confirm-FixtureExit $children[0]
                    $wait = [Diagnostics.Stopwatch]::StartNew()
                    do {
                        $receipt = Observe-Fixture $children[0]
                        if ($receipt -cne 'running') { break }
                        Start-Sleep -Milliseconds 10
                    } while ($wait.ElapsedMilliseconds -lt 2000)
                    [Console]::WriteLine($receipt)
                }
                'end-revoked' {
                    if ($grants.ContainsKey($children[1].attachment)) { throw 'Expected revocation.' }
                    [void]$children[1].gate.Set()
                    Confirm-FixtureExit $children[1]
                    [Console]::WriteLine((Observe-Fixture $children[1]))
                }
                'stop' { return }
                'fixture-failure' { throw 'Expected fixture failure.' }
                default { throw 'Unknown fixture request.' }
            }
        }
    } finally {
        $acknowledged = 0
        foreach ($child in $children) { [void]$child.gate.Set(); Close-Observer $child }
        $leases.Dispose()
        foreach ($child in $children) {
            try { Confirm-FixtureExit $child; $acknowledged++ }
            catch { continue }
            finally { $child.output.Dispose(); $child.gate.Dispose() }
        }
        $inputReader.Dispose()
        [Console]::WriteLine("cleanup children=$started acknowledged=$acknowledged opened=$($leases.Opened) closed=$($leases.Closed)")
        if ($acknowledged -ne $children.Count) { throw 'Missing fixture acknowledgment during cleanup.' }
    }
}

function Expect-Reply($client,[string]$expected,[int]$timeout) {
    $read = $client.StandardOutput.ReadLineAsync()
    if (!$read.Wait($timeout) -or $read.Result -cne $expected) { throw "Missing fixture response '$expected'." }
}

function Test-ProcessPresent([int]$targetId) {
    try { $target = [Diagnostics.Process]::GetProcessById($targetId) }
    catch {
        if ($_.Exception.GetBaseException() -is [ArgumentException]) { return $false }
        throw
    }
    $target.Dispose()
    return $true
}

function Confirm-ChildrenGone($ids) {
    # Require the PID to disappear. Rapid reuse can make this control inconclusive.
    $deadline = [datetime]::UtcNow.AddSeconds(6)
    foreach ($targetId in $ids) {
        while (Test-ProcessPresent $targetId) {
            if ([datetime]::UtcNow -ge $deadline) { throw 'A fixture child is still present after shutdown.' }
            Start-Sleep -Milliseconds 100
        }
    }
    return $ids.Count
}

function Test-Worker([string]$scenario) {
    $client = Start-HiddenFixture ('-NoLogo -NoProfile -NonInteractive -File "'+$PSCommandPath+'" -Worker') -WithInput
    try {
        $ready = $client.StandardOutput.ReadLineAsync()
        if (!$ready.Wait(10000) -or $ready.Result -cnotmatch '^ready ([1-9][0-9]{0,9}) ([1-9][0-9]{0,9})$') { throw 'Missing fixture child identities.' }
        $ids = @([int]$Matches[1],[int]$Matches[2])
        if ($ids[0] -eq $ids[1] -or !(Test-ProcessPresent $ids[0]) -or !(Test-ProcessPresent $ids[1])) { throw 'Expected two live fixture children.' }
        $health = [Diagnostics.Stopwatch]::StartNew()
        $client.StandardInput.WriteLine('health')
        Expect-Reply $client 'healthy 2' 2000
        $health.Stop()
        if ($health.ElapsedMilliseconds -gt 2000) { throw 'Worker health request exceeded its deadline.' }
        if ($scenario -ceq 'revoke') {
            $client.StandardInput.WriteLine('revoke-second')
            Expect-Reply $client 'unknown' 2000
            $client.StandardInput.WriteLine('health')
            Expect-Reply $client 'healthy 1' 2000
            $client.StandardInput.WriteLine('end-first')
            Expect-Reply $client 'exit 7' 8000
            $client.StandardInput.WriteLine('end-revoked')
            Expect-Reply $client 'unknown' 8000
        }
        $expected = 0
        if ($scenario -ceq 'failure') { $client.StandardInput.WriteLine('fixture-failure'); $expected = 17 }
        else { $client.StandardInput.WriteLine('stop') }
        Expect-Reply $client 'cleanup children=2 acknowledged=2 opened=2 closed=2' 10000
        if (!$client.WaitForExit(5000) -or $client.ExitCode -ne $expected) { throw 'Unexpected worker exit.' }
        $gone = Confirm-ChildrenGone $ids
        [pscustomobject]@{scenario=$scenario; healthMs=$health.ElapsedMilliseconds; childrenAcknowledged=2
            childrenGone=$gone; handlesClosed=2; workerExit=$client.ExitCode}
    } finally {
        $client.StandardInput.Close()
        if (!$client.WaitForExit(10000)) { $client.Kill(); [void]$client.WaitForExit(3000) }
        $client.Dispose()
    }
}

if ($Worker) {
    try { Invoke-FixtureWorker }
    catch { if ($_.Exception.Message -ceq 'Expected fixture failure.') { exit 17 }; throw }
} else {
    @('revoke','shutdown','failure') | ForEach-Object { Test-Worker $_ } | ConvertTo-Json
}
