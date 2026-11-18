// The Shift History report — read-time aggregation over a window of
// shifts. No schema change: classification reuses the tap badge math
// (min 5-minute grace for on time, start-relative for tardy).
import test from "node:test";
import assert from "node:assert/strict";

import {
  aggregateShiftReport,
  reportDayKeys,
} from "../src/services/shift_report.js";
import { manilaDayStart, manilaDayKey } from "../src/services/timezone.js";

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
const YESTERDAY_MS = manilaDayStart(1).getTime();
const TODAY_MS = manilaDayStart(0).getTime();

// Roster: schedule the entry on the weekday the day actually falls.
// Simpler: give staff01 a roster identical every weekday.
const EVERY_DAY_0600_1400 = [
  { start: "06:00", end: "14:00" }, { start: "06:00", end: "14:00" },
  { start: "06:00", end: "14:00" }, { start: "06:00", end: "14:00" },
  { start: "06:00", end: "14:00" }, { start: "06:00", end: "14:00" },
  { start: "06:00", end: "14:00" },
];
const EVERY_DAY_OFF = [null, null, null, null, null, null, null];

const allUsers = [
  { id: 2, name: "Stall Staff 1", username: "staff01", role: "STAFF", active: true, location: { code: "CART-01" } },
  { id: 4, name: "Stall Staff 3", username: "staff03", role: "STAFF", active: true, location: { code: "CART-03" } },
];

test("window keys cover the requested days ending today", () => {
  const { keys, days } = reportDayKeys(3);
  assert.equal(keys.length, 3);
  assert.equal(days, 3);
  assert.equal(manilaDayKey(manilaDayStart(0)), keys[2]);
  assert.equal(manilaDayKey(manilaDayStart(2)), keys[0]);
});

test("classification, hours and absences are computed per staff", () => {
  const schedMap = new Map([
    [2, { days: EVERY_DAY_0600_1400 }],
    [4, { days: EVERY_DAY_OFF }],
  ]);
  const shifts = [
    // staff01: yesterday on time, early out
    { id: 1, staffId: 2, event: "IN", ts: new Date(YESTERDAY_MS + 6 * HOUR + 4 * MIN) },
    { id: 2, staffId: 2, event: "OUT", ts: new Date(YESTERDAY_MS + 13 * HOUR + 40 * MIN) },
    // staff03: today, late (but no roster → not classified)
    { id: 3, staffId: 4, event: "IN", ts: new Date(TODAY_MS + 7 * HOUR + 30 * MIN) },
  ];
  const out = aggregateShiftReport({ shifts, staffUsers: allUsers, scheduleMap: schedMap, days: 2 });
  const s1 = out.staff.find((s) => s.staff_id === 2);
  const s3 = out.staff.find((s) => s.staff_id === 4);
  assert.equal(s1.clock_ins, 1);
  assert.equal(s1.on_time, 1);
  assert.equal(s1.tardy, 0);
  assert.equal(s1.early_out, 1);
  assert.equal(s1.hours_worked, 7.6);
  assert.equal(s1.absences, 1); // scheduled today, no tap today
  assert.equal(s1.on_time_pct, 100);
  // staff03: nothing scheduled anywhere, unclassifiable tap
  assert.equal(s3.clock_ins, 1);
  assert.equal(s3.on_time + s3.tardy, 0);
  assert.equal(s3.hours_worked, 0);
  assert.equal(s3.absences, 0);
  assert.equal(out.totals.absences, 1);
  assert.equal(out.totals.hours_worked, 7.6);
  assert.equal(out.totals.clock_ins, 2);
});

test("on_time_pct divides on-time by classified clock-ins", () => {
  const schedMap = new Map([[2, { days: EVERY_DAY_0600_1400 }]]);
  const out = aggregateShiftReport({
    shifts: [
      { id: 1, staffId: 2, event: "IN", ts: new Date(YESTERDAY_MS + 6 * HOUR + 2 * MIN) }, // on time
      { id: 2, staffId: 2, event: "IN", ts: new Date(TODAY_MS + 7 * HOUR + 30 * MIN) },     // tardy
    ],
    staffUsers: allUsers,
    scheduleMap: schedMap,
    days: 2,
  });
  const s1 = out.staff.find((s) => s.staff_id === 2);
  assert.equal(s1.on_time, 1);
  assert.equal(s1.tardy, 1);
  assert.equal(s1.on_time_pct, 50);
});

// NOTE: the overtime computation was removed by owner request - the badge for
// a late clock-out is just "On time" and the report carries no OT columns.

test("an IN without an OUT after the day ends is half day (scheduled/2 credited)", () => {
  const schedMap = new Map([[2, { days: EVERY_DAY_0600_1400 }]]);
  const out = aggregateShiftReport({
    shifts: [
      // Yesterday: IN, never OUT — half day once the day fully elapsed.
      { id: 1, staffId: 2, event: "IN", ts: new Date(YESTERDAY_MS + 6 * HOUR) },
    ],
    staffUsers: allUsers,
    scheduleMap: schedMap,
    days: 2, // yesterday (elapsed) + today (open, not yet half day)
    now: Date.now(),
  });
  const s1 = out.staff.find((s) => s.staff_id === 2);
  assert.equal(s1.half_days, 1);
  assert.equal(s1.hours_worked, 4); // half of 06:00-14:00
  assert.equal(s1.absences, 1);     // today: scheduled, no tap at all
  assert.equal(out.totals.half_days, 1);
});

test("today's open IN is NOT a half day yet", () => {
  const schedMap = new Map([[2, { days: EVERY_DAY_0600_1400 }]]);
  const out = aggregateShiftReport({
    shifts: [
      { id: 1, staffId: 2, event: "IN", ts: new Date(TODAY_MS + 6 * HOUR) },
    ],
    staffUsers: allUsers,
    scheduleMap: schedMap,
    days: 1,
    now: Date.now(),
  });
  const s1 = out.staff.find((s) => s.staff_id === 2);
  assert.equal(s1.half_days, 0);
});

test("an IN-only yesterday (no OUT) counts half-day hours under the new rule", () => {
  const schedMap = new Map([[2, { days: EVERY_DAY_0600_1400 }]]);
  const out = aggregateShiftReport({
    shifts: [
      { id: 1, staffId: 2, event: "IN", ts: new Date(YESTERDAY_MS + 6 * HOUR) },
      { id: 2, staffId: 2, event: "OUT", ts: new Date(TODAY_MS + 14 * HOUR) },
    ],
    staffUsers: allUsers,
    scheduleMap: schedMap,
    days: 2,
    now: Date.now(),
  });
  const s1 = out.staff.find((s) => s.staff_id === 2);
  assert.equal(s1.half_days, 1);   // yesterday IN with no OUT, day elapsed
  assert.equal(s1.hours_worked, 4); // half of 06:00-14:00 credited
  assert.equal(s1.absences, 1);     // today: scheduled day with no IN tap
});
