// Weekly staff schedule — normalization, the tap gate and the per-tap badge.
//
// The policy the prof asked for: time in/out are only accepted when the
// tap falls inside the person's own scheduled window (with a 15-minute
// early grace for Time in and 60 minutes of overtime for Time out).
// Unscheduled staff stay unrestricted.
import test from "node:test";
import assert from "node:assert/strict";

import {
  canonicalHm,
  entryForInstant,
  fmtMinutes,
  hmToMinutes,
  normalizeDays,
  scheduleDocValue,
  scheduleVerdict,
  tapBadge,
} from "../src/services/staff_schedule.js";

// 2026-11-17 is a Tuesday (index 2). Times below are Manila wall-clock.
const TUESDAY_SHIFT = { start: "06:00", end: "14:00" };
const doc = (days) => ({ staffId: 2, days });
const week = (entry) => [null, null, entry, null, null, null, null];
const at = (manilaIso) => new Date(manilaIso + "+08:00").getTime();

test("HH:MM parsing and canonicalization", () => {
  assert.equal(hmToMinutes("06:00"), 360);
  assert.equal(hmToMinutes("23:59"), 1439);
  assert.ok(Number.isNaN(hmToMinutes("24:00")));
  assert.ok(Number.isNaN(hmToMinutes("6:60")));
  assert.ok(Number.isNaN(hmToMinutes("abc")));
  assert.equal(canonicalHm("6:05"), "06:05");
  assert.equal(canonicalHm("  7 : 30 "), null); // no space inside the clock
});

test("normalizeDays accepts a mixed week and rejects nonsense", () => {
  const out = normalizeDays([null, { start: "6:00", end: "14:00" }, null, null, null, null, "garbage"]);
  assert.equal(out, null);
  const good = normalizeDays([null, { start: "6:00", end: "14:00" }, null, null, null, null, null]);
  assert.deepEqual(good[1], { start: "06:00", end: "14:00" });
  assert.equal(good[0], null);
  // start must be before end
  assert.equal(normalizeDays([null, { start: "14:00", end: "06:00" }, null, null, null, null, null]), null);
  assert.equal(normalizeDays([null, { start: "06:00", end: "06:00" }, null, null, null, null, null]), null);
  // wrong shape entirely
  assert.equal(normalizeDays("not an array"), null);
});

test("no schedule doc means unrestricted taps", () => {
  assert.equal(scheduleVerdict(null, at("2026-11-17T08:00:00"), "IN").scheduled, false);
  assert.equal(scheduleVerdict(undefined, at("2026-11-17T08:00:00"), "OUT").scheduled, false);
});

test("a scheduled day off refuses the tap", () => {
  const v = scheduleVerdict(doc(week(null)), at("2026-11-17T08:00:00"), "IN");
  assert.equal(v.scheduled, true);
  assert.equal(v.ok, false);
  assert.match(v.reason, /day off/i);
});

test("time in: early grace opens 15 minutes before the start", () => {
  const d = doc(week(TUESDAY_SHIFT));
  assert.equal(scheduleVerdict(d, at("2026-11-17T05:44:00"), "IN").ok, false); // 16 min early
  assert.equal(scheduleVerdict(d, at("2026-11-17T05:45:00"), "IN").ok, true);  // 15 min early
  assert.equal(scheduleVerdict(d, at("2026-11-17T06:00:00"), "IN").ok, true);
  assert.equal(scheduleVerdict(d, at("2026-11-17T13:59:00"), "IN").ok, true);
  assert.equal(scheduleVerdict(d, at("2026-11-17T14:00:00"), "IN").ok, true);  // at the end is fine
  assert.equal(scheduleVerdict(d, at("2026-11-17T14:01:00"), "IN").ok, false); // shift already over
});

test("time out: allowed from the start until 60 minutes past the end", () => {
  const d = doc(week(TUESDAY_SHIFT));
  assert.equal(scheduleVerdict(d, at("2026-11-17T05:59:00"), "OUT").ok, false); // before start
  assert.equal(scheduleVerdict(d, at("2026-11-17T06:00:00"), "OUT").ok, true);
  assert.equal(scheduleVerdict(d, at("2026-11-17T14:00:00"), "OUT").ok, true);
  assert.equal(scheduleVerdict(d, at("2026-11-17T15:00:00"), "OUT").ok, true);  // +60 OT
  assert.equal(scheduleVerdict(d, at("2026-11-17T15:01:00"), "OUT").ok, false); // beyond OT window
});

test("the refusal reason names the scheduled times", () => {
  const d = doc(week(TUESDAY_SHIFT));
  const early = scheduleVerdict(d, at("2026-11-17T05:00:00"), "IN");
  assert.match(early.reason, /06:00/);
  const late = scheduleVerdict(d, at("2026-11-17T16:00:00"), "IN");
  assert.match(late.reason, /14:00/);
});

test("tapBadge: an on-time clock-in within 5 minutes of the start", () => {
  assert.deepEqual(tapBadge({ event: "IN", instant: "2026-11-17T06:00:00+08:00", entry: TUESDAY_SHIFT }), { label: "On time", tone: "ok" });
  assert.deepEqual(tapBadge({ event: "IN", instant: "2026-11-17T05:50:00+08:00", entry: TUESDAY_SHIFT }), { label: "On time", tone: "ok" });
  assert.deepEqual(tapBadge({ event: "IN", instant: "2026-11-17T06:05:00+08:00", entry: TUESDAY_SHIFT }), { label: "On time", tone: "ok" });
});

test("tapBadge: a late clock-in reports how late", () => {
  assert.deepEqual(tapBadge({ event: "IN", instant: "2026-11-17T06:14:00+08:00", entry: TUESDAY_SHIFT }), { label: "Tardy +14m", tone: "warn" });
  assert.deepEqual(tapBadge({ event: "IN", instant: "2026-11-17T07:30:00+08:00", entry: TUESDAY_SHIFT }), { label: "Tardy +1h 30m", tone: "warn" });
});

test("tapBadge: early outs and late clock-outs on a clock-out", () => {
  assert.deepEqual(tapBadge({ event: "OUT", instant: "2026-11-17T13:40:00+08:00", entry: TUESDAY_SHIFT }), { label: "Early out 20m", tone: "warn" });
  assert.deepEqual(tapBadge({ event: "OUT", instant: "2026-11-17T14:00:00+08:00", entry: TUESDAY_SHIFT }), { label: "On time", tone: "ok" });
  // Late clock-outs are recorded as an ordinary record, never as OT.
  assert.deepEqual(tapBadge({ event: "OUT", instant: "2026-11-17T14:35:00+08:00", entry: TUESDAY_SHIFT }), { label: "On time", tone: "ok" });
});

test("tapBadge: no schedule or a scheduled day off", () => {
  assert.equal(tapBadge({ event: "IN", instant: "2026-11-17T06:00:00+08:00", entry: null }).label, "No schedule");
});

test("entryForInstant: no doc vs scheduled day off vs a real day", () => {
  assert.equal(entryForInstant(null, "2026-11-17T06:00:00+08:00"), undefined);
  assert.equal(entryForInstant(doc(week(null)), "2026-11-17T06:00:00+08:00"), null);
  assert.deepEqual(entryForInstant(doc(week(TUESDAY_SHIFT)), "2026-11-17T06:00:00+08:00"), TUESDAY_SHIFT);
});

test("scheduleDocValue keeps only the newest 25 history entries", () => {
  const history = Array.from({ length: 30 }, (_, i) => ({ at: `2026-11-${String(i + 1).padStart(2, "0")}T00:00:00Z`, byName: "Owner" }));
  const raw = { staffId: 2, days: week(TUESDAY_SHIFT), history };
  const view = scheduleDocValue(raw);
  assert.equal(view.history.length, 25);
  assert.equal(view.history[0].at, "2026-11-06T00:00:00Z");
});

test("fmtMinutes", () => {
  assert.equal(fmtMinutes(9), "9m");
  assert.equal(fmtMinutes(59), "59m");
  assert.equal(fmtMinutes(60), "1h 00m");
  assert.equal(fmtMinutes(95), "1h 35m");
});
