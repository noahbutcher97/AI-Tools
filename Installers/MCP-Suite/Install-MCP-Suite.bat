@echo off
REM Install-MCP-Suite.bat - double-click entry for AI-Tools MCP bridge installer.
REM Hands off to Scripts\install.ps1 with PowerShell. Bypasses execution
REM policy for this one invocation only.

setlocal

set "PS1_PATH=%~dp0Scripts\install.ps1"

if not exist "%PS1_PATH%" (
    echo install.ps1 not found at %PS1_PATH%
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -STA -File "%PS1_PATH%" %*
exit /b %ERRORLEVEL%
