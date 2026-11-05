@echo off
rem JIMMY_NODE: the desktop app runs vedit on its own Node (see scriptEnv in server/util.js)
if not defined JIMMY_NODE goto :app
"%JIMMY_NODE%" "%~dp0vedit.mjs" %*
exit /b %errorlevel%
:app
rem a session started outside Jimmy: the installed app is its own Node, so none has to be installed
if not exist "%~dp0..\..\..\Jimmy - The Editor.exe" goto :node
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\..\..\Jimmy - The Editor.exe" "%~dp0vedit.mjs" %*
exit /b %errorlevel%
:node
node "%~dp0vedit.mjs" %*
