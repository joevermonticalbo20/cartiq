// Shared input validation for names, usernames, and recovery-email
// deliverability. Pure functions so the policy is unit-testable without a
// database. The same helpers are mirrored in
// supabase/functions/api/index.ts (production Edge path) — keep both in sync
// when changing policy; api/test/validation.test.js exercises the rules.

import { normalizeEmail, validEmail, isPlaceholderEmail } from "./password_reset.js";

// Common disposable/throwaway domains. They can be revisited freely and are
// never accepted as recovery addresses.
const DISPOSABLE_EMAIL_DOMAINS = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "10minutemail.com",
  "tempmail.com",
  "throwawaymail.com",
  "yopmail.com",
  "sharklasers.com",
  "maildrop.cc",
  "getnada.com",
  "fakeinbox.com",
  "temp-mail.org",
  "dispostable.com",
]);

/** domain of a normalized email, or null */
export function emailDomain(email) {
  const e = normalizeEmail(email);
  const at = e.lastIndexOf("@");
  return at > 0 ? e.slice(at + 1) : null;
}

/** Disposable/throwaway deliverability domains are blocked for recovery. */
export function isDisposableEmail(email) {
  const domain = emailDomain(email);
  if (!domain) return false;
  const root = domain.split(".").slice(-2).join(".");
  return DISPOSABLE_EMAIL_DOMAINS.has(domain) || DISPOSABLE_EMAIL_DOMAINS.has(root);
}

/**
 * Totally rejection-based domain check (the user asked for “must exist”).
 * Uses DNS-over-HTTPS (Cloudflare) so it works in Node and Deno alike.
 * Results are cached for 10 minutes because DNS state changes slowly.
 */
const mxCache = new Map();
export async function hasMailExchange(domain) {
  const d = String(domain ?? "").trim().toLowerCase().replace(/^\./, "");
  if (!d) return false;
  const now = Date.now();
  const hit = mxCache.get(d);
  if (hit && hit.exp > now) return hit.ok;
  let ok = false;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(d)}&type=MX`,
      { headers: { accept: "application/dns-json" }, signal: controller.signal }
    );
    clearTimeout(timeout);
    if (res.ok) {
      const json = await res.json();
      ok = Array.isArray(json?.Answer) && json.Answer.length > 0;
    }
  } catch {
    ok = false;
  }
  mxCache.set(d, { exp: now + 10 * 60 * 1000, ok });
  return ok;
}

/** Full recovery-email check (format + domain existence). */
export async function validateRecoveryEmail(raw) {
  // The owner's rule: uppercase anywhere in the address is refused outright
  // (Gmail.com with a capital G is not accepted). Leading/trailing spaces are
  // trimmed automatically. The value is stored lowercased.
  const trimmed = String(raw ?? "").trim();
  if (trimmed !== trimmed.toLowerCase()) {
    return { ok: false, email: trimmed.toLowerCase(), error: "Please enter a valid email address." };
  }
  const email = normalizeEmail(trimmed);
  if (!email || !validEmail(email)) {
    return { ok: false, email, error: "Please enter a valid email address." };
  }
  if (isPlaceholderEmail(email)) {
    return { ok: false, email, error: "Enter a real email address, not a placeholder" };
  }
  if (isDisposableEmail(email)) {
    return { ok: false, email, error: "Disposable email domains are not allowed for recovery" };
  }
  const domain = emailDomain(email);
  if (!domain || !(await hasMailExchange(domain))) {
    return { ok: false, email, error: "This email domain does not exist (check spelling)" };
  }
  return { ok: true, email };
}

/* ------------------------------------------------------------------ */
/* Names                                                               */
/* ------------------------------------------------------------------ */

const CONTROL_RE = /[\u0000-\u001F\u007F]/g;

// ---------------------------------------------------------------------------
// Single-line text fields shared by several modules (Category, Flavor name,
// recipe item names, Vendor). One rule fits them all:
//
//   required; whitespace collapsed to single spaces; trimmed;
//   min .. max characters; whitespace-only input refused.
//
// These are deliberately STRICTER than the old 2-letter free-text rules,
// because the owner's spec demands them. Returns { ok, value, error }.
// ---------------------------------------------------------------------------
export function validateTextLine(raw, { label, min, max }) {
  let value = String(raw ?? "").replace(CONTROL_RE, "").replace(/\s+/g, " ").trim();
  if (!value) return { ok: false, value, error: `${label} is required.` };
  if (value.length < min) {
    return { ok: false, value, error: `${label} must be at least ${min} characters.` };
  }
  if (value.length > max) {
    return { ok: false, value, error: `${label} must not exceed ${max} characters.` };
  }
  return { ok: true, value };
}

/** Add Expense – Vendor name. Returns { ok, value, error }. */
export function validateVendorName(raw) {
  return validateTextLine(raw, { label: "Vendor", min: 3, max: 30 });
}

// Allow letters (any script), numbers, spaces, hyphen, apostrophe, period,
// ampersand, hash, parentheses, colon, plus, asterisk, and slash. Everything
// else (control chars, HTML markup, emoji) is rejected so names cannot be
// smuggled as code.
// ---------------------------------------------------------------------------
// Account holders: staff and admin names + usernames.
//
// The owner's exact rules (Add Staff Account / Add Admin Account):
//
//   Full name - required, 2..30 characters; Unicode letters (incl. Filipino
//   and accented), spaces, hyphens and apostrophes ONLY; numbers and every
//   other special character refused; at least TWO LETTERS ("Nb" is not a
//   name); no run of 3+ identical letters anywhere (so "AAa", "aaaa" and
//   "AAaaAAaa aaaAA" are refused while "Aaron" and "Yyan" are fine).
//
//   Username - min 4, max 20 characters; must start with an English letter;
//   only a-z, 0-9, underscore (_) and period (.); spaces and every other
//   special are strictly prohibited; no consecutive underscores or periods
//   (same or mixed); must END with a letter or digit; case-insensitive
//   (Admin123 == admin123); reserved system words and offensive terms are
//   refused; leading/trailing spaces trimmed automatically.
//
// These are deliberately STRICTER than the general name/username validator,
// which stays: it is used for vendors, items, products and other free-text names.
// ---------------------------------------------------------------------------

const _ACCOUNT_NAME_ALLOWED = /^[\p{L}\p{M} '-]+$/u;

// Unicode letters, spaces, hyphens and apostrophes ONLY - no digits, no other
// punctuation, so HTML/markup cannot be built from this charset.
// (Note: these two are reused by validateFullName below.)
const _ACCOUNT_SAME_LETTER_RUN = /(\p{L})\1\1/iu;

// Reserved for the system's own use - exact matches only.
const _RESERVED_USERNAMES = new Set([
  "admin", "administrator", "superadmin", "root", "system", "owner", "support",
  "help", "security", "staff", "service", "manager", "cashier", "pos", "cartiq",
  "api", "auth", "login", "password", "reset", "account",
  "null", "undefined", "anonymous", "nobody", "unknown", "user", "test",
  "none", "guest", "demo", "default", "everyone", "postmaster",
  "abuse", "noreply", "no-reply", "webmaster", "www", "mail", "ftp", "info",
  "dev", "developer", "debug", "localhost", "backup", "sysadmin",
]);
// Offensive terms are refused as SUBSTRINGS (so "puta123" is out).
const _OFFENSIVE_USERNAMES = [
  "fuck", "fucking", "fucker", "shit", "bitch", "asshole", "cunt", "bastard",
  "whore", "slut", "nigger", "faggot", "retard", "puta", "punyeta", "punyetr",
  "putangina", "gago", "bobo", "tanga", "ulol", "pakyu",
];

export const FULL_NAME_MAX = 30;
export const USERNAME_MAX = 20;
const _USERNAME_STARTS_LETTER = /^[a-z]/u;
const _USERNAME_ALLOWED = /^[a-z0-9_.]+$/;
const _USERNAME_ALNUM_END = /[a-z0-9]$/;
const _USERNAME_CONSECUTIVE = /[._]{2}/;

export function cleanFullName(raw) {
  return String(raw ?? "").replace(/\s+/g, " ").trim();
}

/** Full name for a staff/admin account. Returns { ok, value, error }. */
export function validateFullName(raw) {
  const value = cleanFullName(raw);
  if (!value) return { ok: false, value, error: "Full name is required." };
  if (value.length < 2) {
    return { ok: false, value, error: "Full name must be at least 2 characters." };
  }
  if (value.length > FULL_NAME_MAX) {
    return { ok: false, value, error: "Full name must not exceed 30 characters." };
  }
  // Numbers or anything that is not a letter/space/hyphen/apostrophe are out.
  if (!_ACCOUNT_NAME_ALLOWED.test(value)) {
    return { ok: false, value, error: "Full name cannot contain numbers or special characters." };
  }
  // At least one letter: "@@@@@" (or an all-punctuation run) is not a name.
  const letterCount = (value.match(/\p{L}/gu) ?? []).length;
  if (letterCount < 2) {
    // At least two letters - "A", "-'-" and "A-" are not names.
    return { ok: false, value, error: "Please enter a valid full name." };
  }
  // No run of 3+ identical letters anywhere in the name.
  if (_ACCOUNT_SAME_LETTER_RUN.test(value)) {
    return { ok: false, value, error: "Please enter a valid full name." };
  }
  return { ok: true, value };
}

/** Username for a staff/admin account. Lowercased before validating. */
export function validateAccountUsername(raw) {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return { ok: false, value, error: "Username is required." };
  if (/\s/.test(value) || /[^a-z0-9_.]/.test(value)) {
    return { ok: false, value, error: "Username cannot contain spaces or special characters." };
  }
  if (value.length < 4 || value.length > USERNAME_MAX) {
    return { ok: false, value, error: "Username must be between 4 and 20 characters." };
  }
  if (!_USERNAME_STARTS_LETTER.test(value)) {
    return { ok: false, value, error: "Username must start with a letter." };
  }
  // No two consecutive periods or underscores (same or mixed: "..", "__", "._")
  if (_USERNAME_CONSECUTIVE.test(value)) {
    return { ok: false, value, error: "Username cannot contain consecutive underscores or periods." };
  }
  if (!_USERNAME_ALNUM_END.test(value)) {
    return { ok: false, value, error: "Username must end with a letter or number." };
  }
  if (_RESERVED_USERNAMES.has(value)) {
    return { ok: false, value, error: "This username is reserved for the system." };
  }
  if (_OFFENSIVE_USERNAMES.some((term) => value.includes(term))) {
    return { ok: false, value, error: "This username contains inappropriate language." };
  }
  if (!_USERNAME_ALLOWED.test(value)) {
    return { ok: false, value, error: "Please enter a valid username." };
  }
  return { ok: true, value };
}

const NAME_RE = /^[\p{L}\p{N}\p{M}][\p{L}\p{N}\p{M}\p{Pc}\p{Pd}'.\-&#\/()+:* ]*$/u;
const LETTER_RE = /\p{L}/gu;

/** Trim, strip control characters, and collapse repeated whitespace. */
export function cleanName(raw, max = 100) {
  let s = String(raw ?? "").replace(CONTROL_RE, "").replace(/\s+/g, " ").trim();
  if (s.length > max) s = s.slice(0, max);
  return s;
}

export function countLetters(s) {
  const m = String(s ?? "").match(LETTER_RE);
  return m ? m.length : 0;
}

/**
 * Person/vendor/product/item names: 2..max chars, at least 2 letters,
 * no unsupported symbols (digits are only valid alongside letters).
 */
export function validateName(raw, label = "Name", max = 100) {
  const value = cleanName(raw, max);
  if (!value) return { ok: false, value, error: `${label} is required.` };
  if (value.length < 2) return { ok: false, value, error: `${label} needs at least 2 characters.` };
  if (countLetters(value) < 2) return { ok: false, value, error: `${label} needs at least 2 letters.` };
  if (!NAME_RE.test(value)) {
    return { ok: false, value, error: `${label} may contain only letters, numbers, spaces, -, ', ., #, / and &. ` };
  }
  return { ok: true, value };
}

/** Reasons/notes: 3..500 chars, keeps letters/symbols, rejects control chars. */
export function validateReason(raw, label = "Reason") {
  const value = String(raw ?? "").replace(CONTROL_RE, "").trim();
  if (!value) return { ok: false, value, error: `${label} is required.` };
  if (value.length < 3) return { ok: false, value, error: `${label} needs at least 3 characters.` };
  if (value.length > 500) return { ok: false, value, error: `${label} must be at most 500 characters.` };
  return { ok: true, value };
}

/* ------------------------------------------------------------------ */
/* Username                                                            */
/* ------------------------------------------------------------------ */

// Usernames for staff/admin accounts are validated by
// validateAccountUsername() above - that is the only username rule the
// product has, so there is no second, looser one to drift out of sync.
