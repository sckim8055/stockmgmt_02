@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0load-import.ps1" %*
echo.
pause
