# Ordinary-desktop source qualification. Compile into the disposable runner's temporary directory.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Requires Windows.' }
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -or
    [Diagnostics.Process]::GetCurrentProcess().SessionId -le 0) { throw 'Run from ordinary interactive desktop PowerShell.' }

$compiler = Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$exe = Join-Path ([IO.Path]::GetTempPath()) ('relay-process-check-' + [guid]::NewGuid().ToString('N') + '.exe')
$sources = @(
    (Join-Path $PSScriptRoot '../../MCP-Servers/bridges/relay/CompletionChannel.cs')
    (Join-Path $PSScriptRoot 'fixtures/ProcessEndObservation.cs')
    (Join-Path $PSScriptRoot 'fixtures/ProcessLeaseTable.cs')
    (Join-Path $PSScriptRoot 'fixtures/AuthenticatedProcessAttachmentCheck.cs')
)
try {
    & $compiler /nologo /r:System.Web.Extensions.dll /main:AuthenticatedProcessAttachmentCheck "/out:$exe" @sources
    if ($LASTEXITCODE -ne 0) { throw 'Fixture compilation failed.' }
    & $exe
    if ($LASTEXITCODE -ne 0) { throw 'Authenticated process fixture failed.' }
} finally {
    if (Test-Path -LiteralPath $exe) { Remove-Item -LiteralPath $exe }
}
