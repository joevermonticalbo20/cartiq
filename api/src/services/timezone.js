// CartIQ Manila timezone helper — server runs on Render (UTC) but the
// business day is Asia/Manila (UTC+8, no DST). All "today"/daily boundaries
// must use Manila midnight, not server-local midnight.
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

export function manilaDayStart(daysAgo = 0) {
  const manilaNow = new Date(Date.now() + MANILA_OFFSET_MS);
  manilaNow.setUTCHours(0, 0, 0, 0);
  manilaNow.setUTCDate(manilaNow.getUTCDate() - daysAgo);
  return new Date(manilaNow.getTime() - MANILA_OFFSET_MS);
}

export function manilaDayRange(dateStr) {
  // dateStr YYYY-MM-DD is interpreted as a Manila calendar day.
  const start = new Date(`${dateStr}T00:00:00+08:00`);
  if (!Number.isFinite(start.getTime())) return null;
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

const pad2 = (n) => String(n).padStart(2, "0");

// Shift an instant into "Manila wall-clock space": the UTC getters of the
// result read Manila calendar fields, independent of server timezone.
function inManila(date) {
  return new Date(new Date(date).getTime() + MANILA_OFFSET_MS);
}

/** YYYY-MM-DD calendar date in Manila for any instant. */
export function manilaDayKey(date) {
  const m = inManila(date);
  return `${m.getUTCFullYear()}-${pad2(m.getUTCMonth() + 1)}-${pad2(m.getUTCDate())}`;
}

/** Weekday 0-6 in Manila for any instant. */
export function manilaDow(date) {
  return inManila(date).getUTCDay();
}

/** Hour 0-23 in Manila for any instant. */
export function manilaHour(date) {
  return inManila(date).getUTCHours();
}

/** Weekday 0-6 for a bare "YYYY-MM-DD" Manila calendar key, TZ-safe. */
export function manilaDowOfKey(key) {
  return new Date(`${key}T00:00:00Z`).getUTCDay();
}

/** "HH:MM" wall time in Manila for any instant (export labels). */
export function manilaTimeHM(date) {
  const m = inManila(date);
  return `${pad2(m.getUTCHours())}:${pad2(m.getUTCMinutes())}`;
}

/**
 * Today as a Manila calendar date anchored at UTC midnight: UTC getters
 * (getUTCDay/setUTCDate) do Manila-calendar arithmetic on it, and
 * toISOString().slice(0, 10) is the Manila YYYY-MM-DD label.
 */
export function manilaCalendarToday() {
  const m = new Date(Date.now() + MANILA_OFFSET_MS);
  return new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), m.getUTCDate()));
}

/** Month boundaries as Manila-midnight instants (Manila has no DST). */
export function manilaMonthRange(month) {
  if (!month || !/^\d{4}-\d{2}$/.test(String(month))) return null;
  const [y, m] = String(month).split("-").map(Number);
  return {
    start: new Date(Date.UTC(y, m - 1, 1) - MANILA_OFFSET_MS),
    end: new Date(Date.UTC(y, m, 1) - MANILA_OFFSET_MS),
  };
}
