@echo off
REM CartIQ local stack: Firestore emulator (8080) + Express API (4000).
REM Java 21 is required - the bundled default (jbr-17) is rejected by
REM firebase-tools with "no longer supports Java version before 21".
REM Usage: scripts\start_local_stack.cmd

set "JDK=C:\Users\Joever\.jdks\jbr-21.0.11"
if exist "%JDK%" (
  set "JAVA_HOME=%JDK%"
  set "PATH=%JDK%\bin;%PATH%"
)

cd /d "%~dp0.."

echo [stack] FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
start "cartiq-emulator" cmd /c "npx firebase emulators:start --only firestore"
timeout /t 8 /nobreak >nul

cd /d "%~dp0..\api"
start "cartiq-api" cmd /c "node scripts\dev_emulator.mjs"

echo [stack] emulator on 8080, API on 4000