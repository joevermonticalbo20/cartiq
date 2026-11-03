# CartIQ API Contract

Base URLs:

  - local      `http://127.0.0.1:4000/api` - the Express copy in `api/`, emulator-backed
  - production `https://ezynbxzarxozzmwqdjxs.supabase.co/functions/v1/api` -
    the Deno Edge Function in `supabase/functions/api/`

Both serve the same routes. `node scripts/check_api_parity.mjs` reads the
routes out of both and out of the callers (web/src, mobile/lib) and fails CI
when an endpoint an app calls is missing from either copy - so local dev and
production cannot drift apart silently.

`GET /health` reports which build is live: `build`/`commit` are the deployed
commit SHA and `builtAt` is the deploy time, stamped by the deploy workflow.
Compare them with `git rev-parse HEAD` instead of assuming the last push is
what is running.

## Phase 0 - implemented

| Endpoint | Method | Body / Params | Response |
|---|---|---|---|
| `/auth/login` | POST | `{username, password}` — five failed passwords are allowed; the fifth arms a **5-minute per-username lock** stored in Firestore (IP-independent, so rotating IPs or another device cannot buy extra guesses). Every attempt during the lock, even with the right password, is rejected. A 60/15min per-IP spray guard is checked after the lock so retrying a locked account cannot extend its wait. A successful login clears the failure run | `{token(15min), refreshToken(30d), user}`; `401 {error:"Invalid credentials", attemptsRemaining, lockedUntil?, retryAfterSeconds?}`; `429 {error, code:"LOGIN_LOCKED", retryAfterSeconds, lockedUntil}` with `Retry-After`; or `429 {error, code:"LOGIN_RATE_LIMITED"}` for the IP spray guard |
| `/auth/refresh` | POST | `{refreshToken}` (60/15min/IP, rotation, rejects disabled accounts) | `{token, refreshToken, user}` |
| `/auth/logout` | POST | `{refreshToken?}` idempotent | `{loggedOut:true}` |
| `/auth/forgot-password` | POST | `{email}` — emails a 6-digit OTP (10-min, single-use). Generic success whether or not the address is registered (5/hr per IP+email; silent 60s resend cooldown). A stored `@cartiq.local` placeholder is not deliverable; the owner must set a real inbox in Settings | `{success:true, message}` |
| `/auth/reset-password` | POST | `{email, code, newPassword 6-72}` — identical `Invalid or expired code.` for every failure mode; success sets the password + revokes all sessions (20/hr per IP, 5 code attempts max) | `{updated:true, sessionsRevoked:true}` |
| `/auth/verify-reset-code` | POST | `{email, code}` — confirms a code WITHOUT consuming it (redemption still once-only in reset); wrong guesses share the same 5-attempt cap + `reset:` rate budget | `{valid:true}` |
| `/auth/change-password/otp` | POST | Bearer token. Sends a separate 6-digit `change` code to the signed-in account's real recovery email (10-min, 60s resend cooldown). Returns 400 with an add-email hint when the profile has no real inbox | `{sent:true, email:"o***@example.com", expiresInMinutes:10, message}` or `{sent:true, cooldown:true, retryAfterMs, ...}` |
| `/auth/change-password` | POST | Bearer `{currentPassword, newPassword 6-72, code}` — the email code is mandatory second factor. Omitting `code` returns an app-update hint for older builds. Success revokes every session + all outstanding codes | `{updated:true, sessionsRevoked:true}` |
| `/auth/me` | PATCH | Bearer `{email, currentPassword}` — edits your own recovery email. The current password is required; `@cartiq.local` placeholders are rejected; changing it invalidates codes sent to the old address | `{user}` |
| `/auth/gmail-status` | GET | OWNER-only alias diagnostics: provider, secret presence booleans + live Gmail token-exchange check, never secret values | `{provider, allowed, configured, present:{...}, exchange:"ok"\|"failed"\|"skipped", error?}` |
| `/auth/email-status` | GET | Provider-neutral alias of `/auth/gmail-status` | same response |
| `/auth/me` | GET | Bearer token | `{user}` |
| `/health` | GET | No auth. `isHealthPath` matches any path ending in `/health`, so `/health` and `/api/health` both answer. | `{ok, service, via, version, build, commit, builtAt, uptimeSec, checks:{db,env}, time, latencyMs}` - `build`/`commit` are the deployed commit SHA; 503 when the DB is unreachable. |
| `/secure-ping` | GET | Bearer token | `{pong, user}` |

Email OTP policy: 6 digits, 10-minute TTL, single use, 5 wrong attempts, 60-second
resend cooldown, SHA-256 hash only. Reset and change codes live in the same
`passwordResets` collection and are isolated by `purpose`; documents written
before the field existed count as `reset`. A signed-in change needs BOTH the
current password and a `change` code. A profile with a `@cartiq.local`
placeholder shows it in the UI but the Gmail sender skips it; the owner must set
a real recovery address first. The web/mobile apps from before this change have
no code field, so `/auth/change-password` returns the update hint instead of
silently changing the password.

## Phase 1 - core platform (IMPLEMENTED)

| Endpoint | Method | Notes |
|---|---|---|
| `/orders` | POST | `{clientRef, locationCode|locationId, items[{productName, flavor, qty 1-100, unitPrice 0-10000, flavorShares?[]}]}` max 100 items — `flavorShares` is for one-price mixed-flavor lines and accepts 2-3 unique `{flavor, share}` rows whose positive shares total 1; recipe usage is multiplied by each share on sale, void restore, and forecasts. Missing location → 400 (never books to a wrong cart); `total` is recomputed server-side (client value ignored). `clientRef` dedupes offline replays (`duplicate:true` + original order). Deducts ingredients via `IngredientMap` recipes inside a transaction (with contention retry); raises `LOW_STOCK` alerts on threshold crossings (structured key); returns `warnings[]` for missing inventory rows. Rate-limited 120/min/IP. |
| `/orders?location_code&date&limit` | GET | Recent orders incl. items, location, staff. `date` is a Manila calendar day. |
| `/orders/:id` | PATCH | OWNER `{status:"VOID", reason?}` - flips to VOID **and auto-restores** recipe stock + writes `stockAdjustment` audit rows; missing rows go to `warnings[]`. Restore planning is one shared pure helper (`planVoidRestores`, `api/src/services/inventory_rules.js`) mirrored verbatim in the Edge Function. `warnings[]` is therefore never silently empty: a line whose recipe matches **nothing** (the product was renamed after the sale, since `PATCH /products/:id/rename` rewrites `ingredientMaps` while past orders keep the old name) reports `no recipe matched ... stock NOT restored`; a **flavoured** line that falls back to a generic `""` recipe on a product that does have flavoured recipes reports `only the generic recipe matched ...` because the deduction used the flavour amount while the restore uses the generic one. Both mean stock was NOT fully restored - surface them. Set `VOID_RESTORE=false` to keep record-only. Returns `{order, restored[], warnings[]}`. `{paymentMethod: CASH\|GCASH\|CARD}` - corrects payment on a PAID order (stock untouched, VOID rows rejected). |
| `/inventory` / `/inventory?code=` | GET | Grouped per location; each item gains computed `status`: `ok` / `low` (≤ threshold) / `critical` (≤ threshold/2), plus `isOutOfStock` (`true` when stock ≤ 0). |
| `/inventory/items` | POST | Add a stock row `{locationCode\|locationId, name*, unit?, stock? 0-100000, threshold? 0-100000, source?}` — 404 unknown cart, 409 duplicate name, 201 `{item, locationCode}`. Extra `category` field is ignored (no backing field). |
| `/inventory/adjustments` | POST | Manual count correction `{inventoryItemId, newStock 0-100000, reason}` (auth required; reason required for STAFF); creates an alert if the result is below threshold. |
| `/inventory/items/:id` | PATCH | Threshold update `{threshold 0-100000}` — apply target for threshold calibration. |
| `/inventory/names` | GET | Distinct stock item names (+ most common unit) across carts — feeds the Products recipe picker (deduction matches by exact name). |

### Carts & catalog (IMPLEMENTED)

| Endpoint | Method | Notes |
|---|---|---|
| `/locations` | GET | OWNER cart registry: every cart incl. INACTIVE, with item counts + node online status. |
| `/locations` | POST | OWNER `{code*, name*, address?, seedInventory?=true}` — code `A-Z0-9-` 3-12 chars (unique→409); provisions location + starter inventory + ESP32 device. Returns `{location, items, device, deviceToken}` — token shown **once** (hashed at rest). 20/hour/IP. |
| `/locations/:id` | PATCH | OWNER `{name?, address?, status?}` — rename/address; `ACTIVE\|INACTIVE` (code immutable). INACTIVE hides the cart from `/catalog`/POS but keeps history. |
| `/products` | GET | Products with per-flavor `unitPrice` (absolute, falls back to `basePrice`), per-flavor `recipeCount`, `recipes[]`, `missingItems[]` (recipe items with no stock row anywhere — sales warn instead of deducting), `flavorPrices` overrides, `imageUrl` (absolute photo or null), + recipe/order-line counts (delete safety info). |
| `/products` | POST | OWNER `{name*, category?, basePrice*, flavorIds?[], flavors?[], imageUrl?}` — unique name→409. `flavors[]` rows: `{flavorId? \| name?, unitPrice?, recipes?[{itemName*, amountPerUnit*}]}`; unknown names auto-created (max 20); bad price/recipe row→400; `imageUrl` is an absolute URL (empty/omitted = no photo). Returns `{product, flavorsCreated, recipesCreated, unmatchedItems[]}` (recipe items with no stock row — warn, don't block). |
| `/products/:id` | PATCH | OWNER `{category?, basePrice?, active?, addFlavorIds?, removeFlavorIds?, flavorPrices?{[name]: price \| null}, addRecipes?[], removeRecipes?[], imageUrl?}` — price affects future sales only. Removing a flavor with recipe rows→409; `null` price clears the override; `imageUrl: null` (or empty) clears the photo. Returns `{product, recipesChanged, unmatchedItems[]}`. |
| `/products/:id/rename` | PATCH | OWNER `{name*}` — atomic rename + recipe rewrite; past orders keep the old name. |
| `/products/:id` | DELETE | OWNER — 409 with counts while order lines/recipes reference it; else deletes. |
| `/flavors` | GET/POST | List (any auth) / create OWNER (unique→409). |
| `/flavors/:id` | PATCH | OWNER `{name*}` — atomic rename rewriting recipe rows + per-flavor price keys. Returns `{flavor, mapsUpdated, pricesRewritten}`. |
| `/flavors/:id` | DELETE | OWNER — 409 while products link it or recipe rows reference it; else deletes. |
| `/catalog` | GET | Products with flavors + active locations (POS bootstrap payload). Products and each flavor include `isAvailable` (boolean), `availableServings` (integer), and `limitingIngredient` (string); each flavor also includes `unitPrice` (absolute, falls back to `basePrice`) and `hasCustomPrice`, and each product includes `imageUrl` (absolute photo or null). Availability is computed from recipe maps resolved with the same generic/flavor precedence as order deductions, against the signed-in staff cart's inventory (OWNER defaults to the first active cart). Missing recipe inventory counts as zero; house recipe defaults are used when no recipe map exists. Product-level availability is true when at least one flavor is available; `availableServings` reflects the flavor with the most servings available. |
| `/inventory/restock-requests` | GET | Active requests for the signed-in staff member's cart; OWNER may pass `?code=` to scope a cart or omit it for all carts. Returns `{data:[{id, ingredientId, ingredientName, locationId, locationCode, urgency, notes, requestedBy, requestedByName, status}]}`. |
| `/inventory/restock-request` | POST | STAFF requests apply to the assigned cart; OWNER may pass `locationCode`. Body `{ingredientId, urgency?, notes?}` for one item, or `{allLowStock:true, urgency?, notes?}` for all items at or below threshold. `urgency` is `normal\|urgent\|critical`; notes are optional, max 500 characters. At most one active (`pending` or `acknowledged`) request exists per cart and ingredient; duplicates return the existing request in `activeRequests`. Success returns `{data, activeRequests, skipped}`. |
| `/alerts/restock-requests?code&active` | GET | OWNER-only web queue; active requests by default. Set `active=false` to include fulfilled/dismissed history. |
| `/alerts/:id/restock-status` | PATCH | OWNER-only `{status:"acknowledged"}` to acknowledge or `{status:"fulfilled", resolution:"restocked"\|"dismissed"}` to close the request cooldown. Emits `restock-request:updated` on the live stream. New requests emit `restock-request:new`; Edge Function streams poll alerts and may deliver within 15 seconds. |
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
| `/shifts/manual` | POST | OWNER user-JWT (never device token). Manager correction for a missed tap: `{staffId, locationCode, event:"IN"\|"OUT", ts?}` → 201 `{shift}` (`deviceId:"MANUAL"`). Powers the dashboard Manual Shift Entry. |
| `/staff/on-shift` | GET | Latest event per person per cart today; `IN` = currently on shift; unregistered cards flagged. Includes last 20 events. |
| `/readings/recent?code&channel&limit` | GET | Ascending series for dashboard charts. |

Test: `node api/scripts/phase2_test.mjs` against a running API (14 checks).

## Phase 3 - analytics (IMPLEMENTED)

Practical/statistical tier per proposal: moving average + linear regression
with clamped weekday seasonal factors; backtested sMAPE (symmetric MAPE,
bounded 0-200 by construction — classic MAPE explodes on low-volume days);
reorder point = avg daily demand x lead time + z(1.65) x sigma x sqrt(lead).
`MIN_DAYS_FOR_FORECAST = 14` - items below that report `data_sufficient:false`
Demo history: `node api/scripts/seed_history.mjs`.

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

Test: `node api/scripts/phase3_test.mjs` (19 checks incl. seasonality detection).

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

Tests: `node api/scripts/phase4_test.mjs` (20 checks incl. import round-trip).

## Phase 5 - platform hardening & UI revamp (IMPLEMENTED)

List endpoints (`/orders`, `/alerts`, `/expenses`) now return the shared
envelope `{ data:[...], meta:{ total, page, pageSize, totalPages } }`.

| Endpoint | Method | Notes |
|---|---|---|
| `/shifts/history?code&date&page&pageSize` | GET | Paged RFID shift log (Manila day for `date`). |
| `/shifts/:id` | PATCH | OWNER user-JWT. Correct a row: `{event?, locationCode?, ts?}` (at least one; staff identity immutable) → `{shift}`. Powers Edit Shift Log. |
| `/shifts/:id` | DELETE | OWNER user-JWT. Remove a mis-logged row → `{deleted:true}`. |
| `/devices` | GET | OWNER-only IoT registry: device_id, cart, active, last_seen_at, computed `online` (<5 min heartbeat). |
| `/auth/change-password` | POST | Self-service: verifies current password + the 6-digit code emailed to the recovery address, min 6 new chars; success revokes all sessions/codes. |
| `/auth/staff` | GET | OWNER-only staff list incl. location, rfidUid, active, recovery email. |
| `/auth/staff` | POST | OWNER creates STAFF account (unique username, optional RFID UID + cart + recovery email for password reset). |
| `/auth/staff/:id` | PATCH | OWNER enables/disables account, resets password, reassigns cart/RFID/email (unique address, empty clears). Disabled accounts are rejected at login. A password reset revokes sessions + codes; an email change revokes codes. Your OWN password/email must go through Settings (`/auth/change-password`, `PATCH /auth/me`) so the email code/current password is enforced. |

Web UI rebuilt as a multi-page app shell: collapsible sidebar (Dashboard,
Sales, Inventory, Staff & Shifts, Analytics, Expenses, Import & Export, Settings),
nested routes with per-module URLs, toast notifications, confirm dialogs,
skeleton loaders, table filters and client pagination against the meta
envelope.
Test: `node api/scripts/phase5_test.mjs` (34 checks).


## Phase 6-9 - after the pilot (IMPLEMENTED)

Endpoints added after the Phase 5 rewrite. Same auth model: Bearer JWT unless a row says otherwise.

| Endpoint | Method | Notes |
|---|---|---|
| `/auth/my-rfid` | GET | Self-service RFID: `{rfidUid}` (`null` when unbound). |
| `/auth/my-rfid/claim` | POST | Register a tag: `{locationCode?, event?}` -> 201 `{claim}`. STAFF may only register on their own cart (403); OWNER has no cart and must pass `locationCode` (400). `event` is `IN`/`OUT` to clock on or off with the tap, or omitted to enrol the card only. |
| `/auth/my-rfid/claim/:claimId` | GET | Poll a claim: `{claim}`. Unknown and someone else's claim both answer 404, so a claim id cannot be used to probe other people's registrations. |
| `/auth/my-rfid` | DELETE | Unbind your own tag: `{rfidUid:null, removed}`. Emits `rfid:unbound`. Reassigning somebody else's tag stays on `PATCH /auth/staff/:id`. |
| `/events/ticket` | POST | Bearer -> `{ticket, expiresAt}` (60s, at most 1000 live). `EventSource` cannot send headers, so the stream uses a short ticket instead of putting the JWT in a URL. |
| `/events` | GET | SSE stream, `?ticket=` from the call above (Bearer also accepted). Sends `connected`, then order/alert/restock/RFID events, with a `: heartbeat` every 25s. |
| `/analytics/profit?days=30&code=` | GET | OWNER. Revenue against expenses: `{revenue, total_expenses, gross_profit, margin_pct, order_count, expense_count, expenses_by_category[], daily_profit[]}`. |
| `/devices` | POST | OWNER `{deviceId*, cart?}` -> 201 `{device, deviceToken}`. The token is shown once and stored hashed. |
| `/devices/:id` | PATCH | OWNER `{cart?, active?}` - reassign the cart (empty or null clears it) and/or enable-disable the node. |
| `/devices/:id` | DELETE | OWNER -> `{deleted:true}`. Readings and shifts keep the device id as a plain string, so history survives. |
| `/alerts/:id/ack` | PATCH | Acknowledge an alert and record who (`ackedBy`, `ackedByName`) and when (`ackedAt`) -> `{alert}`. Different from `/read`, which only hides it. |
| `/inventory/items/:id` | DELETE | OWNER. 409 while the row is SENSOR-managed or referenced by recipe rows; else `{deleted:true}`. |

Integration scripts, run with `node api/scripts/<name>.mjs` against a seeded API or the emulator:

| Script | Covers | Checks |
|---|---|---|
| `phase2_test.mjs` | IoT readings + shifts | 14 |
| `phase3_test.mjs` | analytics + forecasting | 19 |
| `phase4_test.mjs` | OCR expenses + Excel export/import | 20 |
| `phase5_test.mjs` | paging, shifts, devices, staff admin | 34 |
| `phase6_test.mjs` | expense categories end-to-end | 13 |
| `phase7_test.mjs` | order VOID workflow + staff alert ack | 21 |
| `phase8_test.mjs` | cart provisioning + product catalog management | 53 |
| `phase9_low_stock_quota.mjs` | LOW_STOCK dedupe under load (free-tier read budget) | 11 |
| `test_authz_fix.mjs` | logout, 15min token, VOID restore, alert dedupeKey, cart_id mismatch, Manila boundaries | 24 |

Unit tests: `cd api && npm test` (`node --test test/*.test.js`).
