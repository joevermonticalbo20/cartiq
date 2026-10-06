# Live end-to-end check: POS order -> SSE broadcast -> web notification payload.
# Runs emulator + API in one shot so the child processes live for the whole test.
$ErrorActionPreference = "Continue"
$repo = "C:\Users\Joever\Projects\cartiq"
$jdk  = "C:\Users\Joever\.jdks\jbr-21.0.11"

function Log($m) { Write-Output $m }

# --- cleanup any leftovers -------------------------------------------------
foreach ($pid_ in (Get-NetTCPConnection -LocalPort 4000,8080,4400,4500,9150 -EA SilentlyContinue |
                   Select-Object -ExpandProperty OwningProcess -Unique | Where-Object { $_ -gt 0 })) {
  try { Stop-Process -Id $pid_ -Force } catch {}
}
Start-Sleep -Seconds 2

# --- emulator --------------------------------------------------------------
$emu = Start-Job -ScriptBlock {
  param($repo, $jdk)
  $env:PATH = "$jdk\bin;" + $env:PATH
  $env:JAVA_HOME = $jdk
  Set-Location $repo
  firebase emulators:start --only firestore 2>&1
} -ArgumentList $repo, $jdk

for ($i = 0; $i -lt 24 -and -not (Get-NetTCPConnection -LocalPort 8080 -State Listen -EA SilentlyContinue); $i++) {
  Start-Sleep -Seconds 5
}
if (-not (Get-NetTCPConnection -LocalPort 8080 -State Listen -EA SilentlyContinue)) {
  Log "EMULATOR FAILED"; Receive-Job $emu | Select-Object -Last 10; exit 1
}
Log "EMULATOR: UP"

# --- seed ------------------------------------------------------------------
$env:FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080"
$env:FIREBASE_PROJECT_ID = "cartiq-8e46f"
$env:JWT_SECRET = "emulator-demo-secret-not-for-prod"
$env:JWT_REFRESH_SECRET = "emulator-demo-refresh-not-for-prod"
Set-Location "$repo\api"
Log ("SEED: " + ((node scripts/seed_firestore.mjs 2>&1 | Select-Object -Last 1) -join ''))

# --- api -------------------------------------------------------------------
$api = Start-Job -ScriptBlock {
  param($repo)
  Set-Location "$repo\api"
  node scripts/dev_emulator.mjs 2>&1
} -ArgumentList $repo
for ($i = 0; $i -lt 15 -and -not (Get-NetTCPConnection -LocalPort 4000 -State Listen -EA SilentlyContinue); $i++) {
  Start-Sleep -Seconds 2
}
if (-not (Get-NetTCPConnection -LocalPort 4000 -State Listen -EA SilentlyContinue)) {
  Log "API FAILED"; Receive-Job $api | Select-Object -Last 10; exit 1
}
Log "API: UP"
Log ("HEALTH: " + ((Invoke-WebRequest -Uri http://127.0.0.1:4000/api/health -TimeoutSec 25 -UseBasicParsing).Content))

# --- auth ------------------------------------------------------------------
$tok = (Invoke-WebRequest -Uri http://127.0.0.1:4000/api/auth/login -Method POST `
        -ContentType "application/json" -Body '{"username":"owner","password":"owner123"}' `
        -TimeoutSec 25 -UseBasicParsing | ConvertFrom-Json).token
$H = @{ Authorization = "Bearer $tok" }

# --- 1. stream ticket (what the browser does) ------------------------------
$ticket = (Invoke-WebRequest -Uri http://127.0.0.1:4000/api/events/ticket -Method POST `
            -ContentType "application/json" -Headers $H -Body '{}' -TimeoutSec 25 -UseBasicParsing |
            ConvertFrom-Json).ticket
Log "TICKET: $($ticket.Substring(0, 10))..."

# --- 2. open the SSE stream in the background (stands in for the browser) ---
$sse = Start-Job -ScriptBlock {
  param($tk)
  # -TimeoutSec 20 so the stream closes on its own and we can read the body.
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:4000/api/events?ticket=$tk" -TimeoutSec 20 -UseBasicParsing
  $r.Content
} -ArgumentList $ticket
Start-Sleep -Seconds 3
Log "SSE: stream open"

# --- 3. place an order, exactly like the POS app does ----------------------
$cat = (Invoke-WebRequest -Uri http://127.0.0.1:4000/api/catalog -Headers $H -TimeoutSec 25 -UseBasicParsing | ConvertFrom-Json)
$pname = $cat.products[0].name
$body = "{`"locationCode`":`"CART-01`",`"clientRef`":`"notif-e2e-1`",`"items`":[{`"productName`":`"$pname`",`"qty`":2,`"unitPrice`":40}]}"
$order = Invoke-WebRequest -Uri http://127.0.0.1:4000/api/orders -Method POST -ContentType "application/json" `
          -Headers $H -Body $body -TimeoutSec 25 -UseBasicParsing | ConvertFrom-Json
Log "ORDER: #$($order.order.id) total=$($order.order.total) on CART-01 ($pname x2)"

# --- 4. did the stream deliver order:new? ----------------------------------
Log ""
Log "=== SSE PAYLOAD RECEIVED ==="
$out = Receive-Job $sse -Wait -ErrorAction SilentlyContinue
$raw = ($out | Out-String)
Write-Output $raw

if ($raw -match "order:new") {
  Log "RESULT: PASS - order:new was broadcast to the stream"
  $json = ($raw -split "`n" | Where-Object { $_ -match '^\s*data:' -and $_ -match 'locationCode' } | Select-Object -First 1)
  if ($json) { Log ("PAYLOAD: " + ($json -replace '^\s*data:\s*', '')) }
} else {
  Log "RESULT: FAIL - order:new never arrived on the stream"
}

Stop-Job $sse, $api, $emu -EA SilentlyContinue
Remove-Job $sse, $api, $emu -Force -EA SilentlyContinue
Start-Sleep -Seconds 2
Log "cleaned up"