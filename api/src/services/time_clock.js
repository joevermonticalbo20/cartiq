// CartIQ Time clock windows - owner-configured daily clock-in/out hours.
//
// Kept in step with the Edge function (supabase/functions/api/index.ts),
// which is the production copy. Same Firestore doc, same business rules:
//   settings/timeClock = {
//     enabled: boolean,               // false/missing = no restriction at all
//     inOpen: "HH:MM", inClose: "HH:MM",   // Asia/Manila wall-clock (UTC+8)
//     outOpen: "HH:MM", outClose: "HH:MM",
//     updatedAt: timestamp, updatedByName: string
//   }
// Manila is UTC+8 with no DST, so the offset is a fixed constant - the same
// thing ./timezone.js does for the business day.
import { db } from "../firestore.js";

const MNL_OFFSET_MS = 8 * 60 * 60 * 1000;
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]; // 0 = Sunday ... 6 = Saturday (UTC getDay convention)

const TIMECLOCK_DEFAULTS = {
  enabled: false,
  inOpen: "07:00",
  inClose: "09:00",
  outOpen: "17:00",
  outClose: "19:00",
};

/** Weekday 0-6 in Manila for any instant (0 = Sunday, same as UTC getDay). */
export function manilaWeekday(nowMs) {
  const m = new Date(nowMs + MNL_OFFSET_MS);
  return m.getUTCDay();
}

/** Minutes since Manila midnight for any instant (server runs UTC). */
export function manilaMinutesOfDay(nowMs) {
  const m = new Date(nowMs + MNL_OFFSET_MS);
  return m.getUTCHours() * 60 + m.getUTCMinutes();
}

/** "HH:MM" 24h -> minutes since midnight, or NaN. */
export function hmToMinutes(v) {
  if (typeof v !== "string") return NaN;
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(v);
  if (!m) return NaN;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return NaN;
  return h * 60 + min;
}

/** Snap a time to canonical "HH:MM", or null when invalid. */
export function canonicalHm(v) {
  const n = hmToMinutes(v);
  if (Number.isNaN(n)) return null;
  return String(Math.floor(n / 60)).padStart(2, "0") + ":" + String(n % 60).padStart(2, "0");
}

/** Normalize a days array to a deduped sorted 0-6 array; absent/invalid becomes ALL days (fail-open). */
export function canonicalDays(v) {
  if (!Array.isArray(v)) return ALL_DAYS.slice();
  const set = new Set();
  for (const n of v) {
    const n2 = Number(n);
    if (Number.isInteger(n2) && n2 >= 0 && n2 <= 6) set.add(n2);
  }
  const arr = [...set].sort((a, b) => a - b);
  return arr.length ? arr : ALL_DAYS.slice();
}

export function normalizeTimeClock(doc) {
  const out = { ...TIMECLOCK_DEFAULTS, updatedAt: null, updatedByName: null, days: ALL_DAYS.slice() };
  if (doc) {
    out.enabled = doc.enabled === true;
    out.inOpen = canonicalHm(doc.inOpen) ?? out.inOpen;
    out.inClose = canonicalHm(doc.inClose) ?? out.inClose;
    out.outOpen = canonicalHm(doc.outOpen) ?? out.outOpen;
    out.outClose = canonicalHm(doc.outClose) ?? out.outClose;
    out.days = canonicalDays(doc.days);
    out.updatedAt = doc.updatedAt?.toDate ? doc.updatedAt.toDate().toISOString() : (doc.updatedAt ? String(doc.updatedAt) : null);
    out.updatedByName = doc.updatedByName ?? null;
  }
  return out;
}

/** Read settings/timeClock normalized; missing/garbage doc reads as "no restriction". */
export async function readTimeClock() {
  try {
    const snap = await db.collection("settings").doc("timeClock").get();
    return normalizeTimeClock(snap.exists ? snap.data() : null);
  } catch {
    // Never lock staff out because the config could not be read.
    return { ...TIMECLOCK_DEFAULTS };
  }
}

/**
 * Upsert settings/timeClock (merge semantics). Normalizes and validates the
 * times. Returns the normalized stored config.
 */
export async function writeTimeClock({ enabled, inOpen, inClose, outOpen, outClose, days }, userName) {
  const snap = {
    enabled: enabled === true,
    inOpen: canonicalHm(inOpen),
    inClose: canonicalHm(inClose),
    outOpen: canonicalHm(outOpen),
    outClose: canonicalHm(outClose),
    days: canonicalDays(days),
    updatedAt: new Date(),
    updatedByName: userName ?? null,
  };
  await db.collection("settings").doc("timeClock").set(snap, { merge: true });
  return normalizeTimeClock(snap);
}

/**
 * Why this schedule is impossible, or null when it is fine.
 *
 * A shift must start before it can end, so the Time out window may not be
 * earlier than the Time in window: "Time in 16:00-16:10" with "Time out
 * 15:00-15:10" is not a schedule, it is a mistake that would leave a vendor
 * unable to ever clock out. The all-day schedule (both windows 00:00-23:59)
 * stays valid - that is a real choice, not a mistake.
 *
 * Returns a sentence for the owner, or null when the schedule may be saved.
 */
export function timeClockScheduleError({ inOpen, inClose, outOpen, outClose } = {}) {
  const iOpen = hmToMinutes(inOpen);
  const iClose = hmToMinutes(inClose);
  const oOpen = hmToMinutes(outOpen);
  const oClose = hmToMinutes(outClose);
  // Garbage in, garbage out: the callers validate the shape first.
  if ([iOpen, iClose, oOpen, oClose].some(Number.isNaN)) return null;
  if (oOpen < iOpen || oClose < iClose) {
    return "Time out cannot be earlier than Time in - a shift must start before it can end.";
  }
  return null;
}

/** null when unrestricted/open; otherwise a human reason for the refusal. */
export function timeClockVerdict(clock, event, nowMs) {  if (!clock || clock.enabled !== true) return null;
  const inOpen = hmToMinutes(clock.inOpen);
  const inClose = hmToMinutes(clock.inClose);
  const outOpen = hmToMinutes(clock.outOpen);
  const outClose = hmToMinutes(clock.outClose);
  // A hand-edited/corrupt doc must NEVER lock staff out: fall back to open.
  if ([inOpen, inClose, outOpen, outClose].some(Number.isNaN)) return null;
  // Days the cart does not sell: no clock events at all.
  if (Array.isArray(clock.days) && !clock.days.includes(manilaWeekday(nowMs))) {
    const label = event === "OUT" ? "Time out" : "Time in";
    return `${label} is disabled on closed days. Try again on a selling day.`;
  }
  const isOut = event === "OUT";
  const openMin = isOut ? outOpen : inOpen;
  const closeMin = isOut ? outClose : inClose;
  const nowMin = manilaMinutesOfDay(nowMs);
  // The closing minute itself is allowed (minute-level resolution).
  if (nowMin >= openMin && nowMin <= closeMin) return null;
  const open = isOut ? clock.outOpen : clock.inOpen;
  const close = isOut ? clock.outClose : clock.inClose;
  return `${isOut ? "Time out" : "Time in"} is only open ${open}-${close} (Manila time). Try again then.`;
}
