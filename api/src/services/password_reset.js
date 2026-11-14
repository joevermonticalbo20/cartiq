// Password-reset (forgot password via Gmail OTP) shared rules.
// Pure functions so the policy is unit-testable without a database.
// The same constants are mirrored in supabase/functions/api/index.ts
// (production Edge path) — keep both in sync when changing policy.

import { createHash, randomInt, timingSafeEqual } from "node:crypto";

// 6-digit numeric OTP: easy to retype from the Gmail app on a phone.
// 1M combinations is safe here because codes are single-use, expire fast,
// and wrong guesses are capped per code (see OTP_MAX_ATTEMPTS).
export const OTP_LENGTH = 6;
// A code is good for five minutes. Long enough to retype it, short enough
// that a code that leaks (a shared inbox, an old phone) is worthless soon.
export const OTP_TTL_MS = 5 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
// Silent resend cooldown: a second request inside the window returns the
// same generic success without minting or sending a new code (this also
// avoids leaking account existence through 429s).
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
// --- resend / anti-spam policy -------------------------------------------
// How many codes one address may receive in a window, and what happens when
// it asks for more. The cap is on SUCCESSFUL sends: a delivery that failed
// did not reach anyone, so it must not burn the budget.
export const OTP_MAX_SENDS_PER_WINDOW = 5;
export const OTP_SEND_WINDOW_MS = 15 * 60 * 1000;
// After the cap is reached the address is locked out for this long. The
// window and the lockout are the same length, so the budget starts fresh
// when the lockout ends.
export const OTP_LOCKOUT_MS = 15 * 60 * 1000;
// The whole system may only send this many codes per hour. A backstop against
// a spray across many addresses (email bombing).
export const OTP_GLOBAL_MAX_SENDS_PER_HOUR = 200;
export const OTP_GLOBAL_WINDOW_MS = 60 * 60 * 1000;

// Two OTP purposes share passwordResets. Legacy documents were all resets,
// so a missing purpose must keep working as "reset" forever.
export const OTP_PURPOSE_RESET = "reset";
export const OTP_PURPOSE_CHANGE = "change";
export const OTP_PURPOSE_VERIFY = "verify";

// Generic responses: identical whether or not the email maps to an account,
// so the endpoints can't be used to enumerate registered emails.
export const FORGOT_GENERIC_MESSAGE =
  "If an account exists for this email, a reset code was sent.";
export const RESET_INVALID_MESSAGE = "Invalid or expired code.";
export const CHANGE_INVALID_MESSAGE = "Invalid or expired code.";
export const EMAIL_VERIFY_REQUIRED_MESSAGE =
  "Enter the 6-digit code sent to that email. If your CartIQ app has no code field, update to the latest version.";
export const APP_UPDATE_REQUIRED_MESSAGE =
  "Enter the 6-digit code sent to your recovery email. If your CartIQ app has no code field, update to the latest version.";
export const RECOVERY_EMAIL_REQUIRED_MESSAGE =
  "Add a real recovery email in Settings before changing your password.";

// Profiles without a real email still need a visible, editable placeholder.
// It is deliberately non-deliverable: Gmail refuses .local recipients, so the
// sender skips it instead of burning an API call. The UI renders the same
// value for a null email and badges it as a placeholder.
export const PLACEHOLDER_EMAIL_DOMAIN = "cartiq.local";

/** Normalize an email for storage/lookup (trim + lowercase). */
export function normalizeEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

/** Format check only (existence is never revealed — see generic messages). */
export function validEmail(value) {
  const v = String(value ?? "").trim();
  if (!v || v.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

/** Cryptographically random 6-digit code, zero-padded ("004821" possible). */
export function generateOtp() {
  return String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, "0");
}

/** SHA-256 hex of the code — only the hash is ever persisted. */
export function hashOtp(code) {
  return createHash("sha256").update(String(code)).digest("hex");
}

/** Constant-time comparison so code checks don't leak prefix info. */
export function otpMatches(code, storedHash) {
  const a = Buffer.from(hashOtp(code), "hex");
  let b;
  try {
    b = Buffer.from(String(storedHash), "hex");
  } catch {
    return false;
  }
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Purpose of a persisted OTP; legacy rows (no field) are resets. */
export function otpPurpose(record) {
  const p = record?.purpose;
  if (p === OTP_PURPOSE_CHANGE || p === OTP_PURPOSE_VERIFY) return p;
  return OTP_PURPOSE_RESET;
}

/**
 * The verdict on a typed code, WITHOUT changing anything.
 *
 * The recovery-email dialog turns its field red or green as the code is
 * typed, and only the server holds the code - so the server has to answer.
 * This never consumes an attempt: saving the email does. The guard is the
 * code's own lifetime (10 minutes) plus the endpoint's rate limit.
 *
 * Reasons: "no_code" (nothing was requested), "expired", "wrong".
 */
export function evaluateCode(record, code, now = Date.now()) {
  if (!record) return { valid: false, reason: "no_code" };
  const expiresAt = new Date(record.expiresAt ?? 0).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    return { valid: false, reason: "expired" };
  }
  if (!otpMatches(code, record.tokenHash)) {
    return { valid: false, reason: "wrong" };
  }
  return { valid: true };
}

/**
 * The verdict on a send request, from the counters kept for that address.
 *
 * [state] is what the rate-limit document holds:
 *   { windowStartedAt, sends, lastSentAt, lockedUntil }
 *
 * The rules, in order:
 *   1. a lockout that has not expired blocks everything;
 *   2. a successful send in the last 60 s blocks a new one (the cooldown);
 *   3. 5 successful sends in 15 minutes is the cap - the 6th is refused and
 *      the address is locked out for 15 minutes.
 *
 * A window that has expired starts over, so an address that waited out the
 * lockout may send again (subject to the cooldown and the cap).
 *
 * Returns { allowed: true, windowStartedAt, sends } when the send may go out,
 * or { allowed: false, reason, retryAfterMs, lockedUntil } when it may not.
 */
export function evaluateSendPolicy(state, now = Date.now()) {
  const s = state ?? {};
  const lockedUntil = Number(s.lockedUntil ?? 0) || 0;
  if (lockedUntil > now) {
    return {
      allowed: false,
      reason: "locked",
      retryAfterMs: lockedUntil - now,
      lockedUntil,
    };
  }
  const lastSentAt = Number(s.lastSentAt ?? 0) || 0;
  if (lastSentAt && now - lastSentAt < OTP_RESEND_COOLDOWN_MS) {
    return {
      allowed: false,
      reason: "cooldown",
      retryAfterMs: OTP_RESEND_COOLDOWN_MS - (now - lastSentAt),
    };
  }
  const windowStartedAt = Number(s.windowStartedAt ?? 0) || 0;
  const inWindow = windowStartedAt && now - windowStartedAt < OTP_SEND_WINDOW_MS;
  const sends = inWindow ? Number(s.sends ?? 0) || 0 : 0;
  if (sends >= OTP_MAX_SENDS_PER_WINDOW) {
    // The cap is reached: lock the address out for the lockout period. The
    // window is the same length, so the budget is fresh when it ends.
    const until = (inWindow ? windowStartedAt : now) + OTP_LOCKOUT_MS;
    return {
      allowed: false,
      reason: "locked",
      retryAfterMs: Math.max(0, until - now),
      lockedUntil: until,
    };
  }
  return {
    allowed: true,
    windowStartedAt: inWindow ? windowStartedAt : now,
    sends,
  };
}

/**
 * The verdict on the system-wide cap (how many codes the whole service may
 * send per hour). Same shape as [evaluateSendPolicy].
 */
export function evaluateGlobalPolicy(state, now = Date.now(), max = OTP_GLOBAL_MAX_SENDS_PER_HOUR) {
  const s = state ?? {};
  const windowStartedAt = Number(s.windowStartedAt ?? 0) || 0;
  const inWindow = windowStartedAt && now - windowStartedAt < OTP_GLOBAL_WINDOW_MS;
  const sends = inWindow ? Number(s.sends ?? 0) || 0 : 0;
  if (sends >= max) {
    const until = (inWindow ? windowStartedAt : now) + OTP_GLOBAL_WINDOW_MS;
    return {
      allowed: false,
      reason: "global_limit",
      retryAfterMs: Math.max(0, until - now),
      lockedUntil: until,
    };
  }
  return {
    allowed: true,
    windowStartedAt: inWindow ? windowStartedAt : now,
    sends,
  };
}

/** The document id for an address (hashed: the id may not leak the address). */
export function otpLimitId(email) {
  return hashOtp(normalizeEmail(email));
}

/** A visible but non-deliverable recovery address, e.g. staff01@cartiq.local. */
export function placeholderEmailFor(username) {  const local = String(username ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "");
  return `${local || "staff"}@${PLACEHOLDER_EMAIL_DOMAIN}`;
}

export function isPlaceholderEmail(value) {
  return normalizeEmail(value).endsWith(`@${PLACEHOLDER_EMAIL_DOMAIN}`);
}

/** j***@gmail.com - enough for the user to recognise the inbox. */
export function maskEmail(value) {
  const email = normalizeEmail(value);
  const at = email.lastIndexOf("@");
  if (at <= 0) return "";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const shown = local.slice(0, Math.min(2, local.length));
  return `${shown}${"*".repeat(Math.max(3, local.length - shown.length))}@${domain}`;
}
