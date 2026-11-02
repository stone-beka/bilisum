@echo off
rem ============================================================
rem  bilisum - one-click setup (Windows)
rem  Checks Node, installs the single dependency, downloads the
rem  ASR model, then runs the self-check.
rem ============================================================
chcp 65001 >nul
setlocal
cd /d "%~dp0bilisum"

echo.
echo  bilisum setup
echo  -------------
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [x] Node.js not found.
  echo     Install LTS from https://nodejs.org then run this file again.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do echo [1/4] Node %%v OK

if not exist node_modules (
  echo [2/4] Installing dependencies ^(sherpa-onnx-node only^)...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [x] npm install failed.
    echo     In mainland China try:  npm config set registry https://registry.npmmirror.com
    pause
    exit /b 1
  )
) else (
  echo [2/4] Dependencies present, skipped
)

echo [3/4] Downloading models ^(skipped if already verified^)
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\fetch-models.ps1"
if errorlevel 1 (
  echo.
  echo [!] Model download incomplete. Retry through a proxy:
  echo     powershell -ExecutionPolicy Bypass -File scripts\fetch-models.ps1 -Proxy http://127.0.0.1:7890
)

echo.
echo [4/4] Self-check
node bilisum.mjs doctor

echo.
echo Usage:
echo    node bilisum.mjs probe  "BV1A9xh6ZEg4"
echo    node bilisum.mjs get    "https://b23.tv/xxxxxxx"
echo    node login.mjs
echo.
pause
