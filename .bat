@echo off
echo Starting Compressor services on network...
echo.
timeout /t 2

REM Get the directory where this script is located
cd /d "%~dp0"

REM Start server in new window
echo Starting server...
start "server" cmd /k "cd server && npm start"
timeout /t 2

REM Start client in new window
echo Starting client...
start "client" cmd /k "cd client && npm run dev -- --host"
timeout /t 2
