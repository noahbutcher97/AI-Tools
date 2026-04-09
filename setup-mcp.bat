@echo off
setlocal EnableDelayedExpansion

:: ──────────────────────────────────────────────
:: Store full path to PowerShell so it always works
:: even after PATH gets modified by RefreshPath
:: ──────────────────────────────────────────────
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"

:: Also store original PATH so RefreshPath can extend, not replace
set "ORIGINAL_PATH=%PATH%"

echo ============================================
echo  ZooKeepers - Full Dev Environment Setup
echo ============================================
echo  Installs: Node.js, Claude Code, uv, Python,
echo  and the UnrealMCP server dependencies.
echo ============================================
echo.

:: ──────────────────────────────────────────────
:: Log file for remote debugging
:: ──────────────────────────────────────────────
set "LOGFILE=%~dp0setup-mcp.log"
echo [%DATE% %TIME%] Setup started > "!LOGFILE!"
echo [%DATE% %TIME%] User: %USERNAME% >> "!LOGFILE!"
echo [%DATE% %TIME%] Machine: %COMPUTERNAME% >> "!LOGFILE!"
echo [%DATE% %TIME%] Windows: %OS% >> "!LOGFILE!"
echo [%DATE% %TIME%] Script: %~f0 >> "!LOGFILE!"
echo.

:: ──────────────────────────────────────────────
:: Pre-flight: Internet connectivity check
:: ──────────────────────────────────────────────
echo Checking internet connectivity...
"!PS!" -ExecutionPolicy ByPass -NoProfile -Command "try { (Invoke-WebRequest -Uri 'https://nodejs.org' -UseBasicParsing -TimeoutSec 5).StatusCode | Out-Null; exit 0 } catch { exit 1 }"
if %errorlevel% neq 0 (
    echo    WARNING: Could not reach nodejs.org. Continuing anyway...
    echo [%DATE% %TIME%] WARNING: connectivity check failed >> "!LOGFILE!"
) else (
    echo    Connected.
    echo [%DATE% %TIME%] Internet OK >> "!LOGFILE!"
)
echo.

:: ──────────────────────────────────────────────
:: Pre-flight: Fix PowerShell execution policy
:: ──────────────────────────────────────────────
"!PS!" -ExecutionPolicy ByPass -NoProfile -Command ^
    "try { " ^
    "  $pol = Get-ExecutionPolicy -Scope CurrentUser; " ^
    "  if ($pol -eq 'Undefined' -or $pol -eq 'Restricted') { " ^
    "    Write-Host 'Setting PowerShell execution policy to RemoteSigned...'; " ^
    "    Set-ExecutionPolicy RemoteSigned -Scope CurrentUser -Force; " ^
    "    Write-Host '   Done.' " ^
    "  } else { " ^
    "    Write-Host \"PowerShell execution policy OK ($pol).\" " ^
    "  } " ^
    "} catch { " ^
    "  Write-Host 'Could not check execution policy (non-fatal, continuing...)' " ^
    "}"
echo.

:: ──────────────────────────────────────────────
:: Step 1 — Git (required by Claude Code for bash)
:: ──────────────────────────────────────────────
call :RefreshPath
where git >nul 2>&1
if %errorlevel% equ 0 (
    for /f "tokens=*" %%v in ('git --version') do echo [1/7] %%v already installed.
    echo [%DATE% %TIME%] Git already installed >> "!LOGFILE!"
    goto :GitDone
)

echo [1/7] Installing Git (required by Claude Code)...
echo [%DATE% %TIME%] Installing Git >> "!LOGFILE!"
set GIT_INSTALLED=0

:: Try winget first
where winget >nul 2>&1
if %errorlevel% equ 0 (
    echo    Using winget...
    winget install Git.Git --accept-package-agreements --accept-source-agreements
    if !errorlevel! equ 0 (
        set GIT_INSTALLED=1
        echo [%DATE% %TIME%] Git winget install succeeded >> "!LOGFILE!"
    )
)

:: Fallback: direct download
if !GIT_INSTALLED! equ 0 (
    echo    Downloading Git installer...
    echo    This may take a minute and you may see a UAC prompt...
    "!PS!" -ExecutionPolicy ByPass -NoProfile -Command ^
        "$ErrorActionPreference = 'Stop'; " ^
        "try { " ^
        "  $releases = Invoke-RestMethod 'https://api.github.com/repos/git-for-windows/git/releases/latest'; " ^
        "  $asset = $releases.assets | Where-Object { $_.name -like '*64-bit.exe' -and $_.name -notlike '*portable*' } | Select-Object -First 1; " ^
        "  $dl = $asset.browser_download_url; " ^
        "  $installer = \"$env:TEMP\\git-installer.exe\"; " ^
        "  Write-Host \"   Downloading $($asset.name)...\"; " ^
        "  Invoke-WebRequest -Uri $dl -OutFile $installer; " ^
        "  Write-Host '   Running installer...'; " ^
        "  Start-Process $installer -ArgumentList '/VERYSILENT', '/NORESTART' -Wait; " ^
        "  Remove-Item $installer -ErrorAction SilentlyContinue; " ^
        "  exit 0 " ^
        "} catch { " ^
        "  Write-Host \"   ERROR: $($_.Exception.Message)\"; " ^
        "  exit 1 " ^
        "}"
    if !errorlevel! equ 0 (
        set GIT_INSTALLED=1
        echo [%DATE% %TIME%] Git direct install succeeded >> "!LOGFILE!"
    )
)

if !GIT_INSTALLED! equ 0 (
    echo.
    echo    ERROR: Could not install Git automatically.
    echo    Please install manually from https://git-scm.com/downloads/win
    echo    Then re-run setup-mcp.bat
    echo [%DATE% %TIME%] FATAL: Git install failed >> "!LOGFILE!"
    pause
    exit /b 1
)

call :RefreshPath
where git >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo    Git installed! But Windows needs a new terminal to find it.
    echo    Please CLOSE this window, open a new one, and run setup-mcp.bat again.
    echo [%DATE% %TIME%] Git needs terminal restart >> "!LOGFILE!"
    pause
    exit /b 0
)
echo    Done.
echo [%DATE% %TIME%] Git install verified >> "!LOGFILE!"

:GitDone

:: ──────────────────────────────────────────────
:: Step 2 — Node.js (required for Claude Code)
:: ──────────────────────────────────────────────
call :RefreshPath
where node >nul 2>&1
if %errorlevel% equ 0 (
    for /f "tokens=*" %%v in ('node --version') do echo [2/7] Node.js %%v already installed.
    echo [%DATE% %TIME%] Node.js already installed >> "!LOGFILE!"
    goto :NodeDone
)

echo [2/7] Installing Node.js...
echo [%DATE% %TIME%] Installing Node.js... >> "!LOGFILE!"
set NODE_INSTALLED=0

:: Try winget first
where winget >nul 2>&1
if %errorlevel% equ 0 (
    echo    Using winget...
    echo [%DATE% %TIME%] Trying winget >> "!LOGFILE!"
    winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    if !errorlevel! equ 0 (
        set NODE_INSTALLED=1
        echo [%DATE% %TIME%] winget install succeeded >> "!LOGFILE!"
    ) else (
        echo    winget failed, trying direct download...
        echo [%DATE% %TIME%] winget failed, trying direct download >> "!LOGFILE!"
    )
)

:: Fallback: direct MSI download
if !NODE_INSTALLED! equ 0 (
    echo    Downloading Node.js LTS installer...
    echo    This may take a minute and you may see a UAC prompt...
    echo [%DATE% %TIME%] Downloading Node.js MSI >> "!LOGFILE!"
    "!PS!" -ExecutionPolicy ByPass -NoProfile -Command ^
        "$ErrorActionPreference = 'Stop'; " ^
        "try { " ^
        "  $releases = Invoke-RestMethod 'https://nodejs.org/dist/index.json'; " ^
        "  $ver = $releases[0].version; " ^
        "  $msi = \"node-$ver-x64.msi\"; " ^
        "  $dl = \"https://nodejs.org/dist/$ver/$msi\"; " ^
        "  Write-Host \"   Downloading $msi...\"; " ^
        "  Invoke-WebRequest -Uri $dl -OutFile \"$env:TEMP\\$msi\"; " ^
        "  Write-Host '   Running installer...'; " ^
        "  Start-Process msiexec.exe -ArgumentList '/i', \"$env:TEMP\\$msi\", '/passive', '/norestart' -Wait; " ^
        "  Remove-Item \"$env:TEMP\\$msi\" -ErrorAction SilentlyContinue; " ^
        "  Write-Host '   Installer finished.'; " ^
        "  exit 0 " ^
        "} catch { " ^
        "  Write-Host \"   ERROR: $($_.Exception.Message)\"; " ^
        "  exit 1 " ^
        "}"
    if !errorlevel! equ 0 (
        set NODE_INSTALLED=1
        echo [%DATE% %TIME%] Direct MSI install succeeded >> "!LOGFILE!"
    ) else (
        echo [%DATE% %TIME%] Direct MSI install failed >> "!LOGFILE!"
    )
)

if !NODE_INSTALLED! equ 0 (
    echo.
    echo    ERROR: Could not install Node.js automatically.
    echo.
    echo    Please install it manually:
    echo      1. Go to https://nodejs.org/
    echo      2. Download the LTS version
    echo      3. Run the installer (accept all defaults)
    echo      4. Close this window and re-run setup-mcp.bat
    echo.
    echo [%DATE% %TIME%] FATAL: Node.js install failed >> "!LOGFILE!"
    pause
    exit /b 1
)

:: Refresh PATH and verify
call :RefreshPath
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo    Node.js installed! But Windows needs a new terminal to find it.
    echo.
    echo    Please CLOSE this window, open a new one, and run setup-mcp.bat again.
    echo    It will pick up where it left off.
    echo.
    echo [%DATE% %TIME%] Node installed but needs terminal restart >> "!LOGFILE!"
    pause
    exit /b 0
)
echo    Done.
echo [%DATE% %TIME%] Node.js install verified >> "!LOGFILE!"

:NodeDone

:: ──────────────────────────────────────────────
:: Step 2 — Claude Code (via npm)
:: ──────────────────────────────────────────────

:: Make sure npm is available
where npm >nul 2>&1
if %errorlevel% neq 0 (
    where npm.cmd >nul 2>&1
    if !errorlevel! neq 0 (
        echo [3/7] ERROR: npm not found even though Node.js is installed.
        echo    Try closing this window and opening a new one, then re-run setup-mcp.bat
        echo [%DATE% %TIME%] FATAL: npm not found >> "!LOGFILE!"
        pause
        exit /b 1
    )
)

:: Check if claude is already installed
call :RefreshPath
where claude >nul 2>&1
if %errorlevel% equ 0 (
    echo [3/7] Claude Code already installed.
    echo [%DATE% %TIME%] Claude Code already installed >> "!LOGFILE!"
    goto :ClaudeDone
)

echo [3/7] Installing Claude Code...
echo    This may take a few minutes...
echo [%DATE% %TIME%] Installing Claude Code >> "!LOGFILE!"
call npm install -g @anthropic-ai/claude-code 2>>"!LOGFILE!"
if %errorlevel% neq 0 (
    echo    ERROR: npm install failed.
    echo    Try running this manually in a new terminal:
    echo      npm install -g @anthropic-ai/claude-code
    echo [%DATE% %TIME%] FATAL: npm install claude-code failed >> "!LOGFILE!"
    pause
    exit /b 1
)

:: Make sure claude is on PATH
call :RefreshPath
where claude >nul 2>&1
if %errorlevel% neq 0 (
    echo    Claude Code installed. Adding to your PATH...
    for /f "tokens=*" %%p in ('npm config get prefix') do set "NPM_PREFIX=%%p"
    if exist "!NPM_PREFIX!\claude.cmd" (
        set "PATH=!NPM_PREFIX!;!PATH!"
        echo [%DATE% %TIME%] npm prefix: !NPM_PREFIX! >> "!LOGFILE!"

        :: Add to user PATH permanently
        "!PS!" -ExecutionPolicy ByPass -NoProfile -Command ^
            "$npmPrefix = '!NPM_PREFIX!'; " ^
            "$userPath = [Environment]::GetEnvironmentVariable('PATH', 'User'); " ^
            "if ($userPath -notlike \"*$npmPrefix*\") { " ^
            "  [Environment]::SetEnvironmentVariable('PATH', \"$userPath;$npmPrefix\", 'User'); " ^
            "  Write-Host '   Added to PATH permanently.' " ^
            "} else { " ^
            "  Write-Host '   Already in PATH.' " ^
            "}"
    ) else (
        echo    WARNING: Installed but could not find claude.cmd
        echo    You may need to close and reopen your terminal.
        echo [%DATE% %TIME%] WARNING: claude.cmd not found at !NPM_PREFIX! >> "!LOGFILE!"
    )
)
echo    Done.
echo [%DATE% %TIME%] Claude Code install complete >> "!LOGFILE!"

:ClaudeDone

:: ──────────────────────────────────────────────
:: Step 3 — uv (Python package/project manager)
:: ──────────────────────────────────────────────
call :RefreshPath
where uv >nul 2>&1
if %errorlevel% equ 0 (
    echo [4/7] uv already installed.
    echo [%DATE% %TIME%] uv already installed >> "!LOGFILE!"
    goto :UvDone
)

echo [4/7] Installing uv...
echo [%DATE% %TIME%] Installing uv >> "!LOGFILE!"
"!PS!" -ExecutionPolicy ByPass -NoProfile -Command "irm https://astral.sh/uv/install.ps1 | iex"
if %errorlevel% neq 0 (
    echo    ERROR: Failed to install uv.
    echo    Try installing manually: https://docs.astral.sh/uv/getting-started/installation/
    echo [%DATE% %TIME%] FATAL: uv install failed >> "!LOGFILE!"
    pause
    exit /b 1
)
set "PATH=%USERPROFILE%\.local\bin;!PATH!"

where uv >nul 2>&1
if %errorlevel% neq 0 (
    echo    uv installed but needs a terminal restart.
    echo    Please CLOSE this window, open a new one, and re-run setup-mcp.bat
    echo [%DATE% %TIME%] uv needs terminal restart >> "!LOGFILE!"
    pause
    exit /b 0
)
echo    Done.
echo [%DATE% %TIME%] uv install verified >> "!LOGFILE!"

:UvDone

:: ──────────────────────────────────────────────
:: Step 4 — Python 3.12 (via uv, no admin needed)
:: ──────────────────────────────────────────────
echo [5/7] Ensuring Python 3.12 is available...
echo [%DATE% %TIME%] Installing Python 3.12 >> "!LOGFILE!"
uv python install 3.12
if %errorlevel% neq 0 (
    echo    ERROR: Failed to install Python 3.12.
    echo [%DATE% %TIME%] FATAL: Python install failed >> "!LOGFILE!"
    pause
    exit /b 1
)
echo    Done.
echo [%DATE% %TIME%] Python 3.12 OK >> "!LOGFILE!"

:: ──────────────────────────────────────────────
:: Step 5 — MCP server Python dependencies
:: ──────────────────────────────────────────────
echo [6/7] Setting up MCP server Python environment...
echo [%DATE% %TIME%] Installing MCP deps >> "!LOGFILE!"
uv --directory "%~dp0unreal-mcp-main\unreal-mcp-main\Python" sync --python 3.12 --link-mode=copy
if %errorlevel% neq 0 (
    echo    ERROR: Failed to install Python dependencies.
    echo [%DATE% %TIME%] FATAL: MCP deps failed >> "!LOGFILE!"
    pause
    exit /b 1
)
echo    Done.
echo [%DATE% %TIME%] MCP deps OK >> "!LOGFILE!"

:: ──────────────────────────────────────────────
:: Step 6 — Verify everything
:: ──────────────────────────────────────────────
echo [7/7] Verifying setup...
echo.
echo [%DATE% %TIME%] Running verification >> "!LOGFILE!"
set SETUP_OK=1
set WARNINGS=0

:: Check Git
where git >nul 2>&1
if %errorlevel% neq 0 (
    echo    [FAIL] Git not found
    set SETUP_OK=0
) else (
    for /f "tokens=*" %%v in ('git --version') do echo    [OK] %%v
)

:: Check Node
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo    [FAIL] Node.js not found
    echo [%DATE% %TIME%] VERIFY FAIL: node >> "!LOGFILE!"
    set SETUP_OK=0
) else (
    for /f "tokens=*" %%v in ('node --version') do (
        echo    [OK] Node.js %%v
        echo [%DATE% %TIME%] VERIFY OK: Node.js %%v >> "!LOGFILE!"
    )
)

:: Check Claude Code
where claude >nul 2>&1
if %errorlevel% neq 0 (
    for /f "tokens=*" %%p in ('npm config get prefix 2^>nul') do (
        if exist "%%p\claude.cmd" (
            echo    [WARN] Claude Code installed at %%p but needs terminal restart
            echo [%DATE% %TIME%] VERIFY WARN: claude needs PATH >> "!LOGFILE!"
            set WARNINGS=1
        ) else (
            echo    [FAIL] Claude Code not found
            echo [%DATE% %TIME%] VERIFY FAIL: claude >> "!LOGFILE!"
            set SETUP_OK=0
        )
    )
) else (
    echo    [OK] Claude Code installed
    echo [%DATE% %TIME%] VERIFY OK: claude >> "!LOGFILE!"
)

:: Check uv
where uv >nul 2>&1
if %errorlevel% neq 0 (
    echo    [FAIL] uv not found
    echo [%DATE% %TIME%] VERIFY FAIL: uv >> "!LOGFILE!"
    set SETUP_OK=0
) else (
    echo    [OK] uv installed
    echo [%DATE% %TIME%] VERIFY OK: uv >> "!LOGFILE!"
)

:: Check MCP server
uv --directory "%~dp0unreal-mcp-main\unreal-mcp-main\Python" run python -c "import mcp; print('   [OK] MCP server dependencies')" 2>nul
if %errorlevel% neq 0 (
    echo    [FAIL] MCP server dependencies
    echo [%DATE% %TIME%] VERIFY FAIL: mcp deps >> "!LOGFILE!"
    set SETUP_OK=0
) else (
    echo [%DATE% %TIME%] VERIFY OK: mcp deps >> "!LOGFILE!"
)

:: Check project files
if exist "%~dp0.mcp.json" (
    echo    [OK] .mcp.json config present
) else (
    echo    [FAIL] .mcp.json not found — re-sync from Perforce
    set SETUP_OK=0
)

if exist "%~dp0Plugins\UnrealMCP\UnrealMCP.uplugin" (
    echo    [OK] UnrealMCP plugin present
) else (
    echo    [FAIL] UnrealMCP plugin not found — re-sync from Perforce
    set SETUP_OK=0
)

echo.
echo [%DATE% %TIME%] Setup finished (OK=!SETUP_OK!, WARN=!WARNINGS!) >> "!LOGFILE!"

if "!SETUP_OK!"=="0" (
    echo ============================================
    echo  Setup had errors. See messages above.
    echo  Log saved to: setup-mcp.log
    echo  Send that file to Noah if you need help.
    echo ============================================
) else if "!WARNINGS!"=="1" (
    echo ============================================
    echo  Almost done! Close this terminal, open
    echo  a new one, and run setup-mcp.bat one more
    echo  time to verify everything works.
    echo ============================================
) else (
    echo ============================================
    echo  Setup complete! All checks passed.
    echo ============================================
    echo.
    echo  What to do now:
    echo   1. Open ZooKeepers in Unreal Editor
    echo      (the plugin builds automatically)
    echo   2. In this terminal, type: claude
    echo      (first time will ask you to log in)
    echo.
    echo  If 'claude' doesn't work, close this
    echo  terminal, open a new one, navigate here,
    echo  and try again.
)
echo.
echo  Log saved to: setup-mcp.log
echo.
pause
exit /b 0

:: ──────────────────────────────────────────────
:: Subroutine: Refresh PATH from registry
:: APPENDS registry paths to original PATH instead
:: of replacing it (preserves system directories)
:: ──────────────────────────────────────────────
:RefreshPath
set "REG_PATH="
for /f "tokens=2*" %%A in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "REG_PATH=%%B"
if defined REG_PATH (
    set "PATH=!ORIGINAL_PATH!;!REG_PATH!"
)
:: Ensure uv is available if installed this session
if exist "%USERPROFILE%\.local\bin\uv.exe" set "PATH=!PATH!;%USERPROFILE%\.local\bin"
goto :eof
