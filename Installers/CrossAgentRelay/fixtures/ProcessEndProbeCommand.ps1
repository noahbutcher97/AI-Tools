# Both controllers bind the parameters to a live fixture before registering the action.
function New-ProcessEndProbeCommand {
    param(
        [Security.Principal.SecurityIdentifier]$ExpectedSid,
        [ValidateRange(1,2147483647)][int]$TargetId,
        [ValidateRange(1,9223372036854775807)][long]$CreationTime
    )
    $source = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'ProcessEndObservation.cs') -Raw
    $probe = @'
$ErrorActionPreference = 'Stop'
try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if ($identity.User.Value -ne 'EXPECTED_SID' -or
        ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 2 }
    Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('SOURCE_BYTES')))
    $self = [Diagnostics.Process]::GetCurrentProcess()
    $own = [ProcessEndObservationFixture]::Open($self)
    try {
        if ([ProcessEndObservationFixture]::Observe($own, $self.StartTime.ToUniversalTime().ToFileTimeUtc(), 0) -ne 'running') { exit 3 }
    } finally { $own.Dispose(); $self.Dispose() }
    $target = [Diagnostics.Process]::GetProcessById(TARGET_PID)
    try {
        try { $other = [ProcessEndObservationFixture]::Open($target) }
        catch {
            $cause = $_.Exception.GetBaseException()
            if ($cause -is [ComponentModel.Win32Exception] -and $cause.NativeErrorCode -eq 5) { exit 42 }
            throw
        }
        try {
            if ([ProcessEndObservationFixture]::Observe($other, TARGET_TIME, 0) -eq 'running') { exit 43 }
        } finally { $other.Dispose() }
    } finally { $target.Dispose() }
} catch { exit 4 }
exit 5
'@
    $probe = $probe.Replace('SOURCE_BYTES', [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($source)))
    $probe = $probe.Replace('EXPECTED_SID', $ExpectedSid.Value)
    $probe = $probe.Replace('TARGET_PID', [string]$TargetId).Replace('TARGET_TIME', [string]$CreationTime + 'L')
    return [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($probe))
}
