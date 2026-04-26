@echo off
REM ============================================================
REM  Remove "Flatten UE Project" right-click context menu
REM ============================================================

echo Removing "Flatten UE Project" from context menu...

reg delete "HKCU\Software\Classes\Directory\shell\FlattenUEProject" /f 2>nul
reg delete "HKCU\Software\Classes\Directory\Background\shell\FlattenUEProject" /f 2>nul

echo.
echo Done! Context menu entry removed.
echo.
pause
