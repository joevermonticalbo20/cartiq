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
