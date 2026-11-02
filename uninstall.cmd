@echo off
REM URL Clip Source - uninstaller launcher.
REM
REM Starts uninstall.ps1 with -ExecutionPolicy Bypass for this process only,
REM so it works even when Windows blocks .ps1 files.
REM
REM Usage:
REM   uninstall.cmd               remove the plugin, keep cached clips
REM   uninstall.cmd -DeleteCache  remove the plugin and cached clips
REM   uninstall.cmd --no-pause    close the window as soon as it finishes

setlocal EnableExtensions
title URL Clip Source - Uninstaller

set "SCRIPT=%~dp0uninstall.ps1"
set "PS_ARGS="
set "PAUSE_ON_EXIT=1"

:parse_args
if "%~1"=="" goto args_done
if /i "%~1"=="--no-pause" (
    set "PAUSE_ON_EXIT=0"
) else (
    set PS_ARGS=%PS_ARGS% "%~1"
)
shift
goto parse_args
:args_done

if not exist "%SCRIPT%" (
    echo [ERROR] uninstall.ps1 was not found next to this file.
    set "RC=1"
    goto finish
)

set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell.exe"

"%PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %PS_ARGS%
set "RC=%ERRORLEVEL%"

REM Exit code 2 means the plugin folder needs administrator rights.
if "%RC%"=="2" call :elevate
goto finish

:elevate
fltmc >nul 2>&1
if not errorlevel 1 goto :eof

echo.
echo Asking for administrator rights...
if defined PS_ARGS (
    "%PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -ArgumentList %PS_ARGS% -Verb RunAs"
) else (
    "%PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
)
if errorlevel 1 (
    echo [ERROR] Administrator rights were not granted.
    echo         Right-click uninstall.cmd and choose "Run as administrator".
    set "RC=1"
) else (
    set "RC=0"
)
goto :eof

:finish
if not "%RC%"=="0" (
    echo.
    echo Uninstall was not completed. Read the message above.
)
if "%PAUSE_ON_EXIT%"=="1" (
    echo.
    pause
)
exit /b %RC%
