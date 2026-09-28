@echo off
title School Manager
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the LTS version from https://nodejs.org and run this file again.
  pause
  exit /b 1
)

if not exist "node_modules\.install-ok" (
  echo Installing for the first time. This takes 1 to 2 minutes and needs internet. Please wait...
  if exist node_modules rmdir /s /q node_modules
  call npm install --omit=dev
  if errorlevel 1 goto installfail
  node -e "require('better-sqlite3'); require('express')" >nul 2>nul
  if errorlevel 1 goto installfail
  echo ok> "node_modules\.install-ok"
)

echo.
echo Starting School Manager. Open http://localhost:3000 in your browser.
echo Keep this window open while the school uses the system.
echo.
node server.js
pause
exit /b 0

:installfail
echo.
echo Install failed. Check your internet connection and run start.bat again.
echo If it still fails, take a screenshot of this window and ask for help.
if exist node_modules rmdir /s /q node_modules
pause
exit /b 1
