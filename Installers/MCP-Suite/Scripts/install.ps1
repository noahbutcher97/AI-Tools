# install.ps1 - GUI front-end for AI-Tools MCP bridge installer.
# Run via install.bat for double-click ease, or directly via PowerShell.
#
# Gathers workspace path via Windows Folder Browser dialog or text input,
# then hands off to install.mjs for the actual orchestration.

[CmdletBinding()]
param(
    [string]$Workspace = "",
    [switch]$Doctor,
    [switch]$Update,
    [string]$Bridges = "",
    [switch]$EnableUpdateChecks
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms

# P/Invoke for foregrounding the console window so dialogs appear on top.
if (-not ([System.Management.Automation.PSTypeName]'McpInstaller.Win32').Type) {
    Add-Type -Namespace McpInstaller -Name Win32 -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern System.IntPtr GetConsoleWindow();

[System.Runtime.InteropServices.DllImport("user32.dll")]
[return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
public static extern bool SetForegroundWindow(System.IntPtr hWnd);

[System.Runtime.InteropServices.DllImport("user32.dll")]
[return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);

[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool BringWindowToTop(System.IntPtr hWnd);
"@
}

# Locate install.mjs next to this script.
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$installScript = Join-Path $scriptDir "install.mjs"
if (-not (Test-Path $installScript)) {
    [System.Windows.Forms.MessageBox]::Show(
        "install.mjs not found at $installScript",
        "MCP Installer",
        "OK", "Error"
    ) | Out-Null
    exit 1
}

# Ensure Node.js is available; offer to install if missing.
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "Node.js was not found on PATH." -ForegroundColor Yellow
    Write-Host "The installer needs Node.js 18+ to run."
    Write-Host ""
    $choice = Read-Host "Try to install Node.js LTS automatically via winget? [Y/n]"
    if ($choice -notmatch '^(n|no)$') {
        $winget = Get-Command winget -ErrorAction SilentlyContinue
        if ($winget) {
            winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
            # Refresh PATH for this session
            $userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
            $sysPath  = [Environment]::GetEnvironmentVariable("PATH", "Machine")
            $env:PATH = "$sysPath;$userPath"
        } else {
            [System.Windows.Forms.MessageBox]::Show(
                "winget is not available. Install Node.js 18+ manually from https://nodejs.org/ and re-run this installer.",
                "MCP Installer",
                "OK", "Information"
            ) | Out-Null
            exit 1
        }
    } else {
        Write-Host "Aborted. Install Node.js manually and try again."
        exit 1
    }

    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        Write-Host ""
        Write-Host "Node.js installed but Windows hasn't picked it up. Open a new terminal and run install.bat again." -ForegroundColor Yellow
        Write-Host "Press any key to exit..."
        $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
        exit 0
    }
}

# ─── Workspace selection ──────────────────────────────────────────────
# Note: do NOT name the variable `$input` — that is a PowerShell automatic
# variable (pipeline input enumerator) and assignments to it can behave
# unexpectedly in script scope.
if (-not $Workspace) {
    Write-Host ""
    Write-Host "AI-Tools MCP Bridge Installer" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Workspace folder for this install. Two ways to enter it:"
    Write-Host "  1. Type or paste the full path, then press Enter to continue."
    Write-Host "  2. Just press Enter (leave blank) to open a GUI folder picker."
    Write-Host ""
    $userPath = Read-Host "Workspace path (or press Enter for GUI)"

    if ([string]::IsNullOrWhiteSpace($userPath)) {
        Write-Host ""
        Write-Host "Opening folder picker..." -ForegroundColor DarkGray

        # Use Shell.Application COM (native Windows folder browser).
        # Reliable from a PowerShell script — no WinForms message pump needed.
        # Flag values:
        #   0x00000040 = BIF_NEWDIALOGSTYLE (resizable, drag-drop, modern look)
        #   0x00000010 = BIF_RETURNONLYFSDIRS (only filesystem dirs)
        $BIF_NEWDIALOGSTYLE   = 0x40
        $BIF_RETURNONLYFSDIRS = 0x10

        # Pass the console window HWND as the dialog's parent and force the
        # console to the foreground first. Without this the dialog can open
        # behind other windows in the z-order and look invisible.
        $consoleHwnd = [McpInstaller.Win32]::GetConsoleWindow()
        if ($consoleHwnd -ne [System.IntPtr]::Zero) {
            [McpInstaller.Win32]::SetForegroundWindow($consoleHwnd) | Out-Null
            [McpInstaller.Win32]::BringWindowToTop($consoleHwnd) | Out-Null
        }

        $shell  = New-Object -ComObject Shell.Application
        $folder = $shell.BrowseForFolder(
            [int64]$consoleHwnd,
            "Select the project workspace folder for MCP bridges",
            ($BIF_NEWDIALOGSTYLE -bor $BIF_RETURNONLYFSDIRS)
        )

        if ($folder) {
            $Workspace = $folder.Self.Path
        } else {
            Write-Host "Cancelled."
            exit 0
        }
    } else {
        $Workspace = $userPath.Trim()
    }
}

if (-not (Test-Path $Workspace)) {
    [System.Windows.Forms.MessageBox]::Show(
        "Workspace path does not exist: $Workspace",
        "MCP Installer",
        "OK", "Error"
    ) | Out-Null
    exit 1
}

Write-Host ""
Write-Host "Workspace: $Workspace"
Write-Host ""

# Tell install.mjs that the GUI front-end already printed the title banner
# so it doesn't print a second one.
$env:MCP_INSTALLER_HEADER_SHOWN = "1"

# ─── Locate the MCP-Servers tree (sibling of Installers) ─────────────
# Layout: <ai-tools-root>/Installers/MCP-Suite/install.ps1 (this file)
#         <ai-tools-root>/MCP-Servers/<bridge-name>/...
# Walk up from this script looking for a sibling MCP-Servers/manifest.json.
function Find-McpServersRoot([string]$startDir) {
    if ($env:MCP_SERVERS_ROOT) { return $env:MCP_SERVERS_ROOT }
    $dir = $startDir
    while ($dir) {
        $candidate = Join-Path $dir "MCP-Servers"
        if (Test-Path (Join-Path $candidate "manifest.json")) { return $candidate }
        $parent = Split-Path -Parent $dir
        if ($parent -eq $dir -or -not $parent) { break }
        $dir = $parent
    }
    # Fallback: ../../MCP-Servers
    return Join-Path (Split-Path -Parent (Split-Path -Parent $startDir)) "MCP-Servers"
}

$mcpServersRoot = Find-McpServersRoot $scriptDir
if (-not (Test-Path $mcpServersRoot)) {
    [System.Windows.Forms.MessageBox]::Show(
        "MCP-Servers directory not found at: $mcpServersRoot`n`nSet MCP_SERVERS_ROOT env var or place the installer next to the MCP-Servers tree.",
        "MCP Installer",
        "OK", "Error"
    ) | Out-Null
    exit 1
}

# ─── Run npm ci for any bridge with package.json but no node_modules ──
# Bridges live under MCP-Servers/bridges/<name>/.
$bridgesRoot = Join-Path $mcpServersRoot "bridges"
if (Test-Path $bridgesRoot) {
    foreach ($bridgeDir in (Get-ChildItem $bridgesRoot -Directory)) {
        $pkgJson = Join-Path $bridgeDir.FullName "package.json"
        $nm      = Join-Path $bridgeDir.FullName "node_modules"
        if ((Test-Path $pkgJson) -and (-not (Test-Path $nm))) {
            Write-Host "[deps] Installing for $($bridgeDir.Name)..."
            Push-Location $bridgeDir.FullName
            & npm ci 2>&1 | Out-Host
            Pop-Location
        }
    }
}

# ─── Build args for install.mjs ──────────────────────────────────────
$nodeArgs = @($installScript, "--workspace=$Workspace")
if ($Doctor)             { $nodeArgs += "--doctor" }
if ($Update)             { $nodeArgs += "--update" }
if ($Bridges)            { $nodeArgs += "--bridges=$Bridges" }
if ($EnableUpdateChecks) { $nodeArgs += "--enable-update-checks" }

# ─── Hand off to Node ─────────────────────────────────────────────────
& node @nodeArgs
$exit = $LASTEXITCODE

Write-Host ""
if ($exit -eq 0) {
    Write-Host "Installer finished successfully." -ForegroundColor Green
} else {
    Write-Host "Installer exited with code $exit." -ForegroundColor Yellow
}
Write-Host ""
Write-Host "Press any key to exit..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
exit $exit
