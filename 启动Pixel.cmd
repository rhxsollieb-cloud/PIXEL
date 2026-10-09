@echo off
setlocal DisableDelayedExpansion
title Pixel
cd /d "%~dp0"
if errorlevel 1 goto failed

where node >nul 2>nul
if errorlevel 1 goto missing_node
where npm >nul 2>nul
if errorlevel 1 goto missing_node

echo [Pixel] Checking dependencies...
call npm install --include=dev --no-audit --no-fund
if errorlevel 1 goto failed

echo [Pixel] Building and opening the desktop app...
call npm run desktop -- %*
if errorlevel 1 goto failed
exit /b 0

:missing_node
echo [Pixel] Install Node.js, then double-click this file again.
pause
exit /b 1

:failed
set "PIXEL_EXIT_CODE=%ERRORLEVEL%"
echo.
echo [Pixel] Startup failed. Please check the error above.
pause
exit /b %PIXEL_EXIT_CODE%
