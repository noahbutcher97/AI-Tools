@echo off
REM ============================================================
REM  Flatten UE Project - Double-click to run
REM  Place this .bat next to Flatten-UEProject.ps1
REM  Or drag-drop a UE project folder onto this .bat
REM ============================================================

set "SCRIPT_DIR=%~dp0"
set "PS_SCRIPT=%SCRIPT_DIR%Flatten-UEProject.ps1"

if "%~1"=="" (
    REM No argument - PS1 will open folder picker
    powershell -ExecutionPolicy Bypass -NoProfile -File "%PS_SCRIPT%"
) else (
    REM Argument passed (drag-drop or CLI)
    powershell -ExecutionPolicy Bypass -NoProfile -File "%PS_SCRIPT%" -ProjectPath "%~1"
)

echo.
pause
