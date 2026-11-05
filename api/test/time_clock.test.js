// Time clock windows: the owner-configured daily clock-in/out hour rule.
// The same rules exist in the Edge function (supabase/functions/api) — this
// pins the Express copy's behavior in CI.
import test from "node:test";
import assert from "node:assert/strict";

import {
  hmToMinutes,
  canonicalHm,
  canonicalDays,
  normalizeTimeClock,
  timeClockVerdict,
  manilaMinutesOfDay,
  manilaWeekday,
} from "../src/services/time_clock.js";

test("hmToMinutes parses HH:MM and rejects nonsense", () => {
  assert.equal(hmToMinutes("07:00"), 7 * 60);
  assert.equal(hmToMinutes("23:59"), 23 * 60 + 59);
  assert.equal(hmToMinutes("7:05"), 7 * 60 + 5);
  assert.equal(hmToMinutes("24:00"), NaN);
  assert.equal(hmToMinutes("12:60"), NaN);
  assert.equal(hmToMinutes("ab:cd"), NaN);
  assert.equal(hmToMinutes(""), NaN);
});

test("canonicalHm snaps to 24h HH:MM", () => {
  assert.equal(canonicalHm("7:05"), "07:05");
  assert.equal(canonicalHm("  17:30 "), "17:30");
  assert.equal(canonicalHm("25:00"), null);
});

test("manilaMinutesOfDay is UTC+8", () => {
  assert.equal(manilaMinutesOfDay(Date.UTC(2026, 0, 5, 0)), 8 * 60);
  assert.equal(manilaMinutesOfDay(Date.UTC(2026, 0, 5, 15, 59)), 23 * 60 + 59);
  assert.equal(manilaMinutesOfDay(Date.UTC(2026, 0, 5, 16)), 0);
  assert.equal(manilaMinutesOfDay(Date.UTC(2026, 0, 5, 23, 30)), 7 * 60 + 30);
});

const CLOCK = {
  enabled: true,
  inOpen: "07:00",
  inClose: "09:00",
  outOpen: "17:00",
  outClose: "19:00",
  days: [0, 1, 2, 3, 4, 5, 6],
};

test("manilaWeekday matches getDay on the Manila wall clock", () => {
  assert.equal(manilaWeekday(Date.UTC(2026, 10, 5, 15, 59)), 4); // Thu 23:59 Manila
  assert.equal(manilaWeekday(Date.UTC(2026, 10, 5, 16)), 5);     // Fri 00:00 Manila
  assert.equal(manilaWeekday(Date.UTC(2026, 10, 7, 16)), 0);     // Sun 00:00 Manila
});

test("canonicalDays dedupes, sorts and fills defaults", () => {
  assert.deepEqual(canonicalDays([6, 1, 4, 6, 0]), [0, 1, 4, 6]);
  assert.deepEqual(canonicalDays(null), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(canonicalDays([]), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(canonicalDays([9, -1, "x"]), [0, 1, 2, 3, 4, 5, 6]);
});

test("closed day blocks both events even inside the window", () => {
  const closedSun = { ...CLOCK, days: [1, 2, 3, 4, 5, 6] }; // every day except Sunday
  // Sunday 2026-11-08 07:30 Manila (Sat 2026-11-07 23:30 UTC): blocked.
  const sundayMs = Date.UTC(2026, 10, 7, 23, 30);
  assert.notEqual(timeClockVerdict(closedSun, "IN", sundayMs), null);
  assert.notEqual(timeClockVerdict(closedSun, "OUT", sundayMs), null);
  // Tuesday 2026-11-10 07:30 Manila (Mon 2026-11-09 23:30 UTC): allowed.
  const tuesdayMs = Date.UTC(2026, 10, 9, 23, 30);
  assert.equal(timeClockVerdict(closedSun, "IN", tuesdayMs), null);
});

test("windows are inclusive at open and at close", () => {
  assert.equal(timeClockVerdict(CLOCK, "IN", Date.UTC(2026, 0, 5, 22, 59)) !== null, true); // 06:59 Manila
  assert.equal(timeClockVerdict(CLOCK, "IN", Date.UTC(2026, 0, 5, 23)), null);              // 07:00 Manila
  assert.equal(timeClockVerdict(CLOCK, "IN", Date.UTC(2026, 0, 6, 1)), null);               // 09:00 Manila
  assert.equal(timeClockVerdict(CLOCK, "IN", Date.UTC(2026, 0, 6, 1, 1)) !== null, true);   // 09:01 Manila
  assert.equal(timeClockVerdict(CLOCK, "OUT", Date.UTC(2026, 0, 6, 8)) !== null, true);     // 16:00 Manila
  assert.equal(timeClockVerdict(CLOCK, "OUT", Date.UTC(2026, 0, 6, 9)), null);              // 17:00 Manila
});

test("unrestricted when disabled or unreadable (never locks anyone out)", () => {
  assert.equal(timeClockVerdict({ ...CLOCK, enabled: false }, "IN", Date.UTC(2026, 0, 5, 12)), null);
  assert.equal(timeClockVerdict(null, "IN", Date.UTC(2026, 0, 5, 12)), null);
  // Corrupt windows fall back to open.
  assert.equal(timeClockVerdict({ ...CLOCK, inOpen: "holiday" }, "IN", Date.UTC(2026, 0, 5, 12)), null);
});

test("normalizeTimeClock fills defaults and flags junk", () => {
  assert.deepEqual(normalizeTimeClock(null), {
    enabled: false,
    inOpen: "07:00",
    inClose: "09:00",
    outOpen: "17:00",
    outClose: "19:00",
    days: [0, 1, 2, 3, 4, 5, 6],
    updatedAt: null,
    updatedByName: null,
  });
  const c = normalizeTimeClock({ enabled: true, inOpen: "7:05", inClose: "junk", days: [6, 2, 6] });
  assert.equal(c.enabled, true);
  assert.equal(c.inOpen, "07:05");
  assert.equal(c.inClose, "09:00"); // junk value falls back to default
  assert.deepEqual(c.days, [2, 6]);
});
