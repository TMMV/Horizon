@echo off
rem Starts Horizon on this computer and opens it in your browser.
rem Double-click this file. Keep the window open while you use Horizon; close it to stop.
title Horizon
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel%==0 (
  node scripts\serve.mjs --open
  goto end
)

rem No Node.js: use Python's built-in web server on the same address.
set PY=
where py >nul 2>nul && set PY=py
if not defined PY where python >nul 2>nul && set PY=python
if defined PY (
  echo Horizon is running at http://localhost:8765/
  echo Keep this window open while you use it; close it to stop.
  start "" http://localhost:8765/
  %PY% -m http.server 8765 --bind 127.0.0.1
  goto end
)

rem Neither is installed: open the page straight from the folder.
echo Node.js and Python were not found, so Horizon opens straight from the folder.
echo That works too, but your plan is then saved separately from the http://localhost:8765 version.
start "" "%~dp0index.html"
timeout /t 8 >nul

:end
