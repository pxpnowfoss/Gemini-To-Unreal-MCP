@echo off
rem ---------------------------------------------------------------------------
rem  Double-click launcher for Gemini to Unreal.
rem
rem  Works from wherever the repository was cloned: it resolves its own folder
rem  rather than assuming a path, installs dependencies on first run, fetches the
rem  Electron binary if npm's script policy blocked it, builds if needed, and
rem  starts the app.
rem ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is required but was not found on PATH.
  echo Install Node 20 or newer from https://nodejs.org and run this again.
  pause
  exit /b 1
)

if not exist "node_modules\electron\package.json" (
  echo Installing dependencies, this takes a minute...
  call npm install --no-audit --no-fund || goto :failed
)

rem npm can block Electron's postinstall, which leaves the binary missing.
if not exist "node_modules\electron\dist\electron.exe" (
  echo Fetching the Electron runtime...
  call node node_modules\electron\install.js || goto :failed
)

if not exist "dist\main\main.js" (
  echo Building...
  call npm run build || goto :failed
)

start "" "node_modules\electron\dist\electron.exe" "%~dp0."
exit /b 0

:failed
echo.
echo Setup failed. Scroll up for the error.
pause
exit /b 1
