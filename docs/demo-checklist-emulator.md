# Demo checklist - localhost emulator (no Firebase quota)

Use this when the Spark quota is hit. Everything runs on your PC.
Zero Firestore reads. Same API logic as production.

## Terminals (4)

```powershell
# T0 - repo root. IMPORTANT: firebase-tools needs Java 21+.
# Your default java is 17, so use the Java 21 you already have:
$env:PATH = "C:\Users\Joever\.jdks\jbr-21.0.11\bin;" + $env:PATH
$env:JAVA_HOME = "C:\Users\Joever\.jdks\jbr-21.0.11"
cd C:\Users\Joever\Projects\cartiq
firebase emulators:start --only firestore
# expect: All emulators ready / 127.0.0.1:8080

# T1 - API (new terminal)
cd C:\Users\Joever\Projects\cartiq\api
npm run demo:setup     # seed users/carts/products + 21-day history, emulator only
npm run dev:emulator   # http://127.0.0.1:4000/api/health -> { ok, db: ok }
```

Verify before continuing:

```powershell
curl http://127.0.0.1:4000/api/health
```

```powershell
# T2 - web dashboard (new terminal)
cd C:\Users\Joever\Projects\cartiq\web
npm run dev            # http://localhost:5173
# No VITE_API_BASE needed - vite.config.js proxies /api to 127.0.0.1:4000
```

```powershell
# T3 - optional fake ESP32 (new terminal, makes the demo lively)
cd C:\Users\Joever\Projects\cartiq
node iot/simulator.mjs --interval 5000 --tap-every 6
# fast low-stock alert: node iot/simulator.mjs --drain --interval 2000
```

```powershell
# T4 - mobile POS
cd C:\Users\Joever\Projects\cartiq\mobile
# same PC:
flutter run -d windows --dart-define=API_BASE_URL=http://127.0.0.1:4000/api
# physical phone, same WiFi (replace with your ipconfig IPv4):
flutter run --dart-define=API_BASE_URL=http://192.168.100.217:4000/api
```

In-app alternative (no rebuild): boot splash or Login -> Server row ->
type `http://<PC_LAN_IP>:4000/api` -> Save & test connection.

## Logins (seeded by demo:setup)

| User | Pass | Role |
|---|---|---|
| `owner` | `owner123` | OWNER - web dashboard |
| `staff01` | `staff123` | STAFF - CART-01 |
| `staff02` | `staff123` | STAFF - CART-02 |
| `staff03` | `staff123` | STAFF - CART-03 |

## 5-minute demo script

1. **Web** (`http://localhost:5173`): login as `owner`. Show Dashboard KPIs (21 days of history seeded, so charts are full).
2. **POS**: login as `staff01`. Add 2 items, pay cash Exact. Show change readout.
3. **Web**: pull-to-refresh or wait <=60s - the sale appears in Recent orders. Shows phone -> API -> dashboard on one database (the emulator).
4. **Offline trust**: turn off phone WiFi, ring a sale (queued, neutral strip - not red), turn WiFi back on - syncs, no duplicate (`clientRef`).
5. **VOID**: Sales page -> void the sale -> stock restores (transaction re-checks status inside).
6. **Sensor** (if simulator running): Inventory/Live Sensor shows LPG level dropping. `--drain` triggers low-stock alert fast.
7. **OCR expense** (optional): Scan receipt -> auto-fill -> save to Expenses.

## If faculty asks "is this live?"

Honest answer: "Local emulator for today's demo because the Spark free quota is exhausted. Same Express API and same Firestore data model as the deployed Supabase function - only the connection string differs (`FIRESTORE_EMULATOR_HOST`)."

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot reach CartIQ server` on phone | PC and phone same WiFi (not guest/mobile data). `ipconfig` -> IPv4. `curl http://<PC_LAN_IP>:4000/api/health` from PC. Windows Firewall allow TCP 4000: `New-NetFirewallRule -DisplayName "CartIQ API" -Direction Inbound -LocalPort 4000 -Protocol TCP -Action Allow` |
| `JWT_SECRET is not set` | You ran `npm run dev` instead of `npm run dev:emulator`. Use the emulator script. |
| Dashboard login fails | Check T1 shows `CartIQ API listening`. Check proxy: `curl http://127.0.0.1:4000/api/health`. Never set `VITE_API_BASE` for local demo. |
| Emulator won't start | Java required. `java -version` must work. CI uses Java 21; Java 17 usually works. |
| Empty Analytics | You skipped `npm run demo:setup` or the `--clean` history step. Re-run it. |
| `mDNS error: Service name is already in use` | Harmless (stale Bonjour registration). HTTP still serves. |

## After the demo

- Close the dashboard tab (it polls every 60s even idle).
- To go back to prod: stop T0/T1, unset the emulator var, `cd api; npm run dev` with the real `.env`.
- Do NOT run `seed_history` or phase suites against prod - they write test data.
