// Password-reset (forgot password via Gmail OTP) shared rules.
// Pure functions so the policy is unit-testable without a database.
// The same constants are mirrored in supabase/functions/api/index.ts
// (production Edge path) — keep both in sync when changing policy.

import { createHash, randomInt, timingSafeEqual } from "node:crypto";

// 6-digit numeric OTP: easy to retype from the Gmail app on a phone.
// 1M combinations is safe here because codes are single-use, expire fast,
// and wrong guesses are capped per code (see OTP_MAX_ATTEMPTS).
export const OTP_LENGTH = 6;
export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
// Silent resend cooldown: a second request inside the window returns the
// same generic success without minting or sending a new code (this also
// avoids leaking account existence through 429s).
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000;

// Generic responses: identical whether or not the email maps to an account,
// so the endpoints can't be used to enumerate registered emails.
export const FORGOT_GENERIC_MESSAGE =
  "If an account exists for this email, a reset code was sent.";
export const RESET_INVALID_MESSAGE = "Invalid or expired code.";

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
