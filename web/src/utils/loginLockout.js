/**
 * Login-lockout helpers shared by the sign-in UI.
 *
 * The API returns `retryAfterSeconds` and `lockedUntil` alongside the 429.
 * Callers tick the countdown locally so "wait 4:59" stays accurate without
 * polling the server on every second.
 */

function payload(err) {
  return err?.data ?? err?.response?.data ?? null;
}

/** Whole seconds until a locked account may try again; null if not locked. */
export function lockoutSecondsFromError(err, now = Date.now()) {
  const data = payload(err);
  const direct = Number(data?.retryAfterSeconds);
  if (Number.isFinite(direct) && direct > 0) return Math.ceil(direct);
  const until = Date.parse(data?.lockedUntil ?? "");
  if (Number.isFinite(until)) {
    return Math.max(0, Math.ceil((until - now) / 1000));
  }
  return null;
}

/** Attempts left in the current five-failure run; null when absent. */
export function attemptsRemainingFromError(err) {
  const value = Number(payload(err)?.attemptsRemaining);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/** "4:59" - minutes and zero-padded seconds. */
export function formatLockCountdown(seconds) {
  const safe = Math.max(0, Math.ceil(Number(seconds) || 0));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}
