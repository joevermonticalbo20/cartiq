# CartIQ Mobile POS - Staff & Owner Guide

## Getting started
1. Start the API on the office PC: `cd api && npm run dev`
2. Launch the app (`flutter run`). Android emulator tip: it reaches the PC via
   `10.0.2.2` (see `lib/config.dart`); physical phones use the PC's LAN IP.
3. Log in with the account assigned to your cart.

## Recording a sale
1. Tap a product tile (e.g. Flavored Fries).
2. Choose the flavor and quantity, then **Add to order**.
3. Collect cash, then tap **View order > Mark Paid - Record Sale**.
4. Green banner = synced to the owner's dashboard. Orange banner = saved
   offline; it uploads automatically when the cart has internet (or tap the
   sync icon at closing time via phone hotspot).

**Offline work is normal here** - no internet at the canteen is expected. The
orange queue badge shows how many records are waiting. Records survive app
restarts and are never duplicated when they sync (each sale carries a unique ID).

## Recording an expense (receipt scan)
1. Tap the receipt icon in the top bar.
2. **Camera / Gallery** scans the vendor receipt on-device (ML Kit). The
   vendor, amount, and date fields auto-fill.
3. Check the fields, pick the cart, then **Save expense (OCR)**.
4. No camera on this device? Fill the form and use **Save as manual entry**.

## Shift logging (RFID)
Tap your RFID card on the white node box when you start and end your shift.
The owner sees duty hours per cart automatically - no notebook needed.

## Stock checks
Ask the owner for dashboard access, or check the stock screen on the POS -
sensor items (LPG tank, cheese powder) show live weights from the load cell.

## FAQ
- **Sync failed?** The server may be off. Your sales are safe in the queue.
- **Wrong flavor tapped?** Use +/- in the order sheet to remove lines before paying.
- **Card not recognized?** Ask the owner to register your card UID.
