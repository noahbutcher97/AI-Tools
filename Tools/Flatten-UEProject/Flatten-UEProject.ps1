#Requires -Version 5.1
<#
.SYNOPSIS
    Flattens an Unreal Engine project's Source/, Config/, and Plugin source files
    into a single flat zip in your Downloads folder.

.PARAMETER ProjectPath
    Path to the UE project root (contains .uproject file).
    If omitted, a folder picker dialog will open.
#>

param(
    [string]$ProjectPath,
    [switch]$IncludePlugins
)

# --- Helper: Folder picker dialog ---
function Select-FolderDialog {
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = "Select your Unreal Engine project folder (contains .uproject)"
    $dialog.ShowNewFolderButton = $false
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        return $dialog.SelectedPath
    }
    return $null
}
# --- Resolve project path ---
if (-not $ProjectPath) {
    $ProjectPath = Select-FolderDialog
    if (-not $ProjectPath) {
        Write-Host "No folder selected. Exiting." -ForegroundColor Yellow
        exit 1
    }
}

if (-not (Test-Path $ProjectPath)) {
    Write-Host "ERROR: Path does not exist: $ProjectPath" -ForegroundColor Red
    exit 1
}

# --- Validate it's a UE project ---
$uprojectFile = Get-ChildItem -Path $ProjectPath -Filter "*.uproject" -File | Select-Object -First 1
if (-not $uprojectFile) {
    Write-Host "ERROR: No .uproject file found in '$ProjectPath'. Is this a UE project?" -ForegroundColor Red
    exit 1
}

$projectName = [System.IO.Path]::GetFileNameWithoutExtension($uprojectFile.Name)
$dateSuffix  = (Get-Date).ToString("M_dd_yy")
$outputName  = "${projectName}_${dateSuffix}"
$downloads   = [System.IO.Path]::Combine($env:USERPROFILE, "Downloads")
$zipPath     = Join-Path $downloads "$outputName.zip"
$tempRoot    = Join-Path $env:TEMP "UEFlatten_$([guid]::NewGuid().ToString('N').Substring(0,8))"
$tempFolder  = Join-Path $tempRoot $outputName
# --- Extensions to collect ---
$sourceExts = @("*.h", "*.cpp", "*.cs")
$configExts = @("*.ini")

# --- Gather files with origin tracking ---
$fileEntries = @()  # Array of [FileInfo, OriginalRelativePath]

# Helper to add files from a directory
function Add-FilesFrom {
    param([string]$SearchPath, [string[]]$Extensions, [string]$BasePath)
    if (-not (Test-Path $SearchPath)) {
        Write-Host "WARNING: Directory not found: $SearchPath" -ForegroundColor Yellow
        return
    }
    foreach ($ext in $Extensions) {
        $found = Get-ChildItem -Path $SearchPath -Filter $ext -Recurse -File
        foreach ($f in $found) {
            $rel = $f.FullName.Substring($BasePath.Length).TrimStart('\', '/')
            $script:fileEntries += ,@($f, $rel)
        }
    }
}

# Source/
Add-FilesFrom -SearchPath (Join-Path $ProjectPath "Source") -Extensions $sourceExts -BasePath $ProjectPath

# Config/
Add-FilesFrom -SearchPath (Join-Path $ProjectPath "Config") -Extensions $configExts -BasePath $ProjectPath

# Plugins/*/Source/ (only with -IncludePlugins flag)
if ($IncludePlugins) {
    $pluginsPath = Join-Path $ProjectPath "Plugins"
    if (Test-Path $pluginsPath) {
        $pluginDirs = Get-ChildItem -Path $pluginsPath -Directory
        foreach ($plugin in $pluginDirs) {
            $pluginSource = Join-Path $plugin.FullName "Source"
            Add-FilesFrom -SearchPath $pluginSource -Extensions $sourceExts -BasePath $ProjectPath
        }
        Write-Host "Including plugin sources from: $($pluginDirs.Name -join ', ')" -ForegroundColor DarkGray
    }
} else {
    Write-Host "Skipping Plugins/ (use -IncludePlugins to include)" -ForegroundColor DarkGray
}

# .uproject file
$uprojectRel = $uprojectFile.FullName.Substring($ProjectPath.TrimEnd('\','/').Length).TrimStart('\','/')
$fileEntries += ,@($uprojectFile, $uprojectRel)
if ($fileEntries.Count -eq 0) {
    Write-Host "ERROR: No files found to package." -ForegroundColor Red
    exit 1
}

Write-Host "`nProject : $projectName" -ForegroundColor Cyan
Write-Host "Files   : $($fileEntries.Count)" -ForegroundColor Cyan
Write-Host "Output  : $zipPath`n" -ForegroundColor Cyan

# --- Copy to flat temp folder (handle name collisions) + build manifest ---
New-Item -ItemType Directory -Path $tempFolder -Force | Out-Null

$nameTracker = @{}
$manifestLines = @("# Flatten Manifest - $projectName - $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')")
$manifestLines += "# FlatName <- OriginalPath"
$manifestLines += "#" + ("=" * 70)

$extCounts = @{}

foreach ($entry in $fileEntries) {
    $file = $entry[0]
    $originalRel = $entry[1]
    $baseName = $file.Name

    if ($nameTracker.ContainsKey($baseName.ToLower())) {
        $nameOnly = [System.IO.Path]::GetFileNameWithoutExtension($baseName)
        $ext      = [System.IO.Path]::GetExtension($baseName)
        $counter  = $nameTracker[$baseName.ToLower()] + 1
        $nameTracker[$baseName.ToLower()] = $counter
        $baseName = "${nameOnly}_${counter}${ext}"
    }
    else {
        $nameTracker[$baseName.ToLower()] = 0
    }

    $destPath = Join-Path $tempFolder $baseName
    Copy-Item -Path $file.FullName -Destination $destPath -Force
    $manifestLines += "$baseName <- $originalRel"

    # Track extension counts
    $ext = [System.IO.Path]::GetExtension($file.Name).ToLower()
    if ($extCounts.ContainsKey($ext)) { $extCounts[$ext]++ } else { $extCounts[$ext] = 1 }
}

# Write manifest into the flat folder
$manifestPath = Join-Path $tempFolder "_manifest.txt"
$manifestLines | Out-File -FilePath $manifestPath -Encoding UTF8
# --- Compress ---
if (Test-Path $zipPath) {
    Remove-Item $zipPath -Force
}

Compress-Archive -Path $tempFolder -DestinationPath $zipPath -CompressionLevel Optimal

# --- Cleanup ---
Remove-Item -Path $tempRoot -Recurse -Force

# --- Summary ---
Write-Host "Done! Created: $zipPath" -ForegroundColor Green
Write-Host "`n  File breakdown:" -ForegroundColor Cyan
foreach ($key in ($extCounts.Keys | Sort-Object)) {
    Write-Host "    $($extCounts[$key].ToString().PadLeft(5)) $key" -ForegroundColor White
}
Write-Host "    -----" -ForegroundColor DarkGray
Write-Host "    $($fileEntries.Count.ToString().PadLeft(5)) total (+ manifest)" -ForegroundColor Cyan

# --- Open Downloads folder ---
Write-Host "`nOpening Downloads folder..." -ForegroundColor DarkGray
Start-Process explorer.exe -ArgumentList "/select,`"$zipPath`""
