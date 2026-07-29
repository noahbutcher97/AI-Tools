[CmdletBinding(DefaultParameterSetName = "Transition")]
param(
    [Parameter(ParameterSetName = "Transition")]
    [string]$Uri = "http://127.0.0.1:47651/v1/migration/transition",

    [Parameter(ParameterSetName = "Transition")]
    [string]$ExpectedMode,

    [Parameter(ParameterSetName = "Transition")]
    [string]$NextMode,

    [Parameter(ParameterSetName = "Transition")]
    [string]$EvidenceHash,

    [Parameter(ParameterSetName = "Transition")]
    [string]$BearerTokenFile,

    [Parameter(ParameterSetName = "SelfTest", Mandatory)]
    [switch]$SelfTest,

    [Parameter(ParameterSetName = "Probe", Mandatory)]
    [switch]$ProbeOnly,

    [ValidateRange(1, 60000)]
    [int]$TimeoutMilliseconds = 5000
)

$ErrorActionPreference = "Stop"
$mutexName = "Global\OperationPhoenixCoordinatorMigrationV1"
$mutex = $null
$mutexAcquired = $false
$scriptExitCode = 0
$bearerToken = $null
$authenticatedRequestStarted = $false

function Test-MigrationMode {
    param([string]$Mode)

    return @(
        "legacy-active",
        "shadow-observe",
        "cutover-prepared",
        "unified-active",
        "rollback-prepared"
    ) -ccontains $Mode
}

try {
    $createdNew = $false
    $mutex = [System.Threading.Mutex]::new(
        $false,
        $mutexName,
        [ref]$createdNew
    )
    try {
        $mutexAcquired = $mutex.WaitOne($TimeoutMilliseconds)
    }
    catch [System.Threading.AbandonedMutexException] {
        $mutexAcquired = $true
    }
    if (-not $mutexAcquired) {
        throw "Timed out acquiring migration mutex $mutexName."
    }

    if ($ProbeOnly) {
        [ordered]@{
            mutexName = $mutexName
            acquired = $true
        } | ConvertTo-Json -Compress
    }
    elseif ($SelfTest) {
        $processInfo = [System.Diagnostics.ProcessStartInfo]::new()
        $processInfo.FileName = (Get-Process -Id $PID).Path
        $processInfo.UseShellExecute = $false
        $processInfo.CreateNoWindow = $true
        $processInfo.RedirectStandardOutput = $true
        $processInfo.RedirectStandardError = $true
        foreach ($argument in @(
            "-NoProfile",
            "-File",
            $PSCommandPath,
            "-ProbeOnly",
            "-TimeoutMilliseconds",
            "250"
        )) {
            [void]$processInfo.ArgumentList.Add($argument)
        }
        $secondCaller = [System.Diagnostics.Process]::Start($processInfo)
        if (-not $secondCaller.WaitForExit($TimeoutMilliseconds + 5000)) {
            $secondCaller.Kill($true)
            throw "Concurrent migration mutex probe did not terminate."
        }
        $secondOutput = $secondCaller.StandardOutput.ReadToEnd()
        $secondError = $secondCaller.StandardError.ReadToEnd()
        $secondRejected = $secondCaller.ExitCode -ne 0
        if (-not $secondRejected) {
            throw "Concurrent migration mutex probe unexpectedly acquired ownership."
        }
        [ordered]@{
            mutexName = $mutexName
            ownerAcquired = $true
            secondCallerRejected = $secondRejected
            secondCallerExitCode = $secondCaller.ExitCode
            secondCallerOutput = $secondOutput.Trim()
            secondCallerError = $secondError.Trim()
        } | ConvertTo-Json -Compress
    }
    else {
        if (-not (Test-MigrationMode $ExpectedMode)) {
            throw "ExpectedMode is not a registered migration mode."
        }
        if (-not (Test-MigrationMode $NextMode)) {
            throw "NextMode is not a registered migration mode."
        }
        if ($EvidenceHash -cnotmatch "^[a-f0-9]{64}$") {
            throw "EvidenceHash must be a lower-case SHA-256 digest."
        }
        if ($BearerTokenFile) {
            $tokenItem = Get-Item -LiteralPath $BearerTokenFile -Force
            if ($tokenItem.PSIsContainer) {
                throw "BearerTokenFile must identify a regular file."
            }
            if (
                $tokenItem.Length -lt 1 -or
                $tokenItem.Length -gt 4096
            ) {
                throw "Bearer token file must contain at most 4096 bytes."
            }
            $bearerToken = [System.IO.File]::ReadAllText(
                $tokenItem.FullName
            ).Trim()
        }
        else {
            $bearerToken = $env:CODEX_COORDINATOR_BEARER_TOKEN
        }
        if (
            [string]::IsNullOrWhiteSpace($bearerToken) -or
            $bearerToken -cnotmatch "^[A-Za-z0-9._~-]{32,4096}$"
        ) {
            throw "A valid coordinator bearer token is required."
        }
        $transitionUri = [System.Uri]$Uri
        if (
            -not $transitionUri.IsLoopback -or
            $transitionUri.Scheme -ne "http"
        ) {
            throw "Migration transition URI must be an HTTP loopback endpoint."
        }
        $request = [ordered]@{
            expectedMode = $ExpectedMode
            nextMode = $NextMode
            evidenceHash = $EvidenceHash
        } | ConvertTo-Json -Compress
        $timeoutSeconds = [Math]::Max(
            1,
            [Math]::Ceiling($TimeoutMilliseconds / 1000.0)
        )
        $authenticatedRequestStarted = $true
        $response = Invoke-RestMethod `
            -Method Post `
            -Uri $transitionUri `
            -Headers @{
                Authorization = "Bearer $bearerToken"
            } `
            -ContentType "application/json" `
            -Body $request `
            -MaximumRedirection 0 `
            -Debug:$false `
            -Verbose:$false `
            -TimeoutSec $timeoutSeconds
        if (
            $response -isnot [System.Management.Automation.PSCustomObject] -or
            $response.priorMode -isnot [string] -or
            $response.mode -isnot [string] -or
            $response.evidenceHash -isnot [string]
        ) {
            throw "Migration transition response schema is invalid."
        }
        if (
            $response.priorMode -cne $ExpectedMode -or
            $response.mode -cne $NextMode -or
            $response.evidenceHash -cne $EvidenceHash
        ) {
            throw "Migration transition response reported boundary drift."
        }
        [ordered]@{
            priorMode = $response.priorMode
            mode = $response.mode
            evidenceHash = $response.evidenceHash
        } | ConvertTo-Json -Compress
    }
}
catch {
    if ($authenticatedRequestStarted) {
        Write-Error `
            -Message "Coordinator migration request failed or returned invalid state." `
            -ErrorAction Continue
    }
    else {
        Write-Error -ErrorRecord $_ -ErrorAction Continue
    }
    $scriptExitCode = 2
}
finally {
    if ($mutexAcquired -and $null -ne $mutex) {
        $mutex.ReleaseMutex()
    }
    if ($null -ne $mutex) {
        $mutex.Dispose()
    }
    $bearerToken = $null
}

exit $scriptExitCode
