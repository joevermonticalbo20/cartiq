# CartIQ

**Pota Fries CartIQ: An Integrated IoT-Enabled Business Analytics Platform for
Multi-Location Food Cart Operations**

SIA 2 & Mobile Application Development final project - Group 5, BSIT BA3B,
Laguna University. Status: **deployed live (see "Deployment" below)** —
Phases 0-8 + frontend UX polish P1-P4 + reliability/checkout/connectivity
sprints + Firestore migration + auth hardening I & II + cart provisioning +
products catalog + instant POS catalog sync + P0 stock-race fixes + rate-limit
+ device-registry + analytics Manila-unification + button/connection audit +
analytics refresh batch (section renames, scrollable tables, forecast
placeholders, cost-breakdown wording) + by-flavor products + honest
errors/loading pass complete, pending hardware pilot and faculty approval.

| Component | Path | Stack | Status |
|---|---|---|---|
| REST API | `api/` | Node.js 24, Express 5, Firestore (Spark free tier, via `api/src/firestore.js` data layer), typed JWT (access/refresh) + rotating refresh + revocation, staff cart scoping, login + endpoint rate limiting, ExcelJS, Bonjour/mDNS advertise | done, tested (30 unit + 174 integration checks in CI), **live on Render** |
| Web admin dashboard | `web/` | React 19, Vite, React Router, Axios | done, builds (lint 0 errors, 191 tests), **live on Firebase Hosting** |
| Mobile POS app | `mobile/` | Flutter (Android/Windows), offline-first sqflite queue, ML Kit OCR, shared-prod API default | done, analyzes clean, 67 tests; release APK in `mobile/build/app/outputs/flutter-apk/` |
| ESP32 IoT node | `iot/` | Arduino C++ firmware + **Node simulator** (`iot/simulator.mjs`) | code complete; hardware pending |

Live URLs: web dashboard `https://cartiq-8e46f.web.app` · API
`https://cartiq-api-aswt.onrender.com/api` (health: `.../api/health`) ·
database: Firestore Native `(default)` in project `cartiq-8e46f` (seeded).

## Environment files (for groupmates)

Secrets live in gitignored `.env` files — never commit them. Each folder has
a checked-in reference with the same keys and safe placeholder values:

| Folder | Copy | Purpose |
|---|---|---|
| `api/` | `api/.env.example` → `api/.env` | Emulator host (dev) or project + service-account key (prod), JWT secrets, `HOST`/`PORT`, `CORS_ORIGINS` |
| `web/` | `web/.env.example` → `web/.env` | Only needed to override `VITE_API_BASE` (default `/api` works for local dev; prod URL is baked at build time) |
| `mobile/` | `mobile/.env.example` (reference only) | Values to pass via `--dart-define=API_BASE_URL=...` or the in-app Server row — Flutter reads no `.env` file |
| `iot/firmware/` | `config.example.h` → `config.h` | Wi-Fi credentials, API URL, device token, cart IDs (all local-only) |

## Deployment (live)

```text
Firebase Hosting (web/dist) ──VITE_API_BASE──▶ Render (api/, npm start)
                                                      │
                                                      ▼
                                            Firestore (cartiq-8e46f)
                                                      ▲
Mobile POS ───────── API_BASE_URL (default) ──────────┘
```

* **Frontend:** `cd web && $env:VITE_API_BASE='https://cartiq-api-aswt.onrender.com/api'; npm run build`
  then `firebase deploy --only hosting --project cartiq-8e46f` (PowerShell: one line at a time).
  `VITE_API_BASE` is baked into `web/dist` at build time — building without it
  points the live site at `/api` (static hosting, no backend) and login fails.
  First login after idle is slow (Render free cold start, ~30-60s vs the 10s
  client timeout; login POSTs don't auto-retry) — retry once warm.
* **Backend:** auto-deploys on push to `main` (Render → Root Directory `api`, `npm ci` / `npm start`).
  Service env vars live in the Render dashboard, never in git (see `render.yaml` + `api/.env.example`).
* **Database:** seeded once (`npm run db:seed` against prod). Never run `seed_history` on prod;
  demo history stays on the emulator. Rules (`firestore.rules`) deny direct client access —
  everything goes through the API: `firebase deploy --only firestore:rules --project cartiq-8e46f`.
* **Free-tier notes:** Render sleeps after idle (~50s cold start; mobile/web retry once, POS queue covers
  sales); Firestore reads are cached server-side 60s to protect the 50k/day Spark quota
  (except `/catalog`, which is always-fresh so the POS never sells stale data).

## Quickstart (local development)

```bash
# 0) Firestore emulator (terminal 0, repo root - free, no credentials/quota)
firebase emulators:start --only firestore   # 127.0.0.1:8080

# 1) API  (terminal 1)
cd api
npm install
npm run db:seed        # users, locations, products, recipes, IoT device tokens (Firestore)
npm run dev            # http://127.0.0.1:4000/api/health

# 2) Web dashboard  (terminal 2)
cd web && npm install && npm run dev   # http://localhost:5173

# 3) Mobile POS  (terminal 3)
cd mobile && flutter pub get
flutter run   # default backend is the shared production API (same Firestore
              # database as the web dashboard) - just log in, no IP needed.
              # (see "Mobile connectivity")
# Local API instead (pick ONE, no other change needed):
#  - in-app: type the LAN URL on the boot splash or Login → Server row
#  - build-time: flutter run --dart-define=API_BASE_URL=http://192.168.100.217:4000/api
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

The mobile POS talks to the **shared production API by default**
(`https://cartiq-api-aswt.onrender.com/api` — the same Firestore database as
the web dashboard), so a fresh install just works: log in, no IP needed.
(It is not a browser, so it does not use the web `/api` proxy.)

**LAN auto-discovery is OFF by default** (`enableLanDiscovery = false` in
`mobile/lib/config.dart`) so the app can never silently attach to a
localhost/LAN dev server instead of the shared database. The sections below
describe the LAN machinery, which still works when you point the app at a
local API (in-app Server row) or re-enable discovery for an offline pilot.

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
| Physical phone (production default) | `https://cartiq-api-aswt.onrender.com/api` | internet; first tap after idle may time out once (Render free cold start — retry) |
| Physical Android phone (LAN auto-discovery) | _(discovered, only when `enableLanDiscovery = true`)_ | PC and phone on same Wi-Fi; API running with `HOST=0.0.0.0`; Windows Firewall allows TCP 4000 |
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
  DHCP change doesn't need a code edit. Production (Render dashboard) must
  list the hosted frontend:
  `CORS_ORIGINS="https://cartiq-8e46f.web.app,https://cartiq-8e46f.firebaseapp.com"`. Server exits at boot with
  `[api:fatal]` if `JWT_SECRET` is missing.
- **Orders are server-authoritative:** `POST /orders` requires
  `locationCode`/`locationId` (400 otherwise, never silently books to the
  first cart) and the `total` is recomputed from items — client totals are
  ignored. Replays with the same `clientRef` return `duplicate: true`.
- **Errors carry `correlationId`:** duplicate unique fields (P2002) → 409, missing records (P2025) → 404, 404s
  include an id — quote it when reporting a failure.
- **Auth:** 15-minute access JWT + rotating 30-day refresh tokens
  (`POST /auth/refresh`, `refreshTokens` collection) + `POST /auth/logout`
  revocation. Tokens carry `type: access|refresh` claims (HS256-pinned) so a
  refresh can never pass as API auth; rotation races return 401, not 404.
  Password change and staff disable revoke **all** refresh tokens; disabled
  accounts fail `requireAuth` within ~60s (cached). STAFF writes are scoped
  to their assigned cart (`POST /orders`, `/inventory/adjustments`,
  `/expenses` → 403 outside it; OWNERs bypass). Usernames trim on login;
  passwords capped at 72 bytes (bcrypt limit); self-deactivation blocked.
  Refresh rejects disabled accounts. Extra guards: `/auth/refresh` 60/15min,
  `/orders` 120/min, `/iot`+`/shifts` 300/min, `/events/ticket` 60/min,
  `/export` 30/hr, `/analytics`+`/reorders` 120/min, `/expenses` 60/min,
  `/auth/change-password` 10/hr, `/import` and `/locations` 20/hour
  (all in-memory, single-instance). Trust proxy is env-driven
  (`TRUST_PROXY`, auto-on when `NODE_ENV=production`) so per-IP buckets stay
  fair behind Render's proxy.
- **Manual shift tools (OWNER):** `POST /shifts/manual` (missed-tap correction),
  `PATCH /shifts/:id` (event/cart/time fix), `DELETE /shifts/:id`. The device
  `POST /shifts` stays device-token-only — user tokens there 401 by design.
- **Carts, catalog & devices (OWNER):** `POST /locations` provisions cart +
  starter inventory + ESP32 device with a shown-once token;
  `PATCH /locations/:id` renames or toggles `ACTIVE/INACTIVE` (code immutable,
  no hard delete). `POST /devices` registers a standalone node (one-shot
  token modal), `PATCH /devices/:id` reassigns cart/toggles active,
  `DELETE /devices/:id` unregisters (history keeps the deviceId string).
  `GET|POST /products`, `PATCH /products/:id`, rename (atomic recipe rewrite),
  guarded delete, `GET|POST /flavors`. `/catalog` is always-fresh (nocache)
  so POS pull-to-refresh shows adds/removes immediately.
- **Stock safety:** VOID re-checks order status inside the transaction
  (parallel double-VOID → 409, single restore only); inventory adjustments
  re-read stock inside the txn (audit `before` is exact, concurrent
  deductions survive via txn retry). Import rows are capped (name 120,
  category 60, price ≤ 10M, ≤ 20 flavors/row) so one hostile file can't burn
  the Firestore quota.
- **Analytics honesty (Manila):** every calendar operation (trend buckets,
  hourly matrix, forecast labels, prep calendar, depletion dates, month
  filters, export date/time labels) uses `api/src/services/timezone.js`
  (Asia/Manila, server-TZ independent). Forecast usage shares
  `mapsForOrderLine()` with the POS deduction so multi-ingredient products
  never undercount. Analytics UI offers trailing 7/14/30/90-day windows
  (no fake custom ranges); exports support month or explicit custom ranges.
- **LAN origins:** browser dashboard on a phone/laptop needs its origin in
  `CORS_ORIGINS` plus `HOST=0.0.0.0` and the Windows Firewall TCP 4000 rule.

## Testing

Automated suites (API must be running):

```bash
node scripts/phase2_test.mjs   # IoT pipeline - 14 checks
node scripts/phase3_test.mjs   # analytics     - 19 checks (needs seed_history first)
node scripts/phase4_test.mjs   # OCR + Excel   - 20 checks
node scripts/phase5_test.mjs   # hardening     - 33 checks (pagination/staff/password/devices/shifts)
node scripts/phase6_test.mjs   # categories    - 13 checks (expense buckets)
node scripts/phase7_test.mjs   # void workflow + ack + idempotency race - 21 checks
node scripts/phase8_test.mjs   # carts + products catalog - 33 checks
node scripts/test_authz_fix.mjs # logout/revoke, 15min tokens, VOID restore, devices, scoping - 21 checks
node --test test/*.test.js     # api unit tests (run inside api/) - 30 checks
flutter analyze                # mobile static analysis
flutter test                   # mobile unit tests - 67 checks (URL normalize, cart, receipt parser, sync, money/text input)
cd web && npm run lint && npm run test && npm run build  # web lint + 191 tests + production build
```

Regression totals: **153 phase checks + 21 authz checks + 30 api unit +
67 mobile + 191 web**, all runnable in CI (`api-ci.yml` runs the full
emulator-backed integration job: Java 21 → emulator → seed + 21-day
history → API → every suite). Run phase suites against the emulator only —
never prod; they write test data. (`@google-cloud/firestore` is pinned as a
direct dependency so CI installs it; same 9.1.0 library, no billing impact —
Spark plan untouched.)

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

- **Free-tier deployment (live):** web on Firebase Hosting, API on Render free
  (sleeps after idle, ~50s cold start; mobile/web retry once, POS queue covers
  sales), Firestore Spark with 60s server-side read caching (except the
  always-fresh POS catalog) to protect the 50k/day quota.
- **Supervised operation:** parallel-run at the carts; no online payments,
  payroll/tax accounting, or customer-facing ordering (per proposal scope).
- Single API instance: live SSE subscribers and the login rate-limit counter
  live in process memory, so don't scale past one instance without a shared
  bus/store.
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
- **Vitest test suite** — `npm run test` (191 unit tests covering error mapping, ErrorBox, by-flavor Products, api utils,
  money/text/qty input rules, DataTable, Select, ConfirmDialog, Pagination,
  EmptyState, PasswordStrengthMeter, Settings/DataHub flows, and custom
  hooks); `npm run lint`
  (ESLint + React plugin + react-hooks rules); `npm run coverage` (text +
  HTML coverage reports). CI-ready: fails build on test or lint errors.
- **GitHub Actions CI** — `web-ci.yml` (web lint + test + build),
  `api-ci.yml` (`npm ci` + unit tests + syntax check + full emulator-backed
  `integration` job: Java 21 → emulator → seed + history → API → phases
  2-8 + authz), and `mobile-ci.yml` (`flutter analyze` + `flutter test`)
  run on every push and PR touching their paths.
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
- **Dialog + toast a11y (web)** — `ConfirmDialog` is sticky by design
  (backdrop/Esc never dismiss; Cancel button only) with `role=dialog`,
  initial focus and focus trap/return; toasts have `role=status`/`alert`,
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
- **Auth hardening batch** — 15-minute access tokens, server-side logout
  revoke, disabled-account refresh rejection, no-logout-on-endpoint-401
  interceptor rule; demo credential removed from the login page.
- **Carts + Products UI** — Settings Carts section (add/deactivate/rename,
  shown-once device token with copy) and a Financial → Products page
  (create/edit/rename/delete with recipe/order safety counts, flavor
  management, Data Hub import link).
- **No-change honesty** — every edit modal detects untouched input and shows
  an info toast (`No changes — …`) instead of a fake success and a wasted
  API call (adjust stock, threshold, bulk, payment, expense, staff, shift).
- **Input rules everywhere** — money (7 digits + 2 decimals), stock counts
  (5 + 2), vendor/note (2 letters min, 40 max, single spaces), item names
  (2 letters min, 30 max); shared `utils/format.js` + `utils/text.js`
  (web, tested) and `utils/money_input.dart` + `utils/text_input.dart`
  (mobile, tested).
- **Shift tools that work** — Manual Shift Entry via OWNER endpoint (no more
  device-401 logout) with a live-ticking Exact Date & Time; shift edit/delete
  endpoints with minute-precision no-change check.
- **Smarter Select** — placeholder options hidden from the menu, and option
  clicks cancel label-forwarding so wrapping labels can't reopen the menu.
- **Honest edit modals** - Sales edit is payment-correction only (the API now
  accepts `{paymentMethod}`; the phantom Completed/Refunded status that always
  400'd is gone), and Inventory edit is threshold-only (name/unit/category
  have no backing fields and no longer pretend to save).
- **Instant POS catalog** — pull-to-refresh + resume auto-reload on the POS
  grid, always-fresh `/catalog`, and an `unknown product` sale warning when
  the cart holds a since-deleted item.
- **Double-submit guards** — `ConfirmDialog` takes `pending`/`pendingLabel`
  and disables both buttons; wired to void/bulk/delete/commit/password/
  staff/reset/disable/cart/device actions. Export failures parse the real
  server message out of the blob; custom export ranges validate inline.
- **Honest loading states** — Staff top sections and Settings owner tables
  show named error-boxes with Retry instead of fake-empty; dashboard cart
  filters use each endpoint's real param (`code` vs `location_code`).
- **Sensor panel (LPG-only)** — live LPG tank level + sparkline with 15s
  polling, kg bands, offline toast-once; cheese channel removed by design
  (backend recipe/sensor paths unchanged).
- **Brand + tab** — `CartIQ` title, rounded-corner favicons
  (`public/favicon-32/64.png`, `apple-touch-icon.png`), CartIQ + Pota Fries
  Operations branding on web sidebar, mobile login and boot splash.
- **POS sale safety (mobile)** — one-shot `_paying` guard (no duplicate
  charge), clear-order confirm, no-cart block before money moves, session-
  expired result message, background-refresh snackbars, scan→receipts
  auto-reload, 403 poison dropped distinctly, catalog refresh retry.
- **Release APK** — `flutter build apk --release` (prod API default);
  verify branding strings in the binary before handing to testers.
- **Analytics refresh batch** — renamed sections (Top Items → best-sellers,
  Inventory Forecast → Stock Predictions, Revenue Forecast → Expected Sales
  with a dimmed placeholder until 14 days of history), top-items/forecast
  tables capped with 300px scroll, category axis ticks, profit cost-burn
  wording (`₱1 → ¢` + biggest cost), Data Hub equal-height panels with
  bottom-pinned buttons, Expenses page size 8 → 50, empty states for
  no-inventory/no-products; follow-up fix restored sort `↓/↑` icons,
  `—`/`·` punctuation, the analytics fetch lint-suppress, and dropped the
  now-unused basket request.
- **By-flavor products** — Add/Edit product uses per-flavor rows (flavor
  picker + inline create, absolute per-flavor price defaulting to base,
  optional recipe lines with warn-don't-block when missing); table badges
  show custom prices + `no recipe` warnings. API: `POST/PATCH /products`
  accept `flavors[]`/`flavorPrices`/`addRecipes`/`removeRecipes`, flavor
  remove guarded by recipe rows (409), new `PATCH/DELETE /flavors/:id`
  (rename rewrites recipes + price keys atomically).
- **Honest errors + loading everywhere** — shared `getFriendlyError`
  (server 4xx verbatim, plain text for offline/403/5xx incl. Render
  cold-start hint) + `ErrorBox` (`role=alert` + Retry) on every page;
  `role=status` loading text on table pages; Settings owner tables show
  skeletons instead of false-empty states.
