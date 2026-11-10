// Local-date helpers.
//
// The app runs in the Philippines (UTC+8), so `new Date().toISOString()` is
// the UTC date - which is YESTERDAY between 00:00 and 08:00 local time. A date
// field pre-filled with that would save the expense on the wrong day.

/** Today in the browser's own timezone, as "YYYY-MM-DD". */
export function localToday(d = new Date()) {
  const tzOffset = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tzOffset).toISOString().slice(0, 10);
}

/** The current local month, as "YYYY-MM". */
export function localMonth(d = new Date()) {
  const tzOffset = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tzOffset).toISOString().slice(0, 7);
}
