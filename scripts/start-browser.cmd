@echo off
rem ---------------------------------------------------------------
rem  dsh-papersearch : launch a debuggable Chrome for literature search
rem
rem  Double-click this file ONCE. It starts Chrome with a dedicated
rem  profile (so your normal Chrome stays untouched) and opens the
rem  DevTools port that the DSH plugin connects to.
rem
rem  Log in to Web of Science / CNKI in that window. The session is
rem  remembered in the profile folder below, so you usually only need
rem  to log in once.
rem ---------------------------------------------------------------
setlocal
set PORT=9222
set PROFILE=%LOCALAPPDATA%\dsh-papersearch\chrome-profile
set CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe
if not exist "%CHROME%" set CHROME=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe
if not exist "%CHROME%" set CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe

if not exist "%CHROME%" (
  echo [ERROR] Chrome not found. Edit the CHROME path in this file.
  pause
  exit /b 1
)

if not exist "%PROFILE%" mkdir "%PROFILE%"

echo Starting Chrome ...
echo   port    : %PORT%
echo   profile : %PROFILE%
start "" "%CHROME%" --remote-debugging-port=%PORT% --user-data-dir="%PROFILE%" --remote-allow-origins=* --no-first-run --no-default-browser-check https://www.webofscience.com/

echo.
echo Chrome started. Log in to Web of Science / CNKI in that window,
echo then go back to DSH and run paper_search.
timeout /t 3 >nul
