# CartIQ: full local verification, exactly as CI does it.
#
#   1. kills the emulator + API (their state is in-memory and never persists)
#   2. starts a FRESH Firestore emulator
#   3. seeds it the way CI does (db:seed + 21 days of history)
#   4. starts the API
#   5. runs the unit tests, the phase suites and the authz regression
#
# Why a fresh stack: the emulator keeps nothing between restarts, and the
# API's rate limiters live in the API process. Re-running the suites against a
# dirty stack produces failures that look like bugs but are leftover state (a
# CART-04 that already exists, a third device, an alert that is still open).
# CI always starts clean, so this script does too.
#
# Usage: pwsh -File scripts/verify_ci_parity.ps1

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$api = Join-Path $root 'api'
$logDir = Join-Path $env:TEMP 'cartiq_verify'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }

# Java 21 is required - the bundled default (jbr-17) is rejected by
# firebase-tools with "no longer supports Java version before 21".
$jdk = 'C:\Users\Joever\.jdks\jbr-21.0.11'
if (Test-Path $jdk) {
  $env:JAVA_HOME = $jdk
  $env:PATH = "$jdk\bin;$env:PATH"
}
$env:FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
$env:JWT_SECRET = 'ci-test-secret'
$env:JWT_REFRESH_SECRET = 'ci-test-refresh-secret'

function Test-Port($port) {
  return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

function Wait-Port($port, $seconds) {
  for ($i = 0; $i -lt $seconds; $i++) {
    if (Test-Port $port) { return $true }
    Start-Sleep -Seconds 2
  }
  return $false
}

Write-Output '== 1/5 stop anything already running =='
Get-NetTCPConnection -LocalPort 8080,4000 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*firebase*emulator*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3

Write-Output '== 2/5 start a fresh Firestore emulator =='
$emuLog = Join-Path $logDir 'emulator.log'
Start-Process -FilePath 'cmd.exe' `
  -ArgumentList '/c', ('npx firebase emulators:start --only firestore > "' + $emuLog + '" 2>&1') `
  -WorkingDirectory $root -WindowStyle Hidden
if (-not (Wait-Port 8080 90)) {
  Write-Output '   emulator did not come up:'
  Get-Content $emuLog -Tail 20 -ErrorAction SilentlyContinue
  exit 1
}
Write-Output '   emulator up on 8080'

Write-Output '== 3/5 seed (db:seed + 21 days of history) =='
Push-Location $api
& node scripts\seed_firestore.mjs | Select-Object -Last 1
& node scripts\seed_history.mjs 21 | Select-Object -Last 1
Pop-Location

Write-Output '== 4/5 start the API =='
$apiLog = Join-Path $logDir 'api.log'
Start-Process -FilePath 'cmd.exe' `
  -ArgumentList '/c', ('node src\server.js > "' + $apiLog + '" 2>&1') `
  -WorkingDirectory $api -WindowStyle Hidden
if (-not (Wait-Port 4000 30)) {
  Write-Output '   API did not come up:'
  Get-Content $apiLog -Tail 20 -ErrorAction SilentlyContinue
  exit 1
}
Write-Output '   API up on 4000'

Write-Output '== 5/5 run the suites =='
$failed = @()

Push-Location $api
Write-Output '-- unit tests --'
& npm test | Out-Null
if ($LASTEXITCODE -ne 0) { $failed += 'unit tests' }

foreach ($p in 2..9) {
  Write-Output "-- phase$p --"
  # phase9 has a descriptive name; the rest are phaseN_test.mjs.
  $script = if ($p -eq 9) { 'scripts/phase9_low_stock_quota.mjs' } else { "scripts/phase${p}_test.mjs" }
  & node $script | Out-Null
  if ($LASTEXITCODE -ne 0) { $failed += "phase$p" }
}

Write-Output '-- authz regression --'
& node scripts/test_authz_fix.mjs | Out-Null
if ($LASTEXITCODE -ne 0) { $failed += 'authz' }
Pop-Location

Write-Output ''
if ($failed.Count -eq 0) {
  Write-Output 'RESULT: all green'
  exit 0
}
Write-Output ("RESULT: FAILURES -> " + ($failed -join ', '))
exit 1
