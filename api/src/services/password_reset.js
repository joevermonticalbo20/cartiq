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

/** A visible but non-deliverable recovery address, e.g. staff01@cartiq.local. */
export function placeholderEmailFor(username) {
  const local = String(username ?? "")
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
