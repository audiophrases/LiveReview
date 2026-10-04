@echo off
setlocal
title Live Review - deploy suite
rem Commits+pushes THIS repo, then syncs+builds+pushes yourlines, which
rem triggers the GitHub Actions deploy to
rem https://audiophrases.github.io/yourlines/. The suite lives in the
rem sibling "yourlines" folder.

set "SUITE_DIR=%~dp0..\yourlines"

if not exist "%SUITE_DIR%\package.json" (
  echo.
  echo   Could not find the yourlines suite at "%SUITE_DIR%".
  echo   Clone https://github.com/audiophrases/yourlines next to this folder.
  echo.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found on your PATH.
  echo   Install it from https://nodejs.org/ ^(LTS^) and run this again.
  echo.
  pause
  exit /b 1
)

cd /d "%SUITE_DIR%"

if not exist "node_modules\" (
  echo.
  echo   First run - installing suite dependencies. This can take a minute...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo   npm install failed. See the errors above.
    echo.
    pause
    exit /b 1
  )
)

call npm run deploy -- --app live

if errorlevel 1 pause
endlocal
