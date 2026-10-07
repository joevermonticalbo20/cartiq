// Low-stock alert identity + dedupe.
//
// Mirrors supabase/functions/api/index.ts (lowStockAlertId /
// readOpenLowStockAlert). Keep both in sync.
//
// WHY THIS EXISTS
// Dedupe used to be "scan every LOW_STOCK alert ever created, then filter in
// code". Alerts are never deleted - acking only sets isRead - so that scan grew
// without bound and was paid on every sale and every IoT reading batch. At
// ~10k alerts it was the largest single consumer of the Firestore free-tier read
// budget (50k/day), enough that one sale could take a fifth of the day.
//
// A deterministic id turns "is there already an unresolved alert for this item?"
// into a single point read. Dedupe cost becomes O(items that crossed the
// threshold) instead of O(all alerts in the database's history).

/**
 * Deterministic document id for an item's open low-stock alert.
 * Byte-identical in meaning to the dedupeKey the old scan compared against.
 */
/**
 * The identity of "this item is low", used as an indexed field on the alert doc
 * and as the payload's dedupeKey.
 *
 * Deliberately NOT a document id. `alerts` is a numeric model and firestore.js
 * does `out.id = numeric ? Number(snap.id) : snap.id`, so a string doc name would
 * surface as NaN in every alert response and break ack/read by id.
 */
export function lowStockDedupeKey(locationId, inventoryItemId) {
  return `low:${locationId}:${inventoryItemId}`;
}

/**
 * Whether a new LOW_STOCK alert should be opened for an item.
 *
 * [known] is a Set of dedupe keys already decided in this request, so two order
 * lines hitting the same item cost one lookup rather than two.
 * [lookup] is injected to keep this pure and unit-testable: callers pass a
 * keyed equality query (server-side, limit 1) returning the alerts that carry
 * this key.
 *
 * Returns true when no unresolved alert exists yet. An alert that was already
 * resolved (isRead) does not block: stock recovered, so crossing again must
 * warn again.
 */
export async function shouldOpenLowStockAlert({
  locationId,
  inventoryItemId,
  known,
  lookup,
}) {
  const key = lowStockDedupeKey(locationId, inventoryItemId);
  if (known.has(key)) return false;
  known.add(key);
  const existing = await lookup(key);
  return !existing.some((a) => a.isRead === false);
}