<#
.SYNOPSIS
    Removes the URL Clip Source panel from the host editor.

.DESCRIPTION
    Windows blocks .ps1 files by default ("running scripts is disabled on this
    system"). Start the uninstaller through uninstall.cmd, or call:

        powershell -ExecutionPolicy Bypass -File .\uninstall.ps1

.PARAMETER DeleteCache
    Also remove downloaded clips and settings.

.NOTES
    Exit code 0 = removed, 1 = failed, 2 = the plugin folder needs
    administrator rights.
#>
param(
    [switch]$DeleteCache
)

$ErrorActionPreference = 'Stop'

$pluginName = 'com.gustaf.urlclipsource'
$dest = Join-Path (Join-Path $env:ProgramData 'Blackmagic Design\DaVinci Resolve\Support\Workflow Integration Plugins') $pluginName
$cache = Join-Path $env:LOCALAPPDATA 'URL Clip Source'

if (Test-Path $dest) {
    try {
        Remove-Item -Path $dest -Recurse -Force -ErrorAction Stop
        Write-Host 'Plugin removed.' -ForegroundColor Green
    } catch {
        Write-Host ''
        Write-Host 'Administrator permission is required to remove the plugin.' -ForegroundColor Yellow
        Write-Host "  $dest" -ForegroundColor DarkGray
        Write-Host ''
        Write-Host 'Right-click uninstall.cmd and choose "Run as administrator".'
        exit 2
    }
} else {
    Write-Host 'Plugin folder was not present.' -ForegroundColor Yellow
}

if ($DeleteCache -and (Test-Path $cache)) {
    Remove-Item -Path $cache -Recurse -Force
    Write-Host 'Cache removed.' -ForegroundColor Green
} else {
    Write-Host 'Cache kept.' -ForegroundColor DarkGray
    Write-Host 'Run with -DeleteCache to remove it as well.' -ForegroundColor DarkGray
}

Write-Host 'Restart the host editor to unload the plugin.'
exit 0
