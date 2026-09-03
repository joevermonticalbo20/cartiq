# CartIQ

**Pota Fries CartIQ: An Integrated IoT-Enabled Business Analytics Platform for
Multi-Location Food Cart Operations**

SIA 2 & Mobile Application Development final project - Group 5, BSIT BA3B,
Laguna University. Status: **Phases 0-5 complete (development build)**, pending
hardware pilot and faculty approval.

| Component | Path | Stack | Status |
|---|---|---|---|
| REST API | `api/` | Node.js 24, Express 5, Prisma ORM, SQLite (local file), JWT, ExcelJS | done, tested |
| Web admin dashboard | `web/` | React 19, Vite, React Router, Axios | done, builds |
| Mobile POS app | `mobile/` | Flutter (Android/Windows), offline-first sqflite queue, ML Kit OCR | done, analyzes clean |
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
flutter run --dart-define=API_BASE_URL=http://192.168.1.16:4000/api   # physical phone
#  Alternate API_BASE_URL targets (see "Mobile connectivity" below):
#    Android emulator:  http://10.0.2.2:4000/api
#    Windows desktop:   http://127.0.0.1:4000/api   (the built-in default)
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
does not use the web `/api` proxy). The API base URL is set at **build/run time**
via `--dart-define=API_BASE_URL=...`; the built-in default is
`http://127.0.0.1:4000/api`.

| Target | `API_BASE_URL` | Requirements |
|---|---|---|
| Physical Android phone | `http://<PC_LAN_IP>:4000/api` | PC and phone on same Wi-Fi; Windows Firewall allows TCP 4000 |
| Android emulator | `http://10.0.2.2:4000/api` | host loopback alias |
| Windows desktop | `http://127.0.0.1:4000/api` (default) | none |
| iOS simulator | `http://127.0.0.1:4000/api` (default) | none |

To find your PC's LAN IP on Windows: `ipconfig` → look for the Ethernet/Wi-Fi
IPv4 address (e.g. `192.168.1.16`). The API must be running with `HOST=0.0.0.0`
(set in `api/.env`) so it accepts LAN connections.

**Troubleshooting "Cannot reach CartIQ server":**
1. Confirm the API is up: `curl http://127.0.0.1:4000/api/health` on the PC.
2. Re-check the PC IP (`ipconfig`) — it is DHCP and can change; rebuild with the
   new `--dart-define` value if it does.
3. Ensure the phone is on the same network as the PC (not mobile data).
4. Verify Windows Firewall: inbound allow rule for TCP port `4000`.

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
