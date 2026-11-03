@echo off
title Android 14 Emulator Manager
cd /d "%~dp0"

echo ==========================================
echo   Android 14 Emulator Manager
echo ==========================================
echo.

rem disable env vars that break electron
set ELECTRON_RUN_AS_NODE=

set APP=%~dp0app
set ELECTRON=%APP%\node_modules\electron\dist\electron.exe

if not exist "%ELECTRON%" (
  echo [ERROR] electron not found. run: cd app ^&^& npm install
  pause
  exit /b 1
)

if not exist "%~dp0android-sdk\emulator\emulator.exe" (
  echo [ERROR] android emulator not found in android-sdk
  pause
  exit /b 1
)

echo starting manager...
start "" "%ELECTRON%" "%APP%" --no-sandbox --disable-gpu --user-data-dir="%~dp0home\electron-data"

exit /b 0
