# CartIQ API Contract (Phase 0 baseline)

Base URL: `http://127.0.0.1:4000/api` (localhost-only during development)
Auth: short-lived JWT (15min) from `POST /api/auth/login` + rotating 30d refresh
(`POST /api/auth/refresh`, revoke via `POST /api/auth/logout`). All day
boundaries are Asia/Manila. Alert dedupe is by structured `dedupeKey`
(`low:<locationId>:<itemId>` / `unknown:<locationId>:<uid>`), not message text.

## Phase 0 - implemented

| Endpoint | Method | Body / Params | Response |
|---|---|---|---|
| `/auth/login` | POST | `{username, password}` (20/15min/IP) | `{token(15min), refreshToken(30d), user}` |
| `/auth/refresh` | POST | `{refreshToken}` (60/15min/IP, rotation, rejects disabled accounts) | `{token, refreshToken, user}` |
| `/auth/logout` | POST | `{refreshToken?}` idempotent | `{loggedOut:true}` |
| `/auth/me` | GET | Bearer token | `{user}` |
| `/health` | GET | - | `{ok, service, version, uptimeSec, db, time}` — 503 when the DB is unreachable. |
| `/secure-ping` | GET | Bearer token | `{pong, user}` |

## Phase 1 - core platform (IMPLEMENTED)

| Endpoint | Method | Notes |
|---|---|---|
| `/orders` | POST | `{clientRef, locationCode|locationId, items[{productName, flavor, qty 1-100, unitPrice 0-10000}]}` max 100 items — missing location → 400 (never books to a wrong cart); `total` is recomputed server-side (client value ignored). `clientRef` dedupes offline replays (`duplicate:true` + original order). Deducts ingredients via `IngredientMap` recipes inside a transaction (with contention retry); raises `LOW_STOCK` alerts on threshold crossings (structured key); returns `warnings[]` for missing inventory rows. Rate-limited 120/min/IP. |
| `/orders?location_code&date&limit` | GET | Recent orders incl. items, location, staff. `date` is a Manila calendar day. |
| `/orders/:id` | PATCH | OWNER `{status:"VOID", reason?}` — flips to VOID **and auto-restores** recipe stock + writes `stockAdjustment` audit rows; missing rows go to `warnings[]`. Set `VOID_RESTORE=false` to keep record-only. Returns `{order, restored[], warnings[]}`. |
| `/inventory` / `/inventory?code=` | GET | Grouped per location; each item gains computed `status`: `ok` / `low` (≤ threshold) / `critical` (≤ threshold/2). |
| `/inventory/items` | POST | Add a stock row `{locationCode\|locationId, name*, unit?, stock? 0-100000, threshold? 0-100000, source?}` — 404 unknown cart, 409 duplicate name, 201 `{item, locationCode}`. Extra `category` field is ignored (no backing field). |
| `/inventory/adjustments` | POST | Manual count correction `{inventoryItemId, newStock 0-100000, reason}` (auth required; reason required for STAFF); creates an alert if the result is below threshold. |
| `/inventory/adjustments` | POST | Manual count correction `{inventoryItemId, newStock, reason}` (auth required); creates an alert if the result is below threshold. |
| `/inventory/items/:id` | PATCH | Threshold update `{threshold 0-100000}` — apply target for threshold calibration. |
| `/catalog` | GET | Products with flavors + active locations (POS bootstrap payload). |
| `/alerts?unread_only=true&limit` | GET | Alert feed, newest first. |
| `/alerts/:id/read` | PATCH | OWNER-only mark-read. |
| `/alerts/read` | PATCH | OWNER-only mark-all-read (`{ids?[]}` optional subset, omits to clear all unread; returns `{updated}`). Dashboard Stock alerts panel exposes it as “Mark all read”. |
| `/reports/daily?date&code` | GET | `{total_sales, orders, top_items[5]}` for one cart or ALL. |

## Phase 2 - IoT (IMPLEMENTED - hardware pending, use `iot/simulator.mjs`)

Device auth: ESP32 nodes authenticate with per-node bearer tokens
(bcrypt-hashed in the `Device` table; dev tokens printed by `db:seed`).
Sensor stock updates share the same threshold-alert rules as POS orders.
Channel mapping: `LPG_TANK` → `LPG Tank` row, `CHEESE_BIN` → `Cheese Powder` row
(source becomes `SENSOR`). Firmware uploads FIFO; `ts` omitted when NTP unsynced.

| Endpoint | Method | Notes |
|---|---|---|
| `/iot/readings` | POST | Device auth. `{cart_id?, device_id?, readings:[{channel:"LPG_TANK"\|"CHEESE_BIN", kg 0-1000, ts?}]}` max 200 — `cart_id` mismatch → 400; stale `ts` older than current stock (>60s tolerance) is stored but rejected from stock mirror; mirrors kg into the matching inventory row, fires deduped LOW_STOCK alerts (structured key). |
| `/shifts` | POST | Device auth. `{cart_id?, device_id?, events:[{staff_uid, event:"IN"\|"OUT", ts?}]}` max 200 — `cart_id` mismatch → 400; matches UID to staff via `User.rfidUid`; unknown cards raise UNKNOWN_CARD alerts (structured key) but are still logged. |
| `/staff/on-shift` | GET | Latest event per person per cart today; `IN` = currently on shift; unregistered cards flagged. Includes last 20 events. |
| `/readings/recent?code&channel&limit` | GET | Ascending series for dashboard charts. |

Test: `node scripts/phase2_test.mjs` against a running API (11 checks).

## Phase 3 - analytics (IMPLEMENTED)

Practical/statistical tier per proposal: moving average + linear regression
with clamped weekday seasonal factors; backtested MAPE; reorder point =
avg daily demand x lead time + z(1.65) x sigma x sqrt(lead).
`MIN_DAYS_FOR_FORECAST = 14` - items below that report `data_sufficient:false`
with a reason (cold-start honesty). Demo history: `node scripts/seed_history.mjs`.

| Endpoint | Method | Notes |
|---|---|---|
| `/analytics/trends?days=28&code=` | GET | Descriptive: totals, by-weekday, by-location, top/slow items, daily series. |
| `/analytics/hourly?days=28&code=` | GET | Descriptive: 7x24 `{dow, hour, orders, total_sales}` matrix + peak cell + daypart rollup (morning/lunch/afternoon/evening). Powers the rush-hour heatmap. |
| `/analytics/basket?days=28&code=` | GET | Descriptive: avg units/lines per ticket, VOID count + rate, top-5 flavor pairs with attach rate. |
| `/analytics/forecast?code=&horizon=7` | GET | Predictive: per-item `avg_daily_use`, 7-day series, depletion date/days, risk (`high/medium/low`), backtest `mape_pct`. Recipe-tracked items use order history; SENSOR items use reading slope. |
| `/analytics/sales-forecast?days=28&code=&horizon=7` | GET | Predictive: same deseasonalized MA + trend engine applied to daily revenue (`forecast[].expected_use`), shared 14-day cold-start gate, backtest MAPE. |
| `/reorders/suggestions?code=` | GET | Prescriptive: safety stock, reorder point, suggested qty over review cycle, urgency (`immediate/this_week/ok/manual_check`) with human-readable reasons. Now also `depletion_days/date` per item plus an `alerts[]` attention queue ("Cheese runs out Fri"). |
| `/reorders/prep?code=&days=3` | GET | Prescriptive: per-item expected use + prep qty for the next N days (trailing avg x weekday factors) with shortfall vs stock, plus `calibration[]` (`noisy`/`silent` thresholds with one-click `suggested_threshold`). |
| `/inventory/items/:id` | PATCH | `{threshold}` (non-negative) - apply target for threshold calibration. |
| `/analytics/staff-performance?days=28` | GET | Per-staff rollup: orders, total_sales, avg_ticket, shifts_in/out, shifts_completed. Sorted by total_sales desc. |

Test: `node scripts/phase3_test.mjs` (19 checks incl. seasonality detection).

## Phase 4 - OCR expenses & Excel (IMPLEMENTED)

OCR runs on-device via Google ML Kit (mobile, Android/iOS; Windows build shows a
manual-entry fallback). Excel uses ExcelJS server-side: real .xlsx workbooks,
import with mandatory preview + row-level validation before commit (OWNER only).

| Endpoint | Method | Notes |
|---|---|---|
| `/expenses` | POST | `{vendor, locationCode?, amount, date?, source:"OCR"\|"MANUAL", note?, lines?[]}` |
| `/expenses?code&month&limit` | GET | List + totals + top-vendor breakdown for period. |
| `/expenses/:id` | PATCH/DELETE | Correct OCR-parsed fields; delete is OWNER-only. |
| `/export/:dataset?month=YYYY-MM` | GET | `sales` (line items + summary sheets), `inventory`, `expenses`, `shifts` as streamed .xlsx downloads. |
| `/import/products?dry_run=` | POST | Multipart `file` (5MB, max 2000 rows, 20/hour/IP). Columns: name*, category, basePrice*, flavors ("A;B"). Returns `{rows_total, valid_count, errors[{row,reason}]}`; commit blocked until zero errors; auto-creates missing flavors. |

Tests: `node scripts/phase4_test.mjs` (20 checks incl. import round-trip).

## Phase 5 - platform hardening & UI revamp (IMPLEMENTED)

List endpoints (`/orders`, `/alerts`, `/expenses`) now return the shared
envelope `{ data:[...], meta:{ total, page, pageSize, totalPages } }`.

| Endpoint | Method | Notes |
|---|---|---|
| `/shifts/history?code&date&page&pageSize` | GET | Paged RFID shift log. |
| `/devices` | GET | OWNER-only IoT registry: device_id, cart, active, last_seen_at, computed `online` (<5 min heartbeat). |
| `/auth/change-password` | POST | Self-service: verifies current password, min 6 new chars. |
| `/auth/staff` | GET | OWNER-only staff list incl. location, rfidUid, active. |
| `/auth/staff` | POST | OWNER creates STAFF account (unique username, optional RFID UID + cart). |
| `/auth/staff/:id` | PATCH | OWNER enables/disables account, resets password, reassigns cart/RFID. Disabled accounts are rejected at login. |

Web UI rebuilt as a multi-page app shell: collapsible sidebar (Dashboard,
Sales, Inventory, Staff & Shifts, Analytics, Expenses, Data Hub, Settings),
nested routes with per-module URLs, toast notifications, confirm dialogs,
skeleton loaders, table filters and client pagination against the meta
envelope.
Test: `node scripts/phase5_test.mjs` (23 checks).
