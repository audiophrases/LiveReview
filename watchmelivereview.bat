@echo off
rem WatchMeLiveReview: start the WatchMePlayChess server (records your chess.com games) and Live Review
rem (reviews them live), then open Live Review and chess.com in the browser.
rem
rem   watchmelivereview.bat [port]      Live Review port, 8000 by default (WatchMePlayChess always uses 3000)
rem
rem WatchMePlayChess is looked for next to this folder (..\watchmeplaychess); set WATCHMEPLAY_DIR to use
rem another folder. Set WMLR_NO_BROWSER=1 to start the servers without opening any tabs.
rem In Live Review, use "Watch folder..." on <watchmeplaychess>\data\games to follow the game you're playing.
setlocal
cd /d "%~dp0"
set "PORT=%~1"
if "%PORT%"=="" set PORT=8000
if "%WATCHMEPLAY_DIR%"=="" set "WATCHMEPLAY_DIR=%~dp0..\watchmeplaychess"
if not exist "%WATCHMEPLAY_DIR%\server.js" (
  echo WatchMePlayChess not found in "%WATCHMEPLAY_DIR%"
  echo Set WATCHMEPLAY_DIR to its folder and run this again.
  pause
  exit /b 1
)
for %%d in ("%WATCHMEPLAY_DIR%") do set "WATCHMEPLAY_DIR=%%~fd"

rem Stop previous instances: the old WatchMePlayChess window, whatever holds port 3000 and an earlier
rem Live Review (python) on our port.
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | Where-Object { $_.CommandLine -like '*title WatchMePlayChess server*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /C:":3000 " ^| findstr LISTENING') do (
  echo Stopping process on port 3000 ^(pid %%a^)...
  taskkill /F /PID %%a >nul 2>&1
)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /C:":%PORT% " ^| findstr LISTENING') do (
  tasklist /FI "PID eq %%a" 2>nul | findstr /I "python" >nul && (
    echo Stopping previous Live Review ^(pid %%a^)...
    taskkill /F /PID %%a >nul 2>&1
  )
)
timeout /t 1 /nobreak >nul

rem WatchMePlayChess runs in its own window; close that window to stop it.
if not exist "%WATCHMEPLAY_DIR%\node_modules" (
  pushd "%WATCHMEPLAY_DIR%"
  call npm install
  popd
)
start "WatchMePlayChess server" /min cmd /k "title WatchMePlayChess server && cd /d "%WATCHMEPLAY_DIR%" && npm start"

if not "%WMLR_NO_BROWSER%"=="1" (
  start "" "http://localhost:%PORT%"
  start "" "https://www.chess.com/play/online"
)

echo WatchMePlayChess server: http://localhost:3000 ^(own window; games saved in %WATCHMEPLAY_DIR%\data\games^)
echo Live Review:             http://localhost:%PORT%
echo Ctrl+C here stops Live Review; close the "WatchMePlayChess server" window to stop that one.
where py >nul 2>nul && (py -m http.server %PORT%) || (python -m http.server %PORT%)
