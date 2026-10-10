@echo off
rem Serve Live Watch on http://localhost:8000 and open it in the browser.
cd /d "%~dp0"
set PORT=%1
if "%PORT%"=="" set PORT=8000
start "" "http://localhost:%PORT%"
echo Serving http://localhost:%PORT% (Ctrl+C to stop)
where py >nul 2>nul && (py -m http.server %PORT%) || (python -m http.server %PORT%)
