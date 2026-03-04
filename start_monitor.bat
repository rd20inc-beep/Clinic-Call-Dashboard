@echo off
title Phone Link Call Monitor
echo Starting Phone Link Call Monitor...
echo.
powershell -ExecutionPolicy Bypass -File "%~dp0call_monitor.ps1"
pause
