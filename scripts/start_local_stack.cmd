@echo off
REM ============================================================================
REM CartIQ OFFLINE local stack: Firestore emulator (8080) + Express API (4000)
REM                                          + web dashboard (5173)
REM
REM Zero internet required. The emulator JAR and firebase-tools are already
REM on this PC, and the API talks to the emulator over 127.0.0.1 only.
REM Nothing here reads or writes the real Firebase project.
REM
REM   scripts\start_local_stack.cmd          emulator + API + web
REM   scripts\start_local_stack.cmd api      emulator + API only
REM
REM Java 21 is required - firebase-tools rejects the bundled default (jbr-17)
REM with "no longer supports Java version before 21".
REM ============================================================================
setlocal

set "JDK=C:\Users\Joever\.jdks\jbr-21.0.11"
if exist "%JDK%\bin\java.exe" (
  set "JAVA_HOME=%JDK%"
  set "PATH=%JDK%;%PATH%"
  set "PATH=%JDK%\bin;%PATH%"
)
"%JDK%\bin\java.exe" -version >nul 2>&1
if errorlevel 1 (
  echo [stack] ERROR: Java 21 not found at "%JDK%".
  echo [stack] firebase-tools will not start the emulator on Java 17.
  pause
  exit /b 1
)

cd /d "%~dp0.."
set "ROOT=%CD%"
set "WITH_WEB=1"
set "SEED_MODE=full"
if /i "%~1"=="api" set "WITH_WEB=0"
REM "quick" seeds users/carts/products only - no 21-day sales history.
REM It starts in ~15s instead of ~2min, but Analytics and forecast stay empty.
if /i "%~1"=="quick" set "SEED_MODE=quick"
if /i "%~2"=="quick" set "SEED_MODE=quick"

echo [stack] java  : %JDK%
echo [stack] repo  : %ROOT%
echo.

REM --- 1. free the ports so a re-run is clean -----------------------------
echo [stack] freeing ports 8080 and 4000...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8080" ^| findstr "LISTENING"') do taskkill /F /PID %%p >nul 2>&1
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":4000" ^| findstr "LISTENING"') do taskkill /F /PID %%p >nul 2>&1
powershell -NoProfile -Command "Start-Sleep -Seconds 3"

REM --- 2. Firestore emulator (offline, uses the cached jar) ---------------
REM "firebase", not "npx firebase": firebase-tools is installed globally, and
REM npx would try to resolve the package from the npm registry first - which
REM needs the internet this stack is meant to do without. The emulator JAR
REM (cloud-firestore-emulator-v1.21.0.jar) is already in the firebase cache.
echo [stack] starting Firestore emulator on 127.0.0.1:8080 ...
start "cartiq-emulator" cmd /c "firebase emulators:start --only firestore"
powershell -NoProfile -Command "for($i=0;$i -lt 60;$i++){ if(Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue){exit 0}; Start-Sleep -Seconds 2 }; exit 1"
if errorlevel 1 (
  echo [stack] ERROR: emulator did not come up on 8080. Check the cartiq-emulator window.
  pause
  exit /b 1
)
echo [stack] emulator is up.
echo.

REM --- 3. seed it (the emulator keeps nothing between restarts) -----------
REM SAFETY: every seed script here talks to Firestore through api/src/firestore.js,
REM which prefers FIRESTORE_EMULATOR_HOST and only falls back to the real
REM project when that variable is absent. api/.env points
REM GOOGLE_APPLICATION_CREDENTIALS at service-account.prod.json, so running a
REM seed WITHOUT the emulator host writes to PRODUCTION. Force the emulator on,
REM and drop the prod credentials, so no seed can ever leave this PC.
cd /d "%ROOT%\api"
set "FIRESTORE_EMULATOR_HOST=127.0.0.1:8080"
set "FIREBASE_PROJECT_ID=cartiq-8e46f"
set "JWT_SECRET=emulator-demo-secret-not-for-prod"
set "JWT_REFRESH_SECRET=emulator-demo-refresh-not-for-prod"
set "GOOGLE_APPLICATION_CREDENTIALS="
set "FIREBASE_SERVICE_ACCOUNT_JSON="
if "%SEED_MODE%"=="quick" (
  echo [stack] seeding the emulator - users, carts, products. No sales history.
  node scripts\seed_firestore.mjs
) else (
  echo [stack] seeding the emulator - users, carts, products, 21 days of sales...
  call npm run demo:setup
)
if errorlevel 1 (
  echo [stack] ERROR: seeding failed.
  pause
  exit /b 1
)
echo.

REM --- 4. API, pointed at the emulator -------------------------------------
echo [stack] starting the API on 127.0.0.1:4000 ...
start "cartiq-api" cmd /c "node scripts\dev_emulator.mjs"
powershell -NoProfile -Command "for($i=0;$i -lt 30;$i++){ if(Get-NetTCPConnection -LocalPort 4000 -State Listen -ErrorAction SilentlyContinue){exit 0}; Start-Sleep -Seconds 2 }; exit 1"
if errorlevel 1 (
  echo [stack] ERROR: API did not come up on 4000. Check the cartiq-api window.
  pause
  exit /b 1
)

REM --- 5. web dashboard ----------------------------------------------------
if "%WITH_WEB%"=="1" (
  cd /d "%ROOT%\web"
  echo [stack] starting the web dashboard on http://localhost:5173 ...
  start "cartiq-web" cmd /c "npm run dev"
  powershell -NoProfile -Command "Start-Sleep -Seconds 4"
)

echo.
echo ============================================================
echo  CartIQ is running OFFLINE on the local emulator.
echo.
echo    web dashboard : http://localhost:5173
echo    API health    : http://127.0.0.1:4000/api/health
echo    logins        : owner / owner123        (web dashboard)
echo                    staff01 / staff123      (POS, CART-01)
echo                    staff02 / staff123      (POS, CART-02)
echo                    staff03 / staff123      (POS, CART-03)
echo.
echo    phone on the same Wi-Fi: the app's Login -^> Server row,
echo    type http://^<your-PC-IP^>:4000/api -^> Save ^& test connection.
echo    To get your PC IP: ipconfig
echo.
echo    Stop everything: close the three windows, or run
echo    scripts\stop_local_stack.cmd
echo ============================================================
endlocal
