# CartIQ

**Pota Fries CartIQ: An Integrated IoT-Enabled Business Analytics Platform for
Multi-Location Food Cart Operations**

SIA 2 & Mobile Application Development final project - Group 5, BSIT BA3B,
Laguna University. Status: **Phases 0-5 + frontend UX polish P1-P4 complete
(development build)**, pending hardware pilot and faculty approval.

| Component | Path | Stack | Status |
|---|---|---|---|
| REST API | `api/` | Node.js 24, Express 5, Prisma ORM, SQLite (local file), JWT, ExcelJS, Bonjour/mDNS advertise | done, tested |
| Web admin dashboard | `web/` | React 19, Vite, React Router, Axios | done, builds (lint 0 errors, P1-P4 UX polish) |
| Mobile POS app | `mobile/` | Flutter (Android/Windows), offline-first sqflite queue, ML Kit OCR, subnet auto-discovery | done, analyzes clean (0 errors) |
| ESP32 IoT node | `iot/` | Arduino C++ firmware + **Node simulator** (`iot/simulator.mjs`) | code complete; hardware pending |

## Quickstart

```bash
# 1) API  (terminal 1)
cd api
npm install
npm run db:push        # creates the SQLite database (api/prisma/dev.db)
npm run db:seed        # users, locations, products, recipes, IoT device tokens
npm run dev            # http://127.0.0.1:4000/api/health

# 2) Web dashboard  (terminal 2)
cd web && npm install && npm run dev   # http://localhost:5173

# 3) Mobile POS  (terminal 3)
cd mobile && flutter pub get
flutter run   # physical phone - auto-discovers API on the LAN (see "Mobile connectivity")
#  Fallback when auto-discovery can't reach the server:
#    flutter run --dart-define=API_BASE_URL=http://192.168.100.217:4000/api
#  Alternate API_BASE_URL targets (see "Mobile connectivity" below):
#    Android emulator:  http://10.0.2.2:4000/api
#    Windows desktop:   http://127.0.0.1:4000/api
#    iOS simulator:     http://127.0.0.1:4000/api

# 4) Fake ESP32 node until hardware arrives (terminal 4)
node iot/simulator.mjs --interval 5000 --tap-every 6
#    add --drain --interval 2000 to trigger low-stock alerts fast (great demo)

# Optional demo data for analytics (21 days of sales):
cd api && node scripts/seed_history.mjs
```

## Seeded accounts

| Username | Password | Role |
|---|---|---|
| `owner` | `owner123` | OWNER - full dashboard access |
| `staff01..03` | `staff123` | STAFF - POS at CART-01..03 |

Device tokens (printed by seed, hashed in DB): `dev-CART-01-potafries`, etc.

## Mobile connectivity

The mobile POS talks directly to the API on `:4000` (it is not a browser, so it
does not use the web `/api` proxy).

**Auto-discovery (default, no rebuild on Wi-Fi change):** on startup
`mobile/lib/main.dart` calls `ApiClient.ensureResolved()` →
`AppConfig.resolveApiUrl()` → `DiscoveryService.discoverApiUrl()` (
`mobile/lib/services/discovery_service.dart`). It reads the phone's Wi-Fi IP,
derives the `/24` subnet, and probes `*.1 - *.254` on port `4000` in parallel
(batches of 30, 500 ms timeout). First open port wins, e.g.
`http://192.168.100.217:4000/api`. Result is cached for the session. If the
scan finds nothing it falls back to the `--dart-define=API_BASE_URL=...`
value (built-in default `http://cartiq-api.local:4000/api`).

The API also advertises itself via Bonjour/mDNS (`bonjour` npm package in
`api/src/server.js`, service `CartIQ API`, `_http._tcp`, port `4000`) whenever
it is LAN-exposed (`HOST != 127.0.0.1`). Note: plain `.local` names do **not**
resolve on stock Android, which is why the app uses the subnet scan instead
of relying on the mDNS name.

Manual override is still supported at **build/run time** via
`--dart-define=API_BASE_URL=...`:

| Target | `API_BASE_URL` | Requirements |
|---|---|---|
| Physical Android phone (auto) | _(discovered)_ | PC and phone on same Wi-Fi; API running with `HOST=0.0.0.0`; Windows Firewall allows TCP 4000 |
| Physical Android phone (manual) | `http://<PC_LAN_IP>:4000/api` | same as above, plus rebuild with the current IP |
| Android emulator | `http://10.0.2.2:4000/api` | host loopback alias |
| Windows desktop | `http://127.0.0.1:4000/api` | none |
| iOS simulator | `http://127.0.0.1:4000/api` | none |

Android permissions required for scan + cleartext LAN HTTP are declared in
`mobile/android/app/src/main/AndroidManifest.xml`: `INTERNET`,
`ACCESS_NETWORK_STATE`, `ACCESS_WIFI_STATE`, `usesCleartextTraffic="true"`.

To find your PC's LAN IP on Windows: `ipconfig` → look for the Ethernet/Wi-Fi
IPv4 address (e.g. `192.168.100.217`). The API must be running with
`HOST=0.0.0.0` (set in `api/.env`) so it accepts LAN connections.

**Troubleshooting "Cannot reach CartIQ server":**
1. Confirm the API is up: `curl http://127.0.0.1:4000/api/health` on the PC,
   and from the LAN: `curl http://<PC_LAN_IP>:4000/api/health`.
2. Switching Wi-Fi changes the PC IP (DHCP) — just **restart the app**, the
   subnet scan picks up the new IP. Only the manual `--dart-define` path
   needs a rebuild.
3. Ensure the phone is on the same network as the PC (not mobile data, not a
   guest/AP-isolated SSID — the scan is same-subnet only).
4. Verify Windows Firewall: inbound allow rule for TCP port `4000`, e.g.
   `New-NetFirewallRule -DisplayName "CartIQ API" -Direction Inbound -LocalPort 4000 -Protocol TCP -Action Allow`.
5. `mDNS error: Service name is already in use on the network` from the API
   log is harmless (stale Bonjour registration) — HTTP still serves.

## Testing

Automated suites (API must be running):

```bash
node scripts/phase2_test.mjs   # IoT pipeline - 11 checks
node scripts/phase3_test.mjs   # analytics     - 19 checks (needs seed_history first)
node scripts/phase4_test.mjs   # OCR + Excel   - 20 checks
flutter analyze                # mobile static analysis
cd web && npm run build        # web production build
```

Last full regression on a fresh database: **50 automated checks passed** across
phases 2-4 plus an idempotency rerun.

Manual acceptance: `docs/uat-script.md` (15-scenario supervised parallel-run).

## Documentation

- `docs/api-contract.md` - every endpoint by phase, all marked IMPLEMENTED
- `docs/db-schema.md` - ER diagram and design decisions
- `docs/user-manual-web.md` / `docs/user-manual-mobile.md` - role guides
- `docs/uat-script.md` - client sign-off script
- `iot/firmware/README.md` - wiring, safety notes, flashing steps

## Teacher-condition traceability

| Conditional-approval requirement | Where implemented |
|---|---|
| ESP32 IoT node (RFID shifts + load-cell weights) | `iot/`, `/api/shifts`, `/api/iot/readings`, dashboard panels |
| Descriptive/predictive/prescriptive analytics | `/api/analytics/*`, `/api/reorders/suggestions`, Analytics panel |
| Computer vision (OCR receipts -> expenses) | Mobile scanner screen, `/api/expenses`, Expenses panel |
| Excel import/export | `/api/export/:dataset`, `/api/import/products`, Data management panel |

## Known limits (by design, per proposal scope)

- No online payments, payroll/tax accounting, or customer-facing ordering.
- Localhost-only deployment; supervised parallel-run at one cart; no production.
- Load cells cover the LPG tank + cheese powder bin (pilot configuration).
- Forecasts activate after ~14 days of recorded usage (cold-start honesty).

## Frontend enhancements (Phase 1-4)

The web dashboard includes these security and UX improvements over the base
React+Vite setup:

- **Centralized API client** (`web/src/api.js`) with axios interceptors for
  automatic Bearer token attachment and 401-driven logout redirect.
- **Token expiry utilities** (`isTokenExpired`, `getTokenExpiry`) for future
  refresh-token flow integration.
- **Error boundary** (`web/src/components/ErrorBoundary.jsx`) wrapping the
  entire app to surface unhandled errors gracefully.
- **Toast notifications** for non-401 API failures with `useToast` hook.
- **Reusable components**: `DataTable`, `Card`, plus the existing
  `Pagination`, `ConfirmDialog`, and `Skeleton` building blocks.
- **Custom hooks** (`web/src/hooks/useApi.js`): `useApiData` for GETs,
  `useApiMutation` for POST/PUT/PATCH/DELETE, plus `useDebounce` and
  `useLocalStorage`.
- **Adaptive refresh** on the dashboard — polls every 10s when active, slows
  to 60s after 5 minutes of inactivity, resets on user interaction.
- **KPI trend indicators** (↑/↓ vs previous period) and a date-range picker
  on the dashboard header.
- **Environment configuration** via `web/.env.example` (`VITE_API_BASE`,
  `VITE_APP_NAME`, `VITE_APP_VERSION`).
- **Comparative period analytics** — AnalyticsPage shows `↑/↓ X% vs prior 28d`
  by diffing two trend calls (28d + 56d).
- **Predictive inventory badges** — InventoryPage shows depletion date per
  item, color-coded by risk (critical/low/ok), with MAPE tooltip.
- **Bulk stock adjustment** — Multi-select checkboxes + sticky action bar
  for batched inventory recounts, with success/failure reporting.
- **Staff performance panel** — `/api/analytics/staff-performance` feeds a
  ranking card grid (orders, total sales, avg ticket, shifts completed)
  on the Staff page; top performer is highlighted.
- **UNKNOWN_CARD alert emphasis** — Dashboard now highlights unknown-card
  alerts with a critical-style border so they are immediately actionable.
- **Per-page ErrorBoundary** (`PageErrorBoundary`) wraps every page so a
  crash on one screen doesn't take the app down.
- **Quick cart switcher** on the dashboard — shows each cart with its
  current low-stock count, links to the Inventory page.
- **Vitest test suite** — `npm run test` (37 unit tests covering api utils,
  DataTable, ConfirmDialog, Pagination, and custom hooks); `npm run lint`
  (ESLint + React plugin + react-hooks rules); `npm run coverage` (text +
  HTML coverage reports). CI-ready: fails build on test or lint errors.
- **GitHub Actions CI** — `.github/workflows/web-ci.yml` runs lint + test +
  build on every push and PR to the web frontend.
- **UX polish P1 (web a11y)** — chip contrast fix in `theme.css`; reusable
  `PasswordStrengthMeter` wired into Settings change-password; 44px minimum
  touch targets for icon-only buttons.
- **UX polish P2 (empty states + clarity)** — shared web `EmptyState`
  component (`icon/title/hint/actions`) used on Inventory/Staff/Expenses;
  mobile empty states on history/home/receipts; mobile login
  show/hide password toggle; chart accessibility labels in Analytics;
  prominent bulk stock-adjust bar in Inventory.
- **UX polish P3 (findability + honesty)** — client-side search boxes on
  mobile History/Receipts; forecast-method explainer ("last-14-day average,
  needs ~14 days of history") in Analytics; downloadable products import
  template at `web/public/templates/products-template.xlsx`
  (generated by `api/scripts/make_product_template.cjs`, ships in
  `dist/templates/`).
- **UX polish P4 (feel)** — `mobile/lib/utils/haptics.dart`
  (`tap/select/success/error`) wired into POS add-to-cart, sale-recorded /
  queued, and login success/error; web `:active` press-scale (`scale(0.96)`)
  on `button` and `a.ghost` in `styles.css`.
- **Mobile network auto-discovery** — `DiscoveryService` subnet scan
  (`mobile/lib/services/discovery_service.dart`) + Bonjour advertise on the
  API; no rebuild needed when switching Wi-Fi (see "Mobile connectivity").
