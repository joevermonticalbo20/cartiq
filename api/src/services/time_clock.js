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

const TIMECLOCK_DEFAULTS = {
  enabled: false,
  inOpen: "07:00",
  inClose: "09:00",
  outOpen: "17:00",
  outClose: "19:00",
};

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

export function normalizeTimeClock(doc) {
  const out = { ...TIMECLOCK_DEFAULTS, updatedAt: null, updatedByName: null };
  if (doc) {
    out.enabled = doc.enabled === true;
    out.inOpen = canonicalHm(doc.inOpen) ?? out.inOpen;
    out.inClose = canonicalHm(doc.inClose) ?? out.inClose;
    out.outOpen = canonicalHm(doc.outOpen) ?? out.outOpen;
    out.outClose = canonicalHm(doc.outClose) ?? out.outClose;
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
export async function writeTimeClock({ enabled, inOpen, inClose, outOpen, outClose }, userName) {
  const snap = {
    enabled: enabled === true,
    inOpen: canonicalHm(inOpen),
    inClose: canonicalHm(inClose),
    outOpen: canonicalHm(outOpen),
    outClose: canonicalHm(outClose),
    updatedAt: new Date(),
    updatedByName: userName ?? null,
  };
  await db.collection("settings").doc("timeClock").set(snap, { merge: true });
  return normalizeTimeClock(snap);
}

/** null when unrestricted/open; otherwise a human reason for the refusal. */
export function timeClockVerdict(clock, event, nowMs) {
  if (!clock || clock.enabled !== true) return null;
  const inOpen = hmToMinutes(clock.inOpen);
  const inClose = hmToMinutes(clock.inClose);
  const outOpen = hmToMinutes(clock.outOpen);
  const outClose = hmToMinutes(clock.outClose);
  // A hand-edited/corrupt doc must NEVER lock staff out: fall back to open.
  if ([inOpen, inClose, outOpen, outClose].some(Number.isNaN)) return null;
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
