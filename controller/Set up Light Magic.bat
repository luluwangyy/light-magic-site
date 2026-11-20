@echo off
setlocal
cd /d "%~dp0"
title Light Magic setup

where py >nul 2>&1
if not errorlevel 1 (
  py -3.12 -c "import struct,sys; sys.exit(sys.version_info[:2] != (3,12) or struct.calcsize('P') != 8)" >nul 2>&1
  if not errorlevel 1 (
    py -3.12 setup_light_magic.py %*
    goto finish
  )
)

for %%P in (python3.12.exe python.exe python3.exe) do (
  %%P -c "import struct,sys; sys.exit(sys.version_info[:2] != (3,12) or struct.calcsize('P') != 8)" >nul 2>&1
  if not errorlevel 1 (
    %%P setup_light_magic.py %*
    goto finish
  )
)

echo Light Magic needs 64-bit Python 3.12.
echo Install it from https://www.python.org/downloads/release/python-31210/ then open this setup again.
echo In the Python installer, include the Python launcher and pip.
echo Extract the entire Light Magic ZIP before running setup.
:finish
echo.
pause
