@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0create-admin.ps1" %*
echo.
pause
