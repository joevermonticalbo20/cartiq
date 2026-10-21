@echo off
REM Stops the offline local stack started by scripts\start_local_stack.cmd
REM (Firestore emulator on 8080, API on 4000, web dev server on 5173).

echo [stop] freeing ports 8080, 4000 and 5173...
for %%P in (8080 4000 5173) do (
  for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%%P" ^| findstr "LISTENING"') do (
    echo [stop]   killing pid %%p on port %%P
    taskkill /F /PID %%p >nul 2>&1
  )
)

REM the firebase-tools wrapper keeps a node process alive even after the
REM emulator window is closed, so match it by command line as well.
REM (wmic is gone on current Windows - use PowerShell instead.)
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*firebase*emulators:start*' } | ForEach-Object { Write-Host ('[stop]   killing firebase-tools pid ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

powershell -NoProfile -Command "Start-Sleep -Seconds 2"
echo [stop] done.
