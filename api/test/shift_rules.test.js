// What a card tap may and may not record.
//
// The rules that keep the attendance log honest:
//   - one IN and one OUT per person per Manila day (a tap on the reader never
//     goes through the app, so the app's greyed button cannot be the only
//     guard);
//   - a schedule whose Time out window is earlier than its Time in window is
//     not a schedule.
import test from "node:test";
import assert from "node:assert/strict";

import {
  duplicateShiftReason,
  formatManilaClock12,
  manilaDayKeyOf,
  shiftsOfPersonOnDay,
} from "../src/services/shift_rules.js";
import { timeClockScheduleError } from "../src/services/time_clock.js";

// 2026-11-13 17:23 Manila = 09:23 UTC.
const inShift = {
  id: 33,
  staffId: 2,
  staffUid: "3A20704F",
  event: "IN",
  ts: new Date("2026-11-13T09:23:40Z"),
};
const outShift = {
  id: 34,
  staffId: 2,
  staffUid: "3A20704F",
  event: "OUT",
  ts: new Date("2026-11-13T09:30:22Z"),
};

test("the Manila clock reads like the app's", () => {
  assert.equal(formatManilaClock12(new Date("2026-11-13T09:23:40Z")), "5:23 PM");
  assert.equal(formatManilaClock12(new Date("2026-11-13T00:05:00Z")), "8:05 AM");
  assert.equal(formatManilaClock12(new Date("2026-11-13T16:00:00Z")), "12:00 AM");
  assert.equal(formatManilaClock12(null), "");
});

test("a shift belongs to the Manila day it happened on", () => {
  assert.equal(manilaDayKeyOf(new Date("2026-11-13T16:30:00Z")), "2026-11-14");
  assert.equal(manilaDayKeyOf(new Date("2026-11-13T09:23:40Z")), "2026-11-13");
});

test("only that person's shifts on that day are counted", () => {
  const rows = [
    inShift,
    outShift,
    { id: 30, staffId: 4, staffUid: "06C4D5E6", event: "IN", ts: new Date("2026-11-13T01:00:00Z") },
    { id: 29, staffId: 2, staffUid: "3A20704F", event: "IN", ts: new Date("2026-11-12T09:00:00Z") },
  ];
  const mine = shiftsOfPersonOnDay(rows, {
    staffId: 2,
    staffUid: "3A20704F",
    dayKey: "2026-11-13",
  });
  assert.equal(mine.length, 2);
  assert.deepEqual(mine.map((s) => s.id), [33, 34]);
});

test("a second time in on the same day is a duplicate, not a new shift", () => {
  const reason = duplicateShiftReason([inShift, outShift], "IN");
  assert.equal(reason, "You already timed in today at 5:23 PM.");
});

test("a second time out on the same day is a duplicate too", () => {
  const reason = duplicateShiftReason([inShift, outShift], "OUT");
  assert.equal(reason, "You already timed out today at 5:30 PM.");
});

test("the first time in of the day is allowed", () => {
  assert.equal(duplicateShiftReason([], "IN"), null);
  // An IN already logged does not block the OUT that ends the shift.
  assert.equal(duplicateShiftReason([inShift], "OUT"), null);
});

test("a row without a staff id still counts for its card", () => {
  const rows = [{ id: 40, staffUid: "3A20704F", event: "IN", ts: inShift.ts }];
  const mine = shiftsOfPersonOnDay(rows, {
    staffUid: "3A20704F",
    dayKey: "2026-11-13",
  });
  assert.equal(mine.length, 1);
  assert.equal(duplicateShiftReason(mine, "IN"), "You already timed in today at 5:23 PM.");
});

test("a schedule whose Time out is earlier than its Time in is refused", () => {
  // The owner's example: time in 4:00-4:10 PM, time out 3:00-3:10 PM.
  const error = timeClockScheduleError({
    inOpen: "16:00",
    inClose: "16:10",
    outOpen: "15:00",
    outClose: "15:10",
  });
  assert.ok(error, "the schedule must be refused");
  assert.match(error, /Time out cannot be earlier than Time in/);
});

test("a normal schedule is fine", () => {
  assert.equal(
    timeClockScheduleError({
      inOpen: "07:00",
      inClose: "09:00",
      outOpen: "17:00",
      outClose: "19:00",
    }),
    null,
  );
});

test("the all-day schedule stays valid", () => {
  // Both windows cover the whole day: a real choice for a stall, not a
  // mistake. The rule must not lock the owner out of it.
  assert.equal(
    timeClockScheduleError({
      inOpen: "00:00",
      inClose: "23:59",
      outOpen: "00:00",
      outClose: "23:59",
    }),
    null,
  );
});

test("a Time out window that starts before Time in opens is refused", () => {
  const error = timeClockScheduleError({
    inOpen: "06:00",
    inClose: "08:00",
    outOpen: "05:00",
    outClose: "23:00",
  });
  assert.ok(error);
});

test("a Time out window that closes before Time in closes is refused", () => {
  const error = timeClockScheduleError({
    inOpen: "06:00",
    inClose: "08:00",
    outOpen: "09:00",
    outClose: "07:30",
  });
  assert.ok(error);
});
