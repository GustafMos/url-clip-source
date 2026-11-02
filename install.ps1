<#
.SYNOPSIS
    Installs the URL Clip Source panel for the host editor.

.DESCRIPTION
    Copies the plugin into the host's workflow-integration folder and downloads
    the video downloader and media helper on first install.

    Windows blocks .ps1 files by default ("running scripts is disabled on this
    system"). Start the installer through install.cmd, which runs this script
    with a per-process execution-policy bypass, or call:

        powershell -ExecutionPolicy Bypass -File .\install.ps1

.PARAMETER NoRestart
    Do not offer to restart the host editor when it is already running.

.NOTES
    Exit code 0 = installed, 1 = failed, 2 = the destination folder needs
    administrator rights.
#>
param(
    [switch]$NoRestart
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Windows PowerShell 5.1 still defaults to TLS 1.0 for the web cmdlets, which
# the download hosts reject.
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch {
    # Older/newer runtimes that do not expose the enum; ignore.
}

$pluginName = 'com.gustaf.urlclipsource'
$source = Join-Path $PSScriptRoot $pluginName
# Required host plugin directory. It is a fixed location owned by the host app.
$destRoot = Join-Path $env:ProgramData 'Blackmagic Design\DaVinci Resolve\Support\Workflow Integration Plugins'
$dest = Join-Path $destRoot $pluginName
$bin = Join-Path $dest 'bin'

function Get-RemoteFile {
    param([string]$Url, [string]$OutFile)
    if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
        & curl.exe -L --fail --silent --show-error -o $OutFile $Url
        if ($LASTEXITCODE -ne 0) { throw "Download failed: $Url" }
    } else {
        Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
    }
}

function Test-DirectoryWritable {
    param([string]$Path)
    $probe = Join-Path $Path ('.urlclip-probe-' + [guid]::NewGuid().ToString('N'))
    try {
        New-Item -ItemType Directory -Path $probe -ErrorAction Stop | Out-Null
        Remove-Item -Path $probe -Recurse -Force -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

Write-Host ''
Write-Host '  URL Clip Source' -ForegroundColor Red
Write-Host '  ---------------' -ForegroundColor DarkGray
Write-Host ''

if (-not (Test-Path $source)) {
    throw "Plugin source folder not found: $source"
}

$hostExe = 'C:\Program Files\Blackmagic Design\DaVinci Resolve\Resolve.exe'
if (-not (Test-Path $hostExe)) {
    Write-Warning 'The host application was not found in the default location. The plugin will still be installed.'
}

# The destination is usually writable by normal users, but it can end up owned
# by an elevated install. Report that as exit code 2 so install.cmd can relaunch
# itself with administrator rights instead of failing with a raw access error.
$canWrite = $false
try {
    New-Item -ItemType Directory -Force -Path $destRoot -ErrorAction Stop | Out-Null
    $canWrite = Test-DirectoryWritable -Path $destRoot
} catch {
    $canWrite = $false
}

if (-not $canWrite) {
    Write-Host ''
    Write-Host 'Administrator permission is required.' -ForegroundColor Yellow
    Write-Host 'The plugin folder cannot be written by the current user:' -ForegroundColor Yellow
    Write-Host "  $destRoot" -ForegroundColor DarkGray
    Write-Host ''
    Write-Host 'Right-click install.cmd and choose "Run as administrator", or run this'
    Write-Host 'script from an elevated PowerShell window.'
    exit 2
}

New-Item -ItemType Directory -Force -Path $dest | Out-Null
New-Item -ItemType Directory -Force -Path $bin | Out-Null

Write-Host 'Copying plugin...' -ForegroundColor Cyan
Copy-Item -Path (Join-Path $source '*') -Destination $dest -Recurse -Force

$ytdlp = Join-Path $bin 'yt-dlp.exe'
if (-not (Test-Path $ytdlp)) {
    Write-Host 'Downloading the video downloader...' -ForegroundColor Cyan
    Get-RemoteFile -Url 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' -OutFile $ytdlp
    Write-Host '  Done.' -ForegroundColor DarkGray
}

$ffmpeg = Join-Path $bin 'ffmpeg.exe'
if (-not (Test-Path $ffmpeg)) {
    Write-Host 'Downloading the media helper (about 115 MB)...' -ForegroundColor Cyan
    $tempRoot = Join-Path $env:TEMP 'urlclip-source-install'
    $zip = Join-Path $tempRoot 'ffmpeg.zip'
    New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
    Get-RemoteFile -Url 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' -OutFile $zip
    Write-Host '  Extracting...' -ForegroundColor DarkGray
    Expand-Archive -Path $zip -DestinationPath $tempRoot -Force
    $found = Get-ChildItem -Path $tempRoot -Recurse -Filter 'ffmpeg.exe' -File | Select-Object -First 1
    if (-not $found) { throw 'The media helper archive did not contain ffmpeg.exe.' }
    Copy-Item -Path $found.FullName -Destination $ffmpeg -Force
    Remove-Item -Path $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host '  Done.' -ForegroundColor DarkGray
}

# The host ships a bridge module with its developer samples. Using the copy
# that matches the installed host build avoids ABI surprises after an update.
$targetNode = Join-Path $dest 'WorkflowIntegration.node'
$sampleNode = Join-Path $env:ProgramData 'Blackmagic Design\DaVinci Resolve\Support\Developer\Workflow Integrations\Examples\SamplePlugin\WorkflowIntegration.node'
if (Test-Path $sampleNode) {
    Copy-Item -Path $sampleNode -Destination $targetNode -Force
    Write-Host 'Updated the host bridge module from the installed SDK.' -ForegroundColor DarkGray
} elseif (-not (Test-Path $targetNode)) {
    throw 'The host bridge module was not found. Install the host developer package or copy WorkflowIntegration.node into the plugin folder.'
}

$required = @(
    @{ Path = $ytdlp; Name = 'downloader' },
    @{ Path = $ffmpeg; Name = 'media helper' },
    @{ Path = $targetNode; Name = 'host bridge module' }
)

foreach ($file in $required) {
    if (-not (Test-Path $file.Path)) {
        throw "Missing required file: $($file.Name). The installation is incomplete."
    }
}

Write-Host ''
Write-Host 'Installed successfully.' -ForegroundColor Green
Write-Host ''
Write-Host 'Next steps:' -ForegroundColor Yellow
Write-Host '  1. Restart the host editor.'
Write-Host '  2. Open Workspace > Workflow Integrations > URL Clip Source.'
Write-Host '  3. Load a video link, mark In/Out, prepare the clip and drag it onto the timeline.'
Write-Host ''
Write-Host 'Note: Workflow Integrations are a paid-edition feature. If the menu is' -ForegroundColor DarkYellow
Write-Host 'missing, check the About dialog. The free build cannot load this plugin.' -ForegroundColor DarkYellow
Write-Host ''

$hostProcess = Get-Process Resolve -ErrorAction SilentlyContinue
if ($hostProcess) {
    Write-Host 'The host editor is running. Restart it before opening the plugin.' -ForegroundColor Yellow
    if (-not $NoRestart) {
        $answer = Read-Host 'Restart the host editor now? (y/N)'
        if ($answer -match '^[Yy]') {
            $hostProcess | Stop-Process -Force
            Start-Sleep -Seconds 2
            Start-Process $hostExe
            Write-Host 'Host editor restarted.' -ForegroundColor Green
        }
    }
}

Write-Host 'Done.' -ForegroundColor Green
exit 0
