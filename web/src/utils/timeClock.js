// The owner-configured daily clock-in / clock-out windows.
//
// The rule that keeps a schedule honest: a shift must start before it can end,
// so the Time out window may not be earlier than the Time in window. "Time in
// 4:00 PM - 4:10 PM" with "Time out 3:00 PM - 3:10 PM" is not a schedule, it
// is a mistake that would leave a vendor unable to ever clock out.
//
// The all-day schedule (both windows 12:00 AM - 11:59 PM) stays valid - that
// is a real choice for a stall, not a mistake.
//
// Mirrors the server rule (api/src/services/time_clock.js), which refuses the
// same schedule on save.

/** "HH:MM" 24h -> minutes since midnight, or NaN. */
export const hmToMinutes = (v) => {
  if (typeof v !== "string") return NaN;
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(v);
  if (!m) return NaN;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return NaN;
  return h * 60 + min;
};

/**
 * Why this schedule is impossible, or null when it is fine.
 *
 * Returns a sentence for the owner, or null when the schedule may be saved.
 */
export const timeClockScheduleError = ({
  inOpen,
  inClose,
  outOpen,
  outClose,
} = {}) => {
  const iOpen = hmToMinutes(inOpen);
  const iClose = hmToMinutes(inClose);
  const oOpen = hmToMinutes(outOpen);
  const oClose = hmToMinutes(outClose);
  // Garbage in, garbage out: the caller validates the shape first.
  if ([iOpen, iClose, oOpen, oClose].some(Number.isNaN)) return null;
  if (oOpen < iOpen || oClose < iClose) {
    return "Time out cannot be earlier than Time in - a shift must start before it can end.";
  }
  return null;
};
