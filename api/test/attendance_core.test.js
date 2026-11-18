// The dual-attendance policy (device tap, app tap, owner manual log):
// the same rules must hold regardless of method or order of arrival.
import test from "node:test";
import assert from "node:assert/strict";

import {
  ATTENDANCE_METHODS,
  attendanceMethod,
  cleanEventId,
  resolveNextEvent,
} from "../src/services/attendance_core.js";

const inRow = (id) => ({ id, event: "IN" });
const outRow = (id) => ({ id, event: "OUT" });

test("an event-free day means the next action is TIME IN", () => {
  assert.equal(resolveNextEvent([]).action, "IN");
});

test("a lone TIME IN means the next action is TIME OUT", () => {
  assert.equal(resolveNextEvent([inRow(1)]).action, "OUT");
});

test("both events recorded means the shift is complete", () => {
  const v = resolveNextEvent([inRow(1), outRow(2)]);
  assert.equal(v.action, null);
  assert.match(v.reason, /complete/i);
});

test("order of rows does not matter for the decision", () => {
  assert.equal(resolveNextEvent([outRow(2), inRow(1)]).action, null);
  assert.equal(resolveNextEvent([outRow(2)]).action, "IN"); // a lone OUT -> IN
});

test("attendanceMethod tags RFID, APP and MANUAL and derives legacy rows", () => {
  assert.deepEqual(ATTENDANCE_METHODS, ["RFID", "APP", "MANUAL"]);
  assert.equal(attendanceMethod({ method: "APP" }), "APP");
  assert.equal(attendanceMethod({ method: "MANUAL" }), "MANUAL");
  assert.equal(attendanceMethod({ method: "RFID" }), "RFID");
  assert.equal(attendanceMethod({ deviceId: "MANUAL" }), "MANUAL");
  assert.equal(attendanceMethod({ deviceId: "esp32-cart-01" }), "RFID");
  assert.equal(attendanceMethod({}), "RFID");
});

test("cleanEventId keeps safe sync keys and rejects junk", () => {
  assert.equal(cleanEventId("evt_123:cart-01"), "evt_123:cart-01");
  assert.equal(cleanEventId("  a.b-c:d.e_f  "), "a.b-c:d.e_f");
  assert.equal(cleanEventId(""), null);
  assert.equal(cleanEventId("x".repeat(65)), null);
  assert.equal(cleanEventId("has spaces"), null);
  assert.equal(cleanEventId("emoji-🔒"), null);
});
