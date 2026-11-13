/**
 * The canonical list of server-sent event names.
 *
 * The server sends NAMED SSE frames (`event: <name>`, see
 * api/src/routes/events.js and the Edge copy in supabase/functions/api/index.ts).
 * A named frame is only delivered to listeners registered with
 * `addEventListener` - `es.onmessage` never sees it. So every name the app
 * subscribes to has to be registered on the connection, or that subscription
 * silently never fires.
 *
 * That is not hypothetical: the connection used to register only five names, so
 * restock requests, RFID card bindings and void decisions never arrived live
 * even though the server emitted them.
 *
 * Rule of thumb: a name that is missing here is a feature that never updates
 * live. Add it here AND to the `useLiveEvent(...)` call site.
 */
export const LIVE_EVENT_NAMES = Object.freeze([
  // Stream lifecycle.
  "connected",
  // Orders.
  "order:new",
  "order:updated",
  // Alerts (low stock, void decisions, restock status).
  "alert:new",
  // Staff on shift.
  "staff:on_shift",
  // IoT sensor readings.
  "sensor:reading",
  // Restock requests filed from the POS, and their resolution.
  "restock-request:new",
  "restock-request:updated",
  // RFID card binding changes (register / replace / unbind / conflict).
  "rfid:bound",
  "rfid:unbound",
  "rfid:conflict",
  // The catalog moved: a product, flavor, recipe, price or photo changed.
  "product:updated",
  // Stock rows moved: an item was added/edited/removed or adjusted by hand.
  "inventory:updated",
  // A card was tapped on the reader: a shift was recorded.
  "shift:new",
]);

/** Named constants for the call sites, so a typo cannot silently break a feed. */
export const LIVE_EVENTS = Object.freeze({
  orderNew: "order:new",
  orderUpdated: "order:updated",
  alertNew: "alert:new",
  restockRequestNew: "restock-request:new",
  restockRequestUpdated: "restock-request:updated",
  rfidBound: "rfid:bound",
  rfidUnbound: "rfid:unbound",
  rfidConflict: "rfid:conflict",
  productUpdated: "product:updated",
  inventoryUpdated: "inventory:updated",
  shiftNew: "shift:new",
});
