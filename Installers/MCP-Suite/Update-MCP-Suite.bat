@echo off
REM Update-MCP-Suite.bat - double-click entry for refreshing already-installed
REM AI-Tools MCP bridges in a workspace.
REM
REM Behavior: pick a workspace via folder dialog -> read its .mcp.json to
REM discover which bridges are enabled -> re-run those bridges with --update
REM (cache refresh + npm install) using saved credentials. No prompts.
REM
REM For first-time setup of a workspace, use Install-MCP-Suite.bat instead.

setlocal

set "PS1_PATH=%~dp0Scripts\install.ps1"

if not exist "%PS1_PATH%" (
    echo install.ps1 not found at %PS1_PATH%
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -STA -File "%PS1_PATH%" -Update %*
exit /b %ERRORLEVEL%
