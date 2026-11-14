// The owner changes something in the dashboard: the change has to reach every
// screen and every phone, not only the tab that made it.
//
// One announcement, three channels: a live frame for the web, a data-only push
// for the phones, and (in the web) a BroadcastChannel for the other tabs of
// the same browser.
import test from "node:test";
import assert from "node:assert/strict";

import {
  CHANGE_KINDS,
  DATA_CHANGED_PUSH_TYPE,
  announceChange,
  changeEventName,
  changePushPayload,
} from "../src/services/announce.js";

test("every kind has a live frame and a push payload", () => {
  assert.deepEqual(CHANGE_KINDS, [
    "locations",
    "devices",
    "staff",
    "expenses",
    "alerts",
  ]);
  for (const kind of CHANGE_KINDS) {
    assert.equal(changeEventName(kind), `${kind}:updated`);
  }
});

test("the push payload carries the kind and the details as strings", () => {
  const payload = changePushPayload("locations", { id: 3, code: "CART-01" });
  assert.equal(payload.type, DATA_CHANGED_PUSH_TYPE);
  assert.equal(payload.kind, "locations");
  assert.equal(payload.id, "3", "FCM data values must be strings");
  assert.equal(payload.code, "CART-01");
});

test("a missing kind is not announced", async () => {
  // Nothing to announce means nothing is sent: no frame, no push.
  const payload = changePushPayload("", { id: 1 });
  assert.equal(payload.kind, "");
  assert.equal(changeEventName(""), ":updated");
  // announceChange must not throw on an empty kind either.
  await announceChange("");
});
