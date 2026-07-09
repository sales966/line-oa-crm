@echo off
rem ============================================================================
rem  LINE OA - automatic backup entry point (backup.bat)
rem  Calls scripts-ops\backup.ps1. Run by double-click or the daily 02:00
rem  scheduled task. See scripts-ops for the Chinese operations manual.
rem ============================================================================
setlocal
set "PS1=%~dp0scripts-ops\backup.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
endlocal
