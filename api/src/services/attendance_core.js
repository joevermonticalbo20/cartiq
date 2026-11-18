// Shared policy for every attendance entry point:
//   device tap (RFID card) · app tap (STAFF button) · owner manual log
//
// The two entry paths that record real staff attendance (device tap and app
// tap) must make the SAME call about the same attendance day, regardless of
// method or order. Pure functions only — both API copies mirror these rules;
// the Edge function (supabase/functions/api/index.ts) inlines its copy.
//
// One attendance record per tap (event-sourced days) — a session is the pair
// of IN and OUT events for the same person, cart and Manila day, and the
// "assigned shift" joins by weekday to the weekly roster (staffSchedules).

export const ATTENDANCE_METHODS = Object.freeze(["RFID", "APP", "MANUAL"]);

/**
 * The next action the READER/APP should offer from the person's attendance
 * state today:
 *   no IN yet          -> "IN"
 *   IN without an OUT  -> "OUT"
 *   both recorded      -> null (the shift is complete for today)
 * [todays] are the shiftsOfPersonOnDay() rows for the Manila day.
 */
export function resolveNextEvent(todays) {
  let hasIn = false;
  let hasOut = false;
  for (const s of todays ?? []) {
    if (s?.event === "IN") hasIn = true;
    else if (s?.event === "OUT") hasOut = true;
  }
  if (hasIn && hasOut) {
    return { action: null, reason: "Shift already complete for today." };
  }
  return { action: hasIn ? "OUT" : "IN" };
}

/** The SHIFT alert payload (and the audit trail) carry the method. */
export function attendanceMethod(row) {
  const m = String(row?.method ?? "").toUpperCase();
  if (m === "MANUAL" || m === "APP" || m === "RFID") return m;
  // Legacy rows: no method stored — derive from the writer.
  return row?.deviceId === "MANUAL" ? "MANUAL" : "RFID";
}

/** Sanitize an idempotency key from the reader/sync layer (<=64 safe chars). */
export function cleanEventId(raw) {
  const v = String(raw ?? "").trim();
  if (!v || v.length > 64) return null;
  if (!/^[A-Za-z0-9_.:-]+$/.test(v)) return null;
  return v;
}
