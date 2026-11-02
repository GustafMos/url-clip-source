@echo off
REM URL Clip Source - installer launcher.
REM
REM Windows blocks .ps1 files by default ("running scripts is disabled on this
REM system"). This launcher starts install.ps1 with -ExecutionPolicy Bypass,
REM which applies to that one process only. Nothing on the system is changed.
REM
REM Usage:
REM   install.cmd                 install, leave the window open at the end
REM   install.cmd -NoRestart      do not offer to restart the host editor
REM   install.cmd --no-pause      close the window as soon as it finishes

setlocal EnableExtensions
title URL Clip Source - Installer

set "SCRIPT=%~dp0install.ps1"
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
    echo [ERROR] install.ps1 was not found next to this file.
    echo         Keep install.cmd, install.ps1 and the com.gustaf.urlclipsource
    echo         folder together.
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
    echo         Right-click install.cmd and choose "Run as administrator".
    set "RC=1"
) else (
    set "RC=0"
)
goto :eof

:finish
if not "%RC%"=="0" (
    echo.
    echo Installation was not completed. Read the message above.
)
if "%PAUSE_ON_EXIT%"=="1" (
    echo.
    pause
)
exit /b %RC%
