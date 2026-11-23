// What a card tap may and may not record.
//
// Pure functions so the policy is unit-testable without a database, and so the
// Express API and the Supabase Edge function (the production path) make the
// same call about the same tap. The Edge mirrors these - keep both in step.
//
// Two rules live here:
//
// 1. One IN and one OUT per person per Manila day. The app already refuses a
//    second time in / time out in the app, but a tap on the reader never goes
//    through the app - so without this the server happily recorded a second
//    shift for a person who had already clocked in.
//
// 2. A card belongs to the cart it was enrolled at (see rfid.js for the
//    helpers that answer that question).

// Manila is UTC+8 with no DST, so the offset is a fixed constant - the same
// thing services/timezone.js does for the business day.
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Shift an instant into "Manila wall-clock space". */
function inManila(date) {
  return new Date(new Date(date).getTime() + MANILA_OFFSET_MS);
}

/** 12-hour Manila wall-clock label, such as `5:23 PM` (matches the app). */
export function formatManilaClock12(date) {
  if (!date) return "";
  const m = inManila(date);
  const hour = m.getUTCHours() % 12 === 0 ? 12 : m.getUTCHours() % 12;
  const minute = String(m.getUTCMinutes()).padStart(2, "0");
  const period = m.getUTCHours() < 12 ? "AM" : "PM";
  return `${hour}:${minute} ${period}`;
}

/** YYYY-MM-DD calendar date in Manila for any instant. */
export function manilaDayKeyOf(date) {
  const m = inManila(date);
  const y = m.getUTCFullYear();
  const mo = String(m.getUTCMonth() + 1).padStart(2, "0");
  const d = String(m.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

/**
 * The shifts of one person for one Manila day.
 *
 * [shifts] may hold any shifts; only the ones that belong to [personKey] on
 * [dayKey] are kept. [personKey] is the staff id when known, falling back to
 * the card UID, so an old row without a staff id still counts.
 */
export function shiftsOfPersonOnDay(shifts, { staffId, staffUid, dayKey }) {
  return (shifts ?? []).filter((s) => {
    if (!s) return false;
    const key = s.staffId != null ? `id:${s.staffId}` : `uid:${s.staffUid}`;
    const wanted = staffId != null ? `id:${staffId}` : `uid:${staffUid}`;
    if (key !== wanted) return false;
    return manilaDayKeyOf(s.ts) === dayKey;
  });
}

/**
 * The reason this tap must not be recorded, or null when it may be.
 *
 * After a time in, another time in is a duplicate, not a new shift - and the
 * same for a time out. The wording matches the app, so the person reads the
 * same sentence whether the tap came from the app or from the reader.
 *
 * [todayShifts] = the person's shifts for this Manila day (see
 * [shiftsOfPersonOnDay]).
 */
export function duplicateShiftReason(todayShifts, event) {
  const wanted = String(event ?? "").toUpperCase();
  if (wanted !== "IN" && wanted !== "OUT") return null;
  const same = (todayShifts ?? []).find(
    (s) => String(s?.event ?? "").toUpperCase() === wanted,
  );
  if (!same) return null;
  const label = wanted === "OUT" ? "out" : "in";
  const at = same.ts ? ` at ${formatManilaClock12(same.ts)}` : "";
  return `You already timed ${label} today${at}.`;
}

/** Staff ids that currently have an RFID card bound (unbound staff have no attendance). */
export function boundStaffIds(users) {
  return new Set(
    (users ?? [])
      .filter((u) => u?.rfidUid != null && String(u.rfidUid).trim() !== "")
      .map((u) => Number(u.id))
      .filter(Number.isFinite),
  );
}

/** Two taps of the same card inside this window are one attendance action. */
export const DUP_TAP_WINDOW_MS = 5 * 60 * 1000;

/**
 * True when the person already has a tap within `windowMs` of `ts`. Used to
 * absorb a double tap at the reader: the first tap wins, the second is a no-op
 * instead of an immediate OUT. `todays` comes from shiftsOfPersonOnDay().
 */
export function recentTapWithin(todays, ts, event, windowMs = DUP_TAP_WINDOW_MS) {
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return false;
  const wanted = String(event ?? "").toUpperCase();
  return (todays ?? []).some((s) => {
    if (String(s?.event ?? "").toUpperCase() !== wanted) return false;
    const st = new Date(s?.ts).getTime();
    return Number.isFinite(st) && Math.abs(st - t) <= windowMs;
  });
}

/**
 * Remember an event that was just accepted in this batch so later events for
 * the same person see it. The DB read for `recentShifts` happens once per
 * request; without this, two buffered offline taps (IN then OUT) would both be
 * matched against the pre-batch state and resolve to IN.
 */
export function rememberPlannedShift(recentShifts, { uid, event, ts, user }) {
  if (!Array.isArray(recentShifts)) return recentShifts;
  recentShifts.push({
    id: `planned-${recentShifts.length}`,
    staffId: user?.id ?? null,
    staffUid: uid,
    event: String(event ?? "").toUpperCase(),
    ts,
    locationId: null,
  });
  return recentShifts;
}
