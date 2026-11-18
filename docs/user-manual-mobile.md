# CartIQ Mobile POS - Staff & Owner Guide

## Getting started
1. Start the API on the office PC: `cd api && npm run dev`
2. Launch the app (`flutter run`). Android emulator tip: it reaches the PC via
   `10.0.2.2` (see `lib/config.dart`); physical phones use the PC's LAN IP.
   If the server moved, use Rescan on the boot splash or Login → Server;
   a manually saved URL persists across restarts (see README "Mobile
   connectivity").
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

## Shift logging (two ways, one log)
1. **RFID Tap** - tap your registered RFID card on the white node box when you
   start and end your shift. With no card pending on the reader, the server
   reads your attendance for today and records the right action (Time in if you
   have not clocked in, Time out if you have, or a clear refusal when the
   shift is already complete).
2. **App Tap** - in Settings > Attendance, tap the **App Tap** button. Your
   signed-in account records the attendance and the server stamps the time;
   works only online.
The owner sees duty hours per cart automatically - no notebook needed. Rows
show how each tap was recorded (RFID, APP, or MANUAL). A tap while clocked in
books your time out - the two methods can never create a double session.

## Stock checks
Ask the owner for dashboard access, or check the stock screen on the POS -
sensor items (LPG tank, cheese powder) show live weights from the load cell.

## FAQ
- **Sync failed?** The server may be off. Your sales are safe in the queue.
- **Logged out at the canteen?** If you set an Offline PIN in Settings while
  online, you can still open the POS with no internet — tap **Continue
  offline**, enter the PIN; queued sales upload after the next online sign-in.
  The last known POS catalog, History and Receipts load from this device, so
  you can still sell and review sales offline.
- **Wrong flavor tapped?** Use +/- in the order sheet to remove lines before paying.
- **Card not recognized?** Ask the owner to register your card UID.
