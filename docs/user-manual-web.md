# CartIQ Web Dashboard - Owner Guide

Open `http://localhost:5173` while the API runs (`cd api && npm run dev`) and
sign in as `owner` / `owner123`.

## What you see

### Top stat cards
- **API/DB** - system health, refreshes every 15 seconds.
- **Sales today** - total and order count across all carts (or the selected one).
- **Items low/critical** - supplies at or below their reorder thresholds.
- **Unread alerts** - events you have not acknowledged yet.

### Inventory by cart
Live stock per cart. Items sourced from the ESP32 load cells update by
themselves (LPG tank, cheese powder). LOW = at threshold, CRITICAL = half of
threshold or less.

### Staff on shift (RFID)
Who tapped IN at which cart and when. Unregistered cards are flagged so you can
register them.

### Alerts
Low-stock and unknown-card events. **Mark read** keeps the feed clean; unread
items count toward the header badge.

### Live sensor chart
Recent LPG-tank / cheese-bin weight readings from CART-01's node.

### Business analytics
- **Descriptive:** 28-day sales by weekday - spot your best days.
- **Predictive:** 7-day demand forecast per supply item, depletion date, risk
  flag, and MAPE accuracy (target: 15-20% once data matures).
- **Prescriptive:** smart reorder list sorted by urgency with suggested
  quantities and reasons ("projected depletion within supplier lead time").

> Forecasts activate after ~2 weeks of recorded sales. Until then the panel
> explains what is missing instead of guessing - that is intentional.

### Expenses
Receipts scanned in the mobile app land here with an OCR chip; manual entries
are tagged MANUAL. Totals and top vendors update per cart.

### Data management (Excel)
- **Export:** one-click .xlsx downloads - sales line items + summary,
  inventory snapshot, expenses, shifts - filtered by month.
- **Import products:** upload a workbook (columns: name, category, basePrice,
  flavors "Cheese;BBQ"). Preview validates every row; commit is blocked until
  all rows pass. New flavors are created automatically.

## Daily routine suggestion
1. Morning: check overnight low-stock alerts + reorder suggestions.
2. Midday: glance at staff-on-shift and live sales.
3. Closing: ask staff to hotspot-sync carts without Wi-Fi; review daily report;
   export weekly Excel backup every Friday.
