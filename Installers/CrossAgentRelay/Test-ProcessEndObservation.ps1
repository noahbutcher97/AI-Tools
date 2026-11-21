# Opt-in local Windows trial. Each hidden child exits on release or its own deadline.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This trial requires Windows.' }
if (-not ('ProcessEndObservationFixture' -as [type])) {
    Add-Type -Path (Join-Path $PSScriptRoot 'fixtures/ProcessEndObservation.cs')
}

function Assert-Observation($Actual, $Expected) {
    if ($Actual -ne $Expected) { throw "Expected '$Expected', observed '$Actual'." }
    return $Actual
}

function Get-LaterSample([int]$targetId,[long]$creation) {
    $candidate = $handle = $null
    try {
        try { $candidate = [Diagnostics.Process]::GetProcessById($targetId) }
        catch {
            if ($_.Exception.GetBaseException() -is [ArgumentException]) { return 'absent' }
            throw
        }
        try { $handle = [ProcessEndObservationFixture]::Open($candidate) }
        catch {
            $cause = $_.Exception.GetBaseException()
            if ($cause -is [ComponentModel.Win32Exception] -and $cause.NativeErrorCode -in 5,87) { return 'unavailable' }
            throw
        }
        return [ProcessEndObservationFixture]::Observe($handle,$creation,0)
    } finally {
        if ($handle) { $handle.Dispose() }
        if ($candidate) { $candidate.Dispose() }
    }
}

function Test-OwnedChild([int]$ExitCode, [switch]$LoseObserver) {
    $eventName = 'Local\relay-process-end-' + [Guid]::NewGuid().ToString('N')
    $gate = [Threading.EventWaitHandle]::new($false, 'ManualReset', $eventName)
    $child = $null
    $observer = $null
    try {
        $image = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell/v1.0/powershell.exe'
        $command = "if ([Threading.EventWaitHandle]::OpenExisting('$eventName').WaitOne(15000)) { exit $ExitCode }; exit 94"
        $start = [Diagnostics.ProcessStartInfo]::new($image, "-NoLogo -NoProfile -NonInteractive -Command `"$command`"")
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $child = [Diagnostics.Process]::Start($start)

        # The launcher retains its original process handle throughout both opens.
        $expected = [ProcessEndObservationFixture]::CreationFileTime($child.SafeHandle)
        $observer = [ProcessEndObservationFixture]::Open($child)
        $first = Assert-Observation ([ProcessEndObservationFixture]::Observe($observer, $expected, 0)) 'running'
        $observer.Dispose()
        $observer = [ProcessEndObservationFixture]::Open($child)
        $reopened = Assert-Observation ([ProcessEndObservationFixture]::Observe($observer, $expected, 0)) 'running'
        if ($LoseObserver) { $observer.Dispose() }
        [void]$gate.Set()
        if (-not $child.WaitForExit(20000)) { throw 'Owned fixture child did not exit in time.' }

        if ($LoseObserver) {
            $result = Assert-Observation ([ProcessEndObservationFixture]::Observe($observer, $expected, 0)) 'unknown'
            $targetId = $child.Id
            $control = Assert-Observation $child.ExitCode $ExitCode
            $child.Dispose()
            $child = $null
            # A later sample owns neither the observer handle nor the launcher's control handle.
            $sample = Get-LaterSample $targetId $expected
            if ($sample -notin @('absent','unavailable','unknown',"exit $ExitCode")) { throw 'Unexpected later sample' }
            return [pscustomobject]@{ initial = $first; reopened = $reopened; afterLoss = $result
                controlExit = $control; laterSample = $sample }
        }
        $mismatch = Assert-Observation ([ProcessEndObservationFixture]::Observe($observer, $expected + 1, 0)) 'unknown'
        $result = Assert-Observation ([ProcessEndObservationFixture]::Observe($observer, $expected, 0)) "exit $ExitCode"
        return [pscustomobject]@{ initial = $first; reopened = $reopened; wrongToken = $mismatch; ended = $result }
    } finally {
        [void]$gate.Set()
        if ($observer) { $observer.Dispose() }
        if ($child) {
            # Also let a child that is still starting open its gate after a failed assertion.
            [void]$child.WaitForExit(20000)
            $child.Dispose()
        }
        $gate.Dispose()
    }
}

@(
    Test-OwnedChild 7
    Test-OwnedChild 259
    Test-OwnedChild 19 -LoseObserver
) | ConvertTo-Json
