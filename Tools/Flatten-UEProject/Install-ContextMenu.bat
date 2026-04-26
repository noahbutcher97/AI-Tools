@echo off
REM ============================================================
REM  Install "Flatten UE Project" right-click context menu
REM  Run this as Administrator once.
REM ============================================================

set "SCRIPT_PATH=D:\DevTools\Flatten-UEProject\Flatten-UEProject.ps1"

echo Adding "Flatten UE Project" to folder right-click menu...

REM Add to folder right-click (background click inside folder)
reg add "HKCU\Software\Classes\Directory\shell\FlattenUEProject" /ve /d "Flatten UE Project" /f
reg add "HKCU\Software\Classes\Directory\shell\FlattenUEProject" /v "Icon" /d "shell32.dll,171" /f
reg add "HKCU\Software\Classes\Directory\shell\FlattenUEProject\command" /ve /d "powershell.exe -ExecutionPolicy Bypass -NoProfile -File \"%SCRIPT_PATH%\" -ProjectPath \"%%V\"" /f

REM Add to folder right-click (right-click ON folder)
reg add "HKCU\Software\Classes\Directory\Background\shell\FlattenUEProject" /ve /d "Flatten UE Project" /f
reg add "HKCU\Software\Classes\Directory\Background\shell\FlattenUEProject" /v "Icon" /d "shell32.dll,171" /f
reg add "HKCU\Software\Classes\Directory\Background\shell\FlattenUEProject\command" /ve /d "powershell.exe -ExecutionPolicy Bypass -NoProfile -File \"%SCRIPT_PATH%\" -ProjectPath \"%%V\"" /f

echo.
echo Done! You can now right-click any folder and select "Flatten UE Project".
echo.
pause
