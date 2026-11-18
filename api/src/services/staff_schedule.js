// Weekly staff schedule — the rules for the owner-managed per-staff roster.
//
// Firestore document shape (one per staff member; collection `staffSchedules`,
// doc id = String(staffId)):
//   {
//     staffId: 2,
//     days: [null, { start: "06:00", end: "14:00" }, ..., null], // index = dayOfWeek (0=Sun)
//     updatedAt: <timestamp>, updatedBy: 1, updatedByName: "Owner",
//     history: [ { at, by, byName, before, after }, ... ],   // capped at 25
//   }
//
// Pure functions so the policy is unit-testable without a database. Mirrored
// in supabase/functions/api/index.ts (production Edge path) - keep both in
// step when changing policy.

export const SCHEDULE_HISTORY_MAX = 25;
export const WEEK_DAYS = [0, 1, 2, 3, 4, 5, 6]; // 0 = Sunday .. 6 = Saturday

const MNL_OFFSET_MS = 8 * 60 * 60 * 1000;
export function manilaWeekday(nowMs = Date.now()) {
  const m = new Date(nowMs + MNL_OFFSET_MS);
  return m.getUTCDay();
}

export function manilaMinutesOfDay(nowMs = Date.now()) {
  const m = new Date(nowMs + MNL_OFFSET_MS);
  return m.getUTCHours() * 60 + m.getUTCMinutes();
}

export function manilaDayKey(nowMs = Date.now()) {
  const m = new Date(nowMs + MNL_OFFSET_MS);
  const y = m.getUTCFullYear();
  const mo = String(m.getUTCMonth() + 1).padStart(2, "0");
  const d = String(m.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

/** "HH:MM" 24h -> minutes since midnight, or NaN. */
export function hmToMinutes(v) {
  if (typeof v !== "string") return NaN;
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(v);
  if (!m) return NaN;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return NaN;
  return h * 60 + min;
}

/** Snap a time to canonical "HH:MM", or null when invalid. */
export function canonicalHm(v) {
  const n = hmToMinutes(v);
  return Number.isNaN(n) ? null : String(Math.floor(n / 60)).padStart(2, "0") + ":" + String(n % 60).padStart(2, "0");
}

/**
 * The schedule's `days` array, sanitized: 7 entries, each null or
 * { start, end } with valid HH:MM and start < end. Returns null when the
 * payload is unusable.
 */
export function normalizeDays(raw) {
  if (!Array.isArray(raw)) return null;
  const out = new Array(7).fill(null);
  for (let i = 0; i < 7; i++) {
    const entry = raw[i];
    if (entry == null) continue; // explicit off
    if (typeof entry !== "object") return null;
    const start = canonicalHm(entry.start);
    const end = canonicalHm(entry.end);
    if (!start || !end) return null;
    if (hmToMinutes(start) >= hmToMinutes(end)) return null; // must start before it ends
    out[i] = { start, end };
  }
  return out;
}

/** Day label for messages. */
export const WEEKDAY_LABEL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Read the effective schedule for a staff member.
 * Returns the raw stored doc (normalized shape) or null when nothing is set.
 */
export function scheduleDocValue(doc) {
  if (!doc || !Array.isArray(doc.days)) return null;
  const days = normalizeDays(doc.days);
  if (!days) return null;
  return {
    staffId: Number(doc.staffId) || null,
    days,
    updatedAt: doc.updatedAt ?? null,
    updatedByName: doc.updatedByName ?? null,
    history: Array.isArray(doc.history) ? doc.history.slice(-SCHEDULE_HISTORY_MAX) : [],
  };
}

/**
 * Whether a Time IN may land right now, and why not.
 * Mirrors the POS Time-in gating; the device tap uses the same rule.
 */
export function scheduleVerdict(doc, nowMs = Date.now(), event = "IN") {
  const sched = scheduleDocValue(doc);
  if (!sched) return { scheduled: false }; // no schedule = unrestricted (legacy staff)
  const dayIdx = manilaWeekday(nowMs);
  const entry = sched.days[dayIdx];
  if (!entry) {
    return {
      scheduled: true,
      ok: false,
      reason: `${WEEKDAY_LABEL[dayIdx]} is your scheduled day off - ask OWNER to change your schedule.`,
    };
  }
  const now = manilaMinutesOfDay(nowMs);
  const start = hmToMinutes(entry.start);
  const end = hmToMinutes(entry.end);
  if (event === "IN") {
    const open = start - 15; // 15-minute early grace
    if (now >= open && now <= end) return { scheduled: true, ok: true, entry, start, end };
    if (now < open) {
      return {
        scheduled: true,
        ok: false,
        reason: `Time in opens 15 minutes before your scheduled start (${entry.start}). You may tap from ${String(Math.floor(open / 60)).padStart(2, "0")}:${String(open % 60).padStart(2, "0")}.`,
      };
    }
    return {
      scheduled: true,
      ok: false,
      reason: `Your scheduled shift today ended at ${entry.end}. Ask OWNER if you worked more.`,
    };
  }
  // Time OUT
  if (now >= start && now <= end + 60) return { scheduled: true, ok: true, entry, start, end };
  if (now < start) {
    return {
      scheduled: true,
      ok: false,
      reason: `Your scheduled shift starts at ${entry.start}. You may time out only from then.`,
    };
  }
  return {
    scheduled: true,
    ok: false,
    reason: `Your scheduled shift ended at ${entry.end} (overtime window is 60 minutes). Ask OWNER to log your hours.`,
  };
}

/** "90m" -> "1h 30m"; plain minutes under an hour. */
export function fmtMinutes(m) {
  const abs = Math.max(0, Math.round(m));
  if (abs < 60) return `${abs}m`;
  return `${Math.floor(abs / 60)}h ${String(abs % 60).padStart(2, "0")}m`;
}

/**
 * Classify a single tap EVENT against the scheduled window (used by Shift
 * History, which lists IN and OUT taps as separate rows).
 *   IN : On time (within 5 min of start, incl. early arrival) | Tardy +Nm
 *   OUT: Early out Nm | On time
 * Returns { label, tone } with tone one of ok|warn|info|neutral.
 */
export function tapBadge({ event, instant, entry }) {
  if (!entry) return { label: "No schedule", tone: "neutral" };
  const d = new Date(instant);
  const t = Number.isFinite(d.getTime()) ? manilaMinutesOfDay(d.getTime()) : null;
  if (t == null) return { label: "—", tone: "neutral" };
  const start = hmToMinutes(entry.start);
  const end = hmToMinutes(entry.end);
  if (event === "IN") {
    const late = t - start;
    if (late <= 5) return { label: "On time", tone: "ok" };
    return { label: `Tardy +${fmtMinutes(late)}`, tone: "warn" };
  }
  // Time OUT
  const early = end - t;
  if (early > 5) return { label: `Early out ${fmtMinutes(early)}`, tone: "warn" };
  return { label: "On time", tone: "ok" };
}

/** Which weekday entry a tap belongs to (null = that weekday is a day off). */
export function entryForInstant(rawScheduleDoc, instant) {
  const sched = scheduleDocValue(rawScheduleDoc);
  if (!sched) return undefined; // no schedule at all — distinct from a scheduled day off
  return sched.days[manilaWeekday(new Date(instant).getTime())] ?? null;
}


