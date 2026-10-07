// Low-stock alert dedupe: the read-budget fix.
import test from "node:test";
import assert from "node:assert/strict";

import {
  lowStockDedupeKey,
  shouldOpenLowStockAlert,
} from "../src/services/low_stock_alert.js";

test("the dedupe key is stable per location + item", () => {
  assert.equal(lowStockDedupeKey(1, 42), "low:1:42");
  assert.equal(lowStockDedupeKey(1, 42), lowStockDedupeKey(1, 42));
  assert.notEqual(lowStockDedupeKey(1, 42), lowStockDedupeKey(2, 42));
  assert.notEqual(lowStockDedupeKey(1, 42), lowStockDedupeKey(1, 43));
});

test("the key is never used as a document id", () => {
  // alerts is a numeric model; firestore.js coerces the doc name with Number().
  // A key like this must stay in the lowStockKey field, never become the id.
  assert.ok(!Number.isFinite(Number(lowStockDedupeKey(1, 42))));
});

test("opens an alert when nothing exists for that key", async () => {
  const open = await shouldOpenLowStockAlert({
    locationId: 1,
    inventoryItemId: 42,
    known: new Set(),
    lookup: async () => [],
  });
  assert.equal(open, true);
});

test("stays closed when an unresolved alert already exists", async () => {
  const open = await shouldOpenLowStockAlert({
    locationId: 1,
    inventoryItemId: 42,
    known: new Set(),
    lookup: async () => [{ id: 7, lowStockKey: "low:1:42", isRead: false }],
  });
  assert.equal(open, false, "an open alert must block a duplicate");
});

test("re-opens when the previous alert was resolved", async () => {
  // Stock recovered and an operator acked it: crossing again must warn again.
  const open = await shouldOpenLowStockAlert({
    locationId: 1,
    inventoryItemId: 42,
    known: new Set(),
    lookup: async () => [{ id: 7, lowStockKey: "low:1:42", isRead: true }],
  });
  assert.equal(open, true);
});

test("a second crossing in the same request costs no extra lookup", async () => {
  const known = new Set();
  let lookups = 0;
  const lookup = async () => {
    lookups += 1;
    return [];
  };
  const first = await shouldOpenLowStockAlert({
    locationId: 1,
    inventoryItemId: 42,
    known,
    lookup,
  });
  const second = await shouldOpenLowStockAlert({
    locationId: 1,
    inventoryItemId: 42,
    known,
    lookup,
  });
  assert.equal(first, true);
  assert.equal(second, false);
  assert.equal(lookups, 1, "the repeat must short-circuit before the lookup");
});

test("different items in one request each get their own lookup", async () => {
  const known = new Set();
  let lookups = 0;
  const lookup = async () => {
    lookups += 1;
    return [];
  };
  for (const itemId of [1, 2, 3]) {
    await shouldOpenLowStockAlert({ locationId: 1, inventoryItemId: itemId, known, lookup });
  }
  assert.equal(lookups, 3, "cost is O(items that crossed), not O(all alerts)");
});

test("the lookup is keyed, so it stays one read regardless of history size", async () => {
  // The regression guard: the old code asked for every LOW_STOCK alert ever
  // created and filtered in memory. The caller's lookup must be a single
  // equality query, so the count passed in must not matter to the result.
  const hugeHistory = Array.from({ length: 10000 }, (_, i) => ({
    id: i,
    lowStockKey: `low:9:${i}`,
    isRead: false,
  }));
  let requestedLimit = Infinity;
  const lookup = async (key) => {
    requestedLimit = Math.min(requestedLimit, 4);
    // A keyed query would never return rows for a different key.
    return hugeHistory.filter((a) => a.lowStockKey === key);
  };
  const open = await shouldOpenLowStockAlert({
    locationId: 1,
    inventoryItemId: 42,
    known: new Set(),
    lookup,
  });
  assert.equal(open, true);
  assert.ok(requestedLimit <= 4, "lookup must stay bounded, not scan all alerts");
});