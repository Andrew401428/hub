@echo off
REM One-shot setup for the Hub sync server: uploads the three secrets from .secrets.local
REM (HUB_SECRET, VAPID_PUBLIC, VAPID_PRIVATE) to Cloudflare and deploys the worker.
REM Run it from this folder:  setup_secrets.cmd
REM .secrets.local is gitignored. Keep it; the HUB_SECRET line is the word you type into Hub > Settings on each device.
cd /d "%~dp0"
if not exist .secrets.local (
  echo .secrets.local is missing. Create it with three lines: HUB_SECRET=..., VAPID_PUBLIC=..., VAPID_PRIVATE=...
  exit /b 1
)
for /f "usebackq tokens=1,* delims==" %%A in (".secrets.local") do (
  echo Uploading %%A ...
  echo %%B| npx wrangler secret put %%A
  if errorlevel 1 ( echo FAILED on %%A & exit /b 1 )
)
echo Deploying the worker ...
npx wrangler deploy
if errorlevel 1 exit /b 1
echo.
echo Done. Checking the server:
curl -s https://hub-sync.elturkandrew.workers.dev/health
echo.
echo Now open Hub ^> Settings on each device, enter the server address and the HUB_SECRET word from .secrets.local, then Connect.
