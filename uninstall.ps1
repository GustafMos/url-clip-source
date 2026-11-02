param(
    [switch]$DeleteCache
)

$ErrorActionPreference = 'Stop'

$pluginName = 'com.gustaf.urlclipsource'
$dest = Join-Path (Join-Path $env:ProgramData 'Blackmagic Design\DaVinci Resolve\Support\Workflow Integration Plugins') $pluginName
$cache = Join-Path $env:LOCALAPPDATA 'URL Clip Source'

if (Test-Path $dest) {
    Remove-Item -Path $dest -Recurse -Force
    Write-Host 'Plugin removed.' -ForegroundColor Green
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
