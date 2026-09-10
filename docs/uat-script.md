# CartIQ User Acceptance Test Script
## Supervised Parallel-Run Pilot - CART-01 (LSPU Main Canteen)

Per the approved proposal, the system runs **alongside the existing paper
process at one pilot cart**. No production deployment. Each session below is
one business day; the owner validates results against the paper records.

**Client:** John Louie Bornillo  |  **Team:** Monticalbo & Romana, BSIT BA3B

| UAT # | Scenario | Steps | Expected result | Pass/Fail |
|---|---|---|---|---|
| UAT-01 | Staff login | Open POS app, log in as `staff01` / `staff123` | Redirects to POS screen showing assigned cart CART-01 | |
| UAT-02 | RFID shift start | Tap staff RFID card on the ESP32 node at shift start | Dashboard > Staff on shift shows the staff member "ON SHIFT" with time | |
| UAT-03 | Cash sale (online) | With Wi-Fi available: record 2x Cheese Fries, Mark Paid | Sale appears on web dashboard within seconds; inventory deducts (pouches -1, frozen packs -0.05, cheese powder -0.03 kg per unit) | |
| UAT-04 | Offline sale queue | Turn off cart connectivity; record another sale | App confirms record is queued; dashboard does NOT yet show it; app restart keeps the queued record | |
| UAT-05 | Offline sync on reconnect | Restore connectivity, tap Sync icon in app | Queued sale uploads; dashboard shows it with correct time and totals; no duplicate after repeated sync taps | |
| UAT-06 | Sensor stock monitoring | Observe load-cell readings during the day (or run `iot/simulator.mjs --drain --interval 2000`) | Inventory panel shows live kg for LPG Tank / Cheese Powder; sparkline updates | |
| UAT-07 | Low-stock alert | Let any sensor item cross its threshold | Alert appears in feed exactly once; owner marks read | |
| UAT-08 | Reorder suggestion | Review Analytics > reorder suggestions for CART-01 | Items within supplier lead time flagged IMMEDIATE with suggested quantities | |
| UAT-09 | Receipt OCR expense | Photograph a vendor receipt in the app; review fields; save | Expense recorded with source OCR; fields match receipt; visible in Expenses panel | |
| UAT-10 | Manual expense fallback | Record an expense manually on Windows/web flow | Saved as MANUAL source | |
| UAT-11 | Daily reconciliation | End of day: compare dashboard daily report vs paper notebook | Totals match paper records (parallel-run check); discrepancies explainable | |
| UAT-12 | Excel export | Export sales for current month (.xlsx) | File opens in Excel; line items and summary totals match dashboard | |
| UAT-13 | Bulk import preview+commit | Import product workbook with one bad row, then corrected file | Bad row blocked with reason; clean file commits only valid products | |
| UAT-14 | Role security | Log in as staff01; attempt alert mark-read / product import | Both denied (403); owner account succeeds | |
| UAT-15 | Unknown RFID card | Tap an unregistered card | Shift logged but flagged UNREGISTERED; UNKNOWN_CARD alert created | |

### Sign-off

| Session date | Scenarios passed | Issues noted | Owner signature |
|---|---|---|---|
| | /15 | | |
| | /15 | | |
| | /15 | | |

Acceptance criteria (from proposal success indicators): >=80% of scenarios pass
per session; unnotified stockout incidents during pilot weeks reduced vs paper
baseline; forecast MAPE tracked weekly against the 15-20% target.
