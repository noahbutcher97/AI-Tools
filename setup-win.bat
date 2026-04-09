@echo off
setlocal EnableDelayedExpansion

:: ════════════════════════════════════════════════════════════════════
:: setup-win.bat — Install Claude Code and its prerequisites on Windows.
::
:: Sibling to setup-mac.command. Does NOT install uv, Python, or any
:: unreal-mcp dependencies. Just Git, Node.js (>=18), and Claude Code.
::
:: Requirements:
::   - Windows 10 (Build 10240) or newer
::   - An internet connection
::   - Run as your NORMAL USER (double-click). Do NOT right-click >
::     "Run as administrator" -- that would install Claude Code into
::     system directories where your normal account can't manage it.
::     The script will trigger UAC only for the specific moments it
::     needs elevation (MSI installers).
::
:: Usage:
::   - Double-click this file in File Explorer, OR
::   - From cmd / PowerShell:  setup-win.bat
::
:: Re-run safe: if a step is already complete it is skipped.
:: ════════════════════════════════════════════════════════════════════

:: Store absolute path to PowerShell so it always works even after PATH
:: gets modified by winget / MSI installers mid-script.
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"

:: Preserve the original PATH so the RefreshPath subroutine can EXTEND
:: it with new registry entries rather than REPLACING it (which would
:: drop system directories added by winget).
set "ORIGINAL_PATH=%PATH%"

:: Log file lives next to the script.
set "LOGFILE=%~dp0setup-win.log"

:: Minimum Node.js major version required by Claude Code.
:: Source: `engines.node` field of @anthropic-ai/claude-code's package.json
:: (check npmjs.com or `npm view @anthropic-ai/claude-code engines`).
:: Bump this if Claude Code raises its minimum.
set NODE_MIN_MAJOR=18

:: Minimum Windows build. 10240 is Windows 10 RTM. Earlier versions
:: don't ship curl.exe, Windows Defender SmartScreen has different
:: behavior, and several of the APIs we rely on may be missing.
set WINDOWS_MIN_BUILD=10240

:: ──────────────────────────────────────────────
:: Pre-flight: log rotation
:: ──────────────────────────────────────────────
:: Rotate previous log (parity with setup-mac.command). Keeps one
:: prior run around for debugging.
if exist "!LOGFILE!" move /y "!LOGFILE!" "!LOGFILE!.prev" >nul 2>&1
echo [%DATE% %TIME%] Setup started > "!LOGFILE!"
echo [%DATE% %TIME%] User: %USERNAME% >> "!LOGFILE!"
echo [%DATE% %TIME%] Machine: %COMPUTERNAME% >> "!LOGFILE!"
echo [%DATE% %TIME%] Script: %~f0 >> "!LOGFILE!"

echo ============================================
echo  ZooKeepers - Windows Dev Environment Setup
echo ============================================
echo  Installs: Git, Node.js LTS, and Claude Code.
echo ============================================
echo.

:: ──────────────────────────────────────────────
:: Pre-flight: admin guard
:: ──────────────────────────────────────────────
:: Mirror the Mac version's non-root refusal. `net session` requires
:: admin; if it succeeds we're elevated. Running npm install -g from
:: an elevated prompt puts Claude Code under C:\Program Files\nodejs,
:: which non-admin shells can't update -- the exact opposite of what
:: you want for a dev tool you'll invoke from your normal terminal.
net session >nul 2>&1
if !errorlevel! equ 0 (
    echo ERROR: Do NOT run this script as Administrator.
    echo.
    echo Running 'npm install -g' from an elevated prompt installs
    echo Claude Code into system directories. Your normal user account
    echo will then be unable to update or uninstall it, and UAC will
    echo trip every time you run 'claude'.
    echo.
    echo Please close this terminal and double-click setup-win.bat as
    echo your normal user. Do NOT right-click ^> Run as administrator.
    echo The script will trigger UAC itself for the specific moments
    echo that actually need it ^(MSI installers^).
    echo.
    echo [%DATE% %TIME%] FATAL: running as admin >> "!LOGFILE!"
    pause
    exit /b 1
)

:: ──────────────────────────────────────────────
:: Pre-flight: Windows version check
:: ──────────────────────────────────────────────
set "WIN_BUILD="
for /f %%v in ('"!PS!" -NoProfile -Command "[System.Environment]::OSVersion.Version.Build" 2^>nul') do set "WIN_BUILD=%%v"
if defined WIN_BUILD (
    if !WIN_BUILD! lss !WINDOWS_MIN_BUILD! (
        echo ERROR: Windows 10 or newer required.
        echo    Detected build: !WIN_BUILD!
        echo    Minimum:        !WINDOWS_MIN_BUILD! ^(Windows 10 RTM^)
        echo [%DATE% %TIME%] FATAL: Windows too old ^(!WIN_BUILD!^) >> "!LOGFILE!"
        pause
        exit /b 1
    )
    echo [%DATE% %TIME%] Windows build: !WIN_BUILD! >> "!LOGFILE!"
) else (
    echo WARNING: Could not determine Windows version. Continuing anyway.
    echo [%DATE% %TIME%] WARN: Windows version unknown >> "!LOGFILE!"
)

:: ──────────────────────────────────────────────
:: Pre-flight: strip Mark-of-the-Web from self
:: ──────────────────────────────────────────────
:: Parity with the Mac version's com.apple.quarantine stripping.
:: Windows marks downloaded files with a "Zone.Identifier" alternate
:: data stream; Unblock-File removes it so re-runs don't re-prompt
:: SmartScreen. Best-effort -- no error if already unblocked.
"!PS!" -NoProfile -ExecutionPolicy Bypass -Command "try { Unblock-File -Path '%~f0' -ErrorAction SilentlyContinue } catch {}" 2>nul

:: ──────────────────────────────────────────────
:: Pre-flight: connectivity check
:: ──────────────────────────────────────────────
echo Checking internet connectivity...
curl -fsSL --max-time 5 --retry 2 --retry-delay 1 -o nul https://nodejs.org >nul 2>&1
if !errorlevel! equ 0 (
    echo    Connected.
    echo [%DATE% %TIME%] Internet OK >> "!LOGFILE!"
) else (
    echo    WARNING: Could not reach nodejs.org. Continuing anyway.
    echo [%DATE% %TIME%] WARN: connectivity check failed >> "!LOGFILE!"
)
echo.

:: ──────────────────────────────────────────────
:: Pre-flight: PowerShell execution policy
:: ──────────────────────────────────────────────
:: Some of our fallback download paths use PowerShell's Invoke-RestMethod
:: to talk to GitHub's releases API. If the user's execution policy is
:: Undefined or Restricted, those calls error out. Fix it up-front at
:: CurrentUser scope (no admin required).
"!PS!" -ExecutionPolicy ByPass -NoProfile -Command ^
    "try { " ^
    "  $pol = Get-ExecutionPolicy -Scope CurrentUser; " ^
    "  if ($pol -eq 'Undefined' -or $pol -eq 'Restricted') { " ^
    "    Set-ExecutionPolicy RemoteSigned -Scope CurrentUser -Force; " ^
    "    Write-Host '   Set PowerShell execution policy to RemoteSigned (CurrentUser).' " ^
    "  } else { " ^
    "    Write-Host \"   PowerShell execution policy OK ($pol).\" " ^
    "  } " ^
    "} catch { Write-Host '   Could not check execution policy (non-fatal).' }"
echo.

:: ══════════════════════════════════════════════
:: Step 1 — Git
:: ══════════════════════════════════════════════
call :RefreshPath
where git >nul 2>&1
if !errorlevel! equ 0 (
    for /f "tokens=*" %%v in ('git --version') do echo [1/4] %%v already installed.
    echo [%DATE% %TIME%] Git already installed >> "!LOGFILE!"
    goto :GitDone
)

echo [1/4] Installing Git...
echo [%DATE% %TIME%] Installing Git >> "!LOGFILE!"
set GIT_INSTALLED=0

:: Try winget first (no admin required -- installs per-user)
where winget >nul 2>&1
if !errorlevel! equ 0 (
    echo    Using winget...
    winget install Git.Git --accept-package-agreements --accept-source-agreements
    if !errorlevel! equ 0 (
        set GIT_INSTALLED=1
        echo [%DATE% %TIME%] Git winget install succeeded >> "!LOGFILE!"
    )
)

:: Fallback: direct download of the official installer, with retries
if !GIT_INSTALLED! equ 0 (
    echo    Downloading Git installer directly...
    echo    This may take a minute. You may see a UAC prompt.
    "!PS!" -ExecutionPolicy ByPass -NoProfile -Command ^
        "$ErrorActionPreference = 'Stop'; " ^
        "try { " ^
        "  $rel = $null; $i = 0; " ^
        "  while (-not $rel -and $i -lt 3) { " ^
        "    try { $rel = Invoke-RestMethod 'https://api.github.com/repos/git-for-windows/git/releases/latest' } " ^
        "    catch { $i++; if ($i -lt 3) { Start-Sleep -Seconds 2 } else { throw } } " ^
        "  } " ^
        "  $asset = $rel.assets | Where-Object { $_.name -like '*64-bit.exe' -and $_.name -notlike '*portable*' } | Select-Object -First 1; " ^
        "  if (-not $asset) { throw 'No 64-bit installer asset found in latest release' } " ^
        "  $installer = Join-Path $env:TEMP 'git-installer.exe'; " ^
        "  Write-Host \"   Downloading $($asset.name)...\"; " ^
        "  & curl.exe -fL --retry 3 --retry-delay 2 -o $installer $asset.browser_download_url; " ^
        "  if ($LASTEXITCODE -ne 0) { throw 'curl download failed' } " ^
        "  Write-Host '   Running installer...'; " ^
        "  Start-Process $installer -ArgumentList '/VERYSILENT','/NORESTART' -Wait; " ^
        "  Remove-Item $installer -ErrorAction SilentlyContinue; " ^
        "} catch { Write-Host \"   ERROR: $($_.Exception.Message)\"; exit 1 }"
    if !errorlevel! equ 0 (
        set GIT_INSTALLED=1
        echo [%DATE% %TIME%] Git direct install succeeded >> "!LOGFILE!"
    )
)

if !GIT_INSTALLED! equ 0 (
    echo.
    echo    ERROR: Could not install Git automatically.
    echo    Please install manually from https://git-scm.com/downloads/win
    echo    Then re-run setup-win.bat
    echo [%DATE% %TIME%] FATAL: Git install failed >> "!LOGFILE!"
    pause
    exit /b 1
)

call :RefreshPath
where git >nul 2>&1
if !errorlevel! neq 0 (
    echo.
    echo    Git installed, but Windows needs a new terminal to see it.
    echo    Please CLOSE this window, open a new one, and re-run setup-win.bat
    echo [%DATE% %TIME%] Git needs terminal restart >> "!LOGFILE!"
    pause
    exit /b 75
)
echo    Done.
echo [%DATE% %TIME%] Git install verified >> "!LOGFILE!"
:GitDone

:: ══════════════════════════════════════════════
:: Step 2 — Node.js (>= NODE_MIN_MAJOR)
:: ══════════════════════════════════════════════
call :RefreshPath

:: Parse current Node version (if any) into NODE_MAJOR
set "NODE_VERSION="
set "NODE_MAJOR="
for /f "tokens=*" %%v in ('node -v 2^>nul') do set "NODE_VERSION=%%v"
if defined NODE_VERSION (
    set "NODE_VER_NUM=!NODE_VERSION:v=!"
    for /f "tokens=1 delims=." %%m in ("!NODE_VER_NUM!") do set "NODE_MAJOR=%%m"
)

:: Already-installed-and-new-enough branch
if defined NODE_MAJOR if !NODE_MAJOR! geq !NODE_MIN_MAJOR! (
    echo [2/4] Node.js !NODE_VERSION! already installed ^(^>= !NODE_MIN_MAJOR!^).
    echo [%DATE% %TIME%] Node !NODE_VERSION! already installed >> "!LOGFILE!"
    goto :NodeDone
)

:: Installed-but-too-old branch: refuse to silently overwrite a Node
:: that the user installed for another project. Mirrors the Mac policy.
if defined NODE_MAJOR (
    echo [2/4] Node.js !NODE_VERSION! is too old -- Claude Code needs Node !NODE_MIN_MAJOR!+.
    echo.
    echo    Your existing Node.js was probably installed for another project.
    echo    This script will NOT silently overwrite it. Please upgrade or
    echo    uninstall it first, then re-run this script.
    echo.
    echo    Common ways to upgrade:
    echo      - winget:      winget upgrade OpenJS.NodeJS.LTS
    echo      - nvm-windows: nvm install lts ^&^& nvm use lts
    echo      - Direct MSI:  https://nodejs.org/
    echo.
    echo [%DATE% %TIME%] FATAL: Node !NODE_VERSION! too old ^(need ^>= !NODE_MIN_MAJOR!^) >> "!LOGFILE!"
    pause
    exit /b 1
)

:: Not-installed branch: install it
echo [2/4] Installing Node.js LTS...
echo [%DATE% %TIME%] Installing Node.js >> "!LOGFILE!"
set NODE_INSTALLED=0

:: Try winget first
where winget >nul 2>&1
if !errorlevel! equ 0 (
    echo    Using winget...
    winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    if !errorlevel! equ 0 (
        set NODE_INSTALLED=1
        echo [%DATE% %TIME%] Node winget install succeeded >> "!LOGFILE!"
    ) else (
        echo    winget failed, trying direct MSI download...
        echo [%DATE% %TIME%] winget failed, falling back to MSI >> "!LOGFILE!"
    )
)

:: Fallback: direct MSI download with SHA-256 verification
if !NODE_INSTALLED! equ 0 (
    echo    Downloading Node.js LTS MSI...
    echo    This may take a minute. You may see a UAC prompt.
    echo [%DATE% %TIME%] Downloading Node MSI >> "!LOGFILE!"
    "!PS!" -ExecutionPolicy ByPass -NoProfile -Command ^
        "$ErrorActionPreference = 'Stop'; " ^
        "try { " ^
        "  $rel = $null; $i = 0; " ^
        "  while (-not $rel -and $i -lt 3) { " ^
        "    try { $rel = Invoke-RestMethod 'https://nodejs.org/dist/index.json' } " ^
        "    catch { $i++; if ($i -lt 3) { Start-Sleep -Seconds 2 } else { throw } } " ^
        "  } " ^
        "  $lts = $rel | Where-Object { $_.lts } | Select-Object -First 1; " ^
        "  if (-not $lts) { throw 'No LTS release found in Node manifest' } " ^
        "  $ver = $lts.version; " ^
        "  $msi = \"node-$ver-x64.msi\"; " ^
        "  $url = \"https://nodejs.org/dist/$ver/$msi\"; " ^
        "  $dest = Join-Path $env:TEMP $msi; " ^
        "  $shaFile = Join-Path $env:TEMP 'node-SHASUMS256.txt'; " ^
        "  Write-Host \"   Latest LTS is $ver\"; " ^
        "  Write-Host \"   Downloading $msi...\"; " ^
        "  & curl.exe -fL --retry 3 --retry-delay 2 -o $dest $url; " ^
        "  if ($LASTEXITCODE -ne 0) { throw 'curl download failed' } " ^
        "  Write-Host '   Verifying SHA-256 checksum...'; " ^
        "  & curl.exe -fsSL --retry 3 --retry-delay 2 -o $shaFile \"https://nodejs.org/dist/$ver/SHASUMS256.txt\"; " ^
        "  if ($LASTEXITCODE -ne 0) { throw 'checksum fetch failed' } " ^
        "  $match = Select-String -Path $shaFile -Pattern ([regex]::Escape($msi)) | Select-Object -First 1; " ^
        "  if (-not $match) { throw \"No checksum found for $msi in SHASUMS256.txt\" } " ^
        "  $expected = ($match.Line -split '\s+')[0]; " ^
        "  $actual = (Get-FileHash -Path $dest -Algorithm SHA256).Hash; " ^
        "  if ($expected -ne $actual) { throw \"Checksum MISMATCH: expected $expected, got $actual\" } " ^
        "  Write-Host '   Checksum OK.'; " ^
        "  Write-Host '   Running installer...'; " ^
        "  Start-Process msiexec.exe -ArgumentList '/i',$dest,'/passive','/norestart' -Wait; " ^
        "  Remove-Item $dest -ErrorAction SilentlyContinue; " ^
        "  Remove-Item $shaFile -ErrorAction SilentlyContinue; " ^
        "  Write-Host '   Installer finished.'; " ^
        "} catch { Write-Host \"   ERROR: $($_.Exception.Message)\"; exit 1 }"
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
    echo      3. Run the installer ^(accept defaults^)
    echo      4. Close this window and re-run setup-win.bat
    echo.
    echo [%DATE% %TIME%] FATAL: Node install failed >> "!LOGFILE!"
    pause
    exit /b 1
)

call :RefreshPath
where node >nul 2>&1
if !errorlevel! neq 0 (
    echo.
    echo    Node.js installed, but Windows needs a new terminal to see it.
    echo    Please CLOSE this window, open a new one, and re-run setup-win.bat
    echo [%DATE% %TIME%] Node needs terminal restart >> "!LOGFILE!"
    pause
    exit /b 75
)

:: Re-verify version after install
set "NODE_VERSION="
for /f "tokens=*" %%v in ('node -v 2^>nul') do set "NODE_VERSION=%%v"
echo    Done -- Node.js !NODE_VERSION!.
echo [%DATE% %TIME%] Node !NODE_VERSION! install verified >> "!LOGFILE!"
:NodeDone

:: ══════════════════════════════════════════════
:: Step 3 — Claude Code (via npm)
:: ══════════════════════════════════════════════
call :RefreshPath
where npm >nul 2>&1
if !errorlevel! neq 0 (
    where npm.cmd >nul 2>&1
    if !errorlevel! neq 0 (
        echo ERROR: npm not found even though Node.js is installed.
        echo Try closing this window, opening a new one, and re-running setup-win.bat
        echo [%DATE% %TIME%] FATAL: npm not found >> "!LOGFILE!"
        pause
        exit /b 1
    )
)

where claude >nul 2>&1
if !errorlevel! equ 0 (
    echo [3/4] Claude Code already installed.
    echo [%DATE% %TIME%] Claude already installed >> "!LOGFILE!"
    goto :ClaudeDone
)

echo [3/4] Installing Claude Code...
echo    This may take a minute...
echo [%DATE% %TIME%] Installing Claude Code >> "!LOGFILE!"
:: stdout goes to the terminal so the user sees progress (avoids the
:: "is it frozen?" feeling); stderr is appended to the log so errors
:: can still be sent to us for debugging. Matches the pattern in the
:: original setup-mcp.bat.
call npm install -g @anthropic-ai/claude-code 2>>"!LOGFILE!"
if !errorlevel! neq 0 (
    echo.
    echo    ERROR: 'npm install -g @anthropic-ai/claude-code' failed.
    echo.
    echo    If you saw a permission / EPERM / EACCES error, Node's
    echo    global packages directory isn't writable by your user.
    echo    The directory depends on how Node was installed:
    echo      - winget:      %%LOCALAPPDATA%%\..\Programs\nodejs\node_modules
    echo      - MSI:         C:\Program Files\nodejs\node_modules  ^(admin-only^)
    echo      - nvm-windows: %%APPDATA%%\nvm\v^<ver^>\node_modules
    echo.
    echo    Two ways to fix:
    echo      1. Reinstall Node via winget ^(installs per-user^), then re-run:
    echo           winget install OpenJS.NodeJS.LTS
    echo      2. Configure a user-writable npm prefix:
    echo           mkdir "%%APPDATA%%\npm-global"
    echo           npm config set prefix "%%APPDATA%%\npm-global"
    echo           ^(then add %%APPDATA%%\npm-global to your PATH^)
    echo.
    echo    Full npm output is in setup-win.log.
    echo [%DATE% %TIME%] FATAL: npm install claude-code failed >> "!LOGFILE!"
    pause
    exit /b 1
)

:: Make sure claude is on PATH for future runs too (not just this shell)
call :RefreshPath
where claude >nul 2>&1
if !errorlevel! neq 0 (
    echo    Claude Code installed. Adding to your PATH...
    :: Clear any stale value so an empty for-loop iteration (npm broken)
    :: doesn't leave us checking a leftover path from earlier.
    set "NPM_PREFIX="
    for /f "tokens=*" %%p in ('npm config get prefix') do set "NPM_PREFIX=%%p"
    if exist "!NPM_PREFIX!\claude.cmd" (
        set "PATH=!NPM_PREFIX!;!PATH!"
        echo [%DATE% %TIME%] npm prefix: !NPM_PREFIX! >> "!LOGFILE!"
        :: Persist in user PATH so new terminals find it
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
        echo    WARNING: Installed but could not find claude.cmd at !NPM_PREFIX!
        echo    You may need to close and reopen your terminal.
        echo [%DATE% %TIME%] WARN: claude.cmd not found at !NPM_PREFIX! >> "!LOGFILE!"
    )
)
echo    Done.
echo [%DATE% %TIME%] Claude Code install complete >> "!LOGFILE!"
:ClaudeDone

:: ══════════════════════════════════════════════
:: Step 4 — Verify
:: ══════════════════════════════════════════════
echo.
echo [4/4] Verifying...
echo [%DATE% %TIME%] Running verification >> "!LOGFILE!"
set SETUP_OK=1
set NEEDS_RESTART=0

:: Git
where git >nul 2>&1
if !errorlevel! neq 0 (
    echo    [FAIL] Git not found
    echo [%DATE% %TIME%] VERIFY FAIL: git >> "!LOGFILE!"
    set SETUP_OK=0
) else (
    for /f "tokens=*" %%v in ('git --version') do (
        echo    [OK]   %%v
        echo [%DATE% %TIME%] VERIFY OK: %%v >> "!LOGFILE!"
    )
)

:: Node
where node >nul 2>&1
if !errorlevel! neq 0 (
    echo    [FAIL] Node.js not found
    echo [%DATE% %TIME%] VERIFY FAIL: node >> "!LOGFILE!"
    set SETUP_OK=0
) else (
    for /f "tokens=*" %%v in ('node --version') do (
        echo    [OK]   Node.js %%v
        echo [%DATE% %TIME%] VERIFY OK: Node.js %%v >> "!LOGFILE!"
    )
)

:: npm
where npm >nul 2>&1
if !errorlevel! neq 0 (
    where npm.cmd >nul 2>&1
)
if !errorlevel! neq 0 (
    echo    [FAIL] npm not found
    echo [%DATE% %TIME%] VERIFY FAIL: npm >> "!LOGFILE!"
    set SETUP_OK=0
) else (
    for /f "tokens=*" %%v in ('npm --version 2^>nul') do (
        echo    [OK]   npm %%v
        echo [%DATE% %TIME%] VERIFY OK: npm %%v >> "!LOGFILE!"
    )
)

:: Claude Code (actually launch it, not just check presence)
where claude >nul 2>&1
if !errorlevel! neq 0 (
    :: Might be installed at the npm prefix but not on this shell's PATH
    :: yet. Use a flag variable instead of nested if-inside-for, so the
    :: zero-iteration case (npm broken or silent) still produces output.
    set "NPM_PREFIX="
    for /f "tokens=*" %%p in ('npm config get prefix 2^>nul') do set "NPM_PREFIX=%%p"
    set "CLAUDE_AT_PREFIX=0"
    if defined NPM_PREFIX (
        if exist "!NPM_PREFIX!\claude.cmd" set "CLAUDE_AT_PREFIX=1"
    )
    if "!CLAUDE_AT_PREFIX!"=="1" (
        echo    [WARN] Claude Code installed at !NPM_PREFIX! but needs terminal restart
        echo [%DATE% %TIME%] VERIFY WARN: claude needs PATH restart >> "!LOGFILE!"
        set NEEDS_RESTART=1
    ) else (
        echo    [FAIL] Claude Code not found
        echo [%DATE% %TIME%] VERIFY FAIL: claude >> "!LOGFILE!"
        set SETUP_OK=0
    )
) else (
    :: `call claude --version` actually launches the binary.
    :: This catches "installed but broken" modes that `where claude` would miss.
    call claude --version >nul 2>&1
    if !errorlevel! equ 0 (
        for /f "tokens=*" %%v in ('claude --version 2^>nul') do (
            echo    [OK]   Claude Code %%v
            echo [%DATE% %TIME%] VERIFY OK: Claude Code %%v >> "!LOGFILE!"
        )
    ) else (
        echo    [FAIL] Claude Code installed but 'claude --version' failed to launch
        echo [%DATE% %TIME%] VERIFY FAIL: claude --version crashed >> "!LOGFILE!"
        set SETUP_OK=0
    )
)

echo.
echo [%DATE% %TIME%] Setup finished ^(OK=!SETUP_OK! RESTART=!NEEDS_RESTART!^) >> "!LOGFILE!"

if "!SETUP_OK!"=="0" (
    echo ============================================
    echo  Setup had errors. See messages above.
    echo  Log saved to: setup-win.log
    echo  Previous run: setup-win.log.prev ^(if any^)
    echo ============================================
    echo.
    pause
    exit /b 1
)

if "!NEEDS_RESTART!"=="1" (
    echo ============================================
    echo  Almost done! Close this terminal, open a
    echo  new one, and double-click setup-win.bat
    echo  one more time to verify everything works.
    echo ============================================
    echo.
    echo  Log saved to: setup-win.log
    echo.
    pause
    exit /b 75
)

echo ============================================
echo  Setup complete! All checks passed.
echo ============================================
echo.
echo  What to do now:
echo   1. In this terminal, type:  claude
echo      ^(first time will ask you to log in^)
echo.
echo  If 'claude' isn't found, close this terminal,
echo  open a new one, and try again.
echo.
echo  Log saved to: setup-win.log
echo.
pause
exit /b 0

:: ══════════════════════════════════════════════
:: Subroutine: Refresh PATH from the user registry
:: ══════════════════════════════════════════════
:: winget and MSI installers update the user PATH in the registry but
:: the currently-running cmd.exe process has already captured its
:: environment at launch. This subroutine re-reads HKCU\Environment\Path
:: and APPENDS it to ORIGINAL_PATH (preserving system directories that
:: would be lost if we simply replaced PATH with the user-scope value).
:RefreshPath
set "REG_PATH="
for /f "tokens=2*" %%A in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "REG_PATH=%%B"
if defined REG_PATH (
    set "PATH=!ORIGINAL_PATH!;!REG_PATH!"
)
goto :eof
