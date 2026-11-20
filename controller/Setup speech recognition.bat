@echo off
setlocal
cd /d "%~dp0"
if exist ".venv\Scripts\python.exe" goto install
where py >nul 2>&1
if not errorlevel 1 (
  py -3 -m venv .venv
  if errorlevel 1 goto failed
  goto install
)
where python >nul 2>&1
if not errorlevel 1 (
  python -m venv .venv
  if errorlevel 1 goto failed
  goto install
)
echo Python 3.10 or later is required. Install Python, then open this setup again.
goto finish
:install
".venv\Scripts\python.exe" setup_speech.py --enhanced
if errorlevel 1 goto failed
goto finish
:failed
echo Speech setup did not complete. Review the error above, then try again.
:finish
pause
