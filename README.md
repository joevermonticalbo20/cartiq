# CartIQ

**Pota Fries CartIQ: An Integrated IoT-Enabled Business Analytics Platform for
Multi-Location Food Cart Operations**

SIA 2 & Mobile Application Development final project - Group 5, BSIT BA3B,
Laguna University. Status: **Phases 0-5 + frontend UX polish P1-P4 +
reliability/checkout/connectivity sprints complete (development build)**,
pending hardware pilot and faculty approval.

| Component | Path | Stack | Status |
|---|---|---|---|
| REST API | `api/` | Node.js 24, Express 5, Prisma ORM, SQLite (local file), JWT + rotating refresh tokens, login rate limiting, ExcelJS, Bonjour/mDNS advertise | done, tested |
| Web admin dashboard | `web/` | React 19, Vite, React Router, Axios | done, builds (lint 0 errors, P1-P4 UX polish) |
| Mobile POS app | `mobile/` | Flutter (Android/Windows), offline-first sqflite queue, ML Kit OCR, subnet auto-discovery | done, analyzes clean (0 errors) |
| ESP32 IoT node | `iot/` | Arduino C++ firmware + **Node simulator** (`iot/simulator.mjs`) | code complete; hardware pending |

## Quickstart

```bash
# 1) API  (terminal 1)
cd api
npm install              # postinstall auto-runs `prisma generate`
npm run db:push        # creates the SQLite database (api/prisma/dev.db)
npm run db:seed        # users, locations, products, recipes, IoT device tokens
npm run dev            # http://127.0.0.1:4000/api/health

# 2) Web dashboard  (terminal 2)
cd web && npm install && npm run dev   # http://localhost:5173

# 3) Mobile POS  (terminal 3)
cd mobile && flutter pub get
flutter run   # physical phone - boot splash auto-discovers the API on the LAN
              # (see "Mobile connectivity"); Skip or type the IP if the scan stalls
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
cd api && node scripts/seed_history.mjs        # appends
cd api && node scripts/seed_history.mjs 21 --clean   # wipes old hist-% rows first (re-runnable)
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

**Auto-discovery (default, no rebuild on Wi-Fi change):** the app boots
straight into a splash (`mobile/lib/main.dart` `_BootApp`) while
`ApiClient.ensureResolved()` → `AppConfig.resolveApiUrl()` →
`DiscoveryService.discoverApiUrl()` (
`mobile/lib/services/discovery_service.dart`) runs in the background. It reads
the phone's Wi-Fi IP, derives the `/24` subnet, and probes `*.1 - *.254` on
port `4000` in parallel (batches of 30, 500 ms timeout). First open port wins,
e.g. `http://192.168.100.217:4000/api`. Result is cached for the session. If
the scan finds nothing it falls back to the `--dart-define=API_BASE_URL=...`
value (built-in default `http://cartiq-api.local:4000/api`).

No rebuild needed, ever, for LAN moves — two in-app escape hatches:
- **Boot splash:** progress + `Skip - enter later` (uses fallback) + manual
  `Server (IP or host)` field + Connect (15 s scan timeout, never hangs).
- **Login → Server row (collapsible):** shows the active URL (+ `manual
  override` tag when pinned), `Rescan`, and `Save & test connection` with a
  live reachability result. A manual URL is persisted in secure storage
  (`cartiq_api_url`) and wins over discovery on every future launch until you
  Rescan.

Connection errors report the **resolved** URL, not the build-time default.

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
| Physical Android phone (manual, in-app) | typed on splash or Login → Server | same as above, no rebuild; persists across restarts |
| Physical Android phone (manual, build-time) | `http://<PC_LAN_IP>:4000/api` | same as above, plus rebuild with the current IP |
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
   and from the LAN: `curl http://<PC_LAN_IP>:4000/api/health`. The reply
   includes `ok`, `version`, `uptimeSec`, `db` (503 when the DB is down).
2. Switching Wi-Fi changes the PC IP (DHCP) — just **restart the app**, the
   splash scan picks up the new IP. Only the build-time `--dart-define` path
   needs a rebuild; the in-app manual URL just needs re-typing once.
3. The error message now shows the URL the app actually tried — compare it
   with `ipconfig` on the PC before rebuilding anything.
4. Ensure the phone is on the same network as the PC (not mobile data, not a
   guest/AP-isolated SSID — the scan is same-subnet only).
4. Verify Windows Firewall: inbound allow rule for TCP port `4000`, e.g.
   `New-NetFirewallRule -DisplayName "CartIQ API" -Direction Inbound -LocalPort 4000 -Protocol TCP -Action Allow`.
5. `mDNS error: Service name is already in use on the network` from the API
   log is harmless (stale Bonjour registration) — HTTP still serves.

## API notes

- **CORS is env-driven:** set `CORS_ORIGINS` in `api/.env` to a
  comma-separated list (e.g.
  `CORS_ORIGINS="http://localhost:5173,http://192.168.100.217:5173"`) so a
  DHCP change doesn't need a code edit. Server exits at boot with
  `[api:fatal]` if `JWT_SECRET` is missing.
- **Orders are server-authoritative:** `POST /orders` requires
  `locationCode`/`locationId` (400 otherwise, never silently books to the
  first cart) and the `total` is recomputed from items — client totals are
  ignored. Replays with the same `clientRef` return `duplicate: true`.
- **Errors carry `correlationId`:** Prisma P2002 → 409, P2025 → 404, 404s
  include an id — quote it when reporting a failure.
- **Auth:** short-lived access JWT + rotating refresh tokens
  (`POST /auth/refresh`, `RefreshToken` table). Set `JWT_REFRESH_SECRET` in
  `api/.env` (falls back to `JWT_SECRET` if omitted). `/auth/login` is rate
  limited to 5 attempts per 15 minutes per IP.
- **LAN origins:** browser dashboard on a phone/laptop needs its origin in
  `CORS_ORIGINS` plus `HOST=0.0.0.0` and the Windows Firewall TCP 4000 rule.

## Testing

Automated suites (API must be running):

```bash
node scripts/phase2_test.mjs   # IoT pipeline - 11 checks
node scripts/phase3_test.mjs   # analytics     - 19 checks (needs seed_history first)
node scripts/phase4_test.mjs   # OCR + Excel   - 20 checks
node scripts/phase5_test.mjs   # hardening     - 23 checks (pagination/staff/password/devices/shifts)
node scripts/phase6_test.mjs   # categories    - 13 checks (expense buckets)
flutter analyze                # mobile static analysis
flutter test                   # mobile unit tests - 21 checks (URL normalize, cart, receipt parser)
cd web && npm run build        # web production build
```

Last full regression on a fresh database: **86 automated checks passed** across
phases 2-6 plus an idempotency rerun.

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
- **Token expiry utilities** (`isTokenExpired`, `getTokenExpiry`) support the
  refresh-token flow (`POST /auth/refresh`); the mobile app recovers its
  session without forcing a re-login.
- **Error boundary** (`web/src/components/ErrorBoundary.jsx`) wrapping the
  entire app to surface unhandled errors gracefully.
- **Toast notifications** — each page owns its error UI (error boxes, empty
  states, or an explicit toast for user actions like delete/export); the API
  client only handles the 401 logout redirect, so background reads stay
  silent (`useToast` hook).
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
- **Vitest test suite** — `npm run test` (86 unit tests covering api utils,
  DataTable, ConfirmDialog, Pagination, EmptyState, PasswordStrengthMeter,
  and custom hooks); `npm run lint`
  (ESLint + React plugin + react-hooks rules); `npm run coverage` (text +
  HTML coverage reports). CI-ready: fails build on test or lint errors.
- **GitHub Actions CI** — `web-ci.yml` (web lint + test + build),
  `api-ci.yml` (`npm ci` + Prisma validate + syntax check), and
  `mobile-ci.yml` (`flutter analyze` + `flutter test`) run on every push and
  PR touching their paths.
- **Tailwind CSS v4** — `@tailwindcss/vite` plugin with a token-mapped
  `src/tailwind.css` (`@theme` references `theme.css` vars, `dark:` variant
  follows the `data-theme` toggle); sits alongside the legacy stylesheet,
  which loads last and wins ties. Piloted on `EmptyState`.
- **Alerts mark-all-read** — `PATCH /alerts/read` (OWNER, optional `{ids}`
  subset, returns `{updated}`); dashboard Stock alerts panel exposes it as
  “Mark all read”.
- **Per-page stylesheets** — `src/styles/` gives every page its own file
  (`dashboard.css`, `login.css`, …) with `PART/SAKOP` identifiers and its own
  responsive tail; `npm run css:check` fails on cross-file duplicates.
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
- **Checkout speed (mobile)** — long-press quick-add with default flavor,
  debounced catalog search, Retry on catalog failure, additive bill chips
  (+20–1000) + Exact, autofocus cash field with Done-to-pay, always-visible
  Change/Short-by, disabled-pay hint, and a sale-result sheet with a big
  change readout + New sale button (`mobile/lib/screens/pos_screen.dart`).
- **Offline trust (mobile)** — session survives offline cold-start (sign-out
  only on 401/403), persistent queued-sales strip on POS, neutral (not red)
  queued-offline feedback, `View all` routes to History.
- **Connectivity UX (mobile)** — non-blocking boot splash with progress,
  Skip, and manual-IP entry; persisted manual server URL; Login → Server
  panel with Rescan + Save & test; errors show the resolved URL
  (`main.dart`, `services/api_client.dart`, `screens/login_screen.dart`).
- **Dialog + toast a11y (web)** — `ConfirmDialog` has `role=dialog`,
  Esc-to-cancel, initial focus; toasts have `role=status`/`alert`,
  `aria-live`, a dismiss button, and a 5 s timeout.
- **Loading + honesty (web)** — Analytics skeleton blocks + `aria-busy` +
  error Retry; Expenses summary respects the category filter; Data Hub
  exports show per-dataset progress with independent import busy state.
- **Logout confirmation** — web asks "Log out \<name\>?" with session
  validation (no-op when already logged out); mobile shows the pending
  offline-queue count in the dialog before signing out.
- **Logout that actually logs out (mobile)** — sign-in/out is fully
  auth-state driven (`main.dart` home rebuilds from `AuthState`); the old
  `pushReplacement` that stranded the shell on top after sign-out is gone,
  and the sync timer stops on logout.
- **Readable receipt badges (mobile)** — MANUAL/OCR source chips and leading
  icons use theme-system colors (`onSurfaceVariant` /
  `surfaceContainerHighest`, white on solid amber) instead of fixed greys —
  legible in light and dark mode (`screens/receipts_screen.dart`).
- **Crash-proof lists (mobile)** — History/Receipts loaders guard
  post-`await` `setState` with `mounted`, fixing the dispose race seen in
  device logs.
- **Recoverable error screens (web)** — every `ErrorBoundary` fallback
  (app-level "System Error" included) now has a Retry button, so a single
  transient render error can never latch the screen until a manual refresh.
- **Deeper analytics (all three families)** — descriptive: peak-hour heatmap
  (`/analytics/hourly`), basket analysis with flavor pairs + VOID rate
  (`/analytics/basket`), cost-burn strip; predictive: 7-day revenue forecast
  reusing the deseasonalized-MA engine (`/analytics/sales-forecast`),
  dated stockout alerts inside reorder suggestions; prescriptive: 3-day prep
  quantities + noisy/silent threshold calibration with one-click apply
  (`/reorders/prep`, `PATCH /inventory/items/:id`). Analytics page
  restructured: takeaway chips on top, numbered sections, fixed axes/legends,
  donut center totals, rich forecast empties (see `docs/api-contract.md`).
