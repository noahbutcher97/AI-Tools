@echo off
REM ============================================================
REM  Fix Context Menu - Reinstall + Restart Explorer
REM ============================================================

echo Removing old entries...
reg delete "HKCU\Software\Classes\Directory\shell\FlattenUEProject" /f 2>nul
reg delete "HKCU\Software\Classes\Directory\Background\shell\FlattenUEProject" /f 2>nul

echo.
echo Adding context menu for right-clicking ON a folder...
reg add "HKCU\Software\Classes\directory\shell\FlattenUEProject" /ve /d "Flatten UE Project" /f
reg add "HKCU\Software\Classes\directory\shell\FlattenUEProject" /v "Icon" /d "shell32.dll,171" /f
reg add "HKCU\Software\Classes\directory\shell\FlattenUEProject\command" /ve /d "powershell.exe -ExecutionPolicy Bypass -NoProfile -File \"D:\DevTools\Flatten-UEProject\Flatten-UEProject.ps1\" -ProjectPath \"%%V\"" /f

echo.
echo Adding context menu for right-clicking INSIDE a folder...
reg add "HKCU\Software\Classes\directory\Background\shell\FlattenUEProject" /ve /d "Flatten UE Project" /f
reg add "HKCU\Software\Classes\directory\Background\shell\FlattenUEProject" /v "Icon" /d "shell32.dll,171" /f
reg add "HKCU\Software\Classes\directory\Background\shell\FlattenUEProject\command" /ve /d "powershell.exe -ExecutionPolicy Bypass -NoProfile -File \"D:\DevTools\Flatten-UEProject\Flatten-UEProject.ps1\" -ProjectPath \"%%V\"" /f

echo.
echo Restarting Explorer...
taskkill /f /im explorer.exe
timeout /t 2 /nobreak >nul
start explorer.exe

echo.
echo Done! Try right-clicking a folder now (use "Show more options" on Win11).
pause
