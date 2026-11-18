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

test("overtime minutes accrue from clock-outs past the scheduled end", () => {
  const schedMap = new Map([[2, { days: EVERY_DAY_0600_1400 }]]);
  const out = aggregateShiftReport({
    shifts: [
      { id: 1, staffId: 2, event: "OUT", ts: new Date(TODAY_MS + 14 * HOUR + 45 * MIN) },
    ],
    staffUsers: allUsers,
    scheduleMap: schedMap,
    days: 1,
  });
  assert.equal(out.staff[0].overtime_min, 45);
  assert.equal(out.staff[0].overtime_hours, 0.8);
  assert.equal(out.totals.overtime_hours, 0.8);
});

test("hours stay paired within a day; a day with only an IN counts 0", () => {
  const schedMap = new Map([[2, { days: EVERY_DAY_0600_1400 }]]);
  const out = aggregateShiftReport({
    shifts: [
      { id: 1, staffId: 2, event: "IN", ts: new Date(YESTERDAY_MS + 6 * HOUR) },
      { id: 2, staffId: 2, event: "OUT", ts: new Date(TODAY_MS + 14 * HOUR) },
    ],
    staffUsers: allUsers,
    scheduleMap: schedMap,
    days: 2,
  });
  const s1 = out.staff.find((s) => s.staff_id === 2);
  assert.equal(s1.hours_worked, 0);
  assert.equal(s1.absences, 1); // today: scheduled day with no IN tap
});
