@echo off
setlocal
cd /d "%~dp0"

echo.
echo   Ndownloader2
echo   An Edge window will open with the controls:
echo   paste links, choose a folder, press Start.
echo.
echo   Keep this console open. Close it (or press Ctrl+C) to stop the bot.
echo.

node "%~dp0server.mjs"

echo.
echo   Server stopped.
pause
