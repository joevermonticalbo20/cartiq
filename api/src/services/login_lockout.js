// Login lockout policy shared by the Express route. The Edge function keeps
// an identical copy in supabase/functions/api/index.ts - update both.
//
// Policy: five failed passwords are allowed. The fifth failure arms a
// five-minute lock; every attempt during it (even a correct password) gets
// 429 with the remaining whole seconds. A successful login clears the state.
// Once the lock expires the next failure starts a fresh five-attempt cycle.
import { createHash } from "node:crypto";

export const LOGIN_MAX_FAILED_ATTEMPTS = 5;
export const LOGIN_LOCK_MS = 5 * 60 * 1000;
// Four stale failures should not haunt someone days later. Failures are only
// counted while they are at most this far apart.
export const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
// Coarse per-IP spray guard. The per-username lock above is the real limit;
// this only stops one host trying many different accounts.
export const LOGIN_IP_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_IP_MAX_ATTEMPTS = 60;

/** Usernames are trimmed for lookup; case is normalized only for the lock. */
export function normalizeLoginUsername(username) {
  return String(username ?? "").trim();
}

/** Stable, path-safe Firestore doc id. Usernames may contain "/" or "%". */
export function loginAttemptKey(username) {
  return createHash("sha256")
    .update(normalizeLoginUsername(username).toLowerCase())
    .digest("hex");
}

/** Milliseconds until another attempt is allowed; 0 when not locked. */
export function lockRemainingMs(state, now = Date.now()) {
  const lockedUntil = Number(state?.lockedUntilMs ?? 0);
  return Number.isFinite(lockedUntil) && lockedUntil > now ? lockedUntil - now : 0;
}

/** Whole seconds a client should wait, rounded up. 0 means no lock. */
export function retryAfterSeconds(remainingMs) {
  const ms = Math.max(0, Number(remainingMs) || 0);
  return ms > 0 ? Math.max(1, Math.ceil(ms / 1000)) : 0;
}

/**
 * Next state after a bad password. An expired lock or a failure outside the
 * window resets the run, so five fresh attempts are always available.
 */
export function registerLoginFailure(state, now = Date.now()) {
  const lockedUntil = Number(state?.lockedUntilMs ?? 0);
  if (Number.isFinite(lockedUntil) && lockedUntil > now) {
    // Another request armed the lock while this one was being checked.
    // Never extend an active lock.
    return {
      failedCount: Math.max(0, Number(state?.failedCount) || 0),
      lastFailedAtMs: Number(state?.lastFailedAtMs) || now,
      lockedUntilMs: lockedUntil,
      locked: true,
      attemptsRemaining: 0,
    };
  }

  const lastFailedAt = Number(state?.lastFailedAtMs ?? 0);
  const lockExpired = lockedUntil > 0 && lockedUntil <= now;
  const inWindow =
    lastFailedAt > 0 && now - lastFailedAt < LOGIN_FAILURE_WINDOW_MS;
  const previous =
    lockExpired || !inWindow ? 0 : Math.max(0, Number(state?.failedCount) || 0);
  const failedCount = previous + 1;
  const locked = failedCount >= LOGIN_MAX_FAILED_ATTEMPTS;

  return {
    failedCount,
    lastFailedAtMs: now,
    lockedUntilMs: locked ? now + LOGIN_LOCK_MS : 0,
    locked,
    attemptsRemaining: Math.max(0, LOGIN_MAX_FAILED_ATTEMPTS - failedCount),
  };
}

/** "4:59" - compact, locale-independent, and easy to tick down client-side. */
export function formatRetryAfter(seconds) {
  const safe = Math.max(0, Math.ceil(Number(seconds) || 0));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

export function loginLockMessage(seconds) {
  return `Too many failed attempts. Wait ${formatRetryAfter(seconds)} and try again.`;
}
