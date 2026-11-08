// Shared input validation for names, usernames, and recovery-email
// deliverability. Pure functions so the policy is unit-testable without a
// database. The same helpers are mirrored in
// supabase/functions/api/index.ts (production Edge path) — keep both in sync
// when changing policy; api/test/validation.test.js exercises the rules.

import { normalizeEmail, validEmail, isPlaceholderEmail } from "./password_reset.js";

export const USERNAME_RE = /^[a-z0-9._-]{3,30}$/;

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
  const email = normalizeEmail(raw);
  if (!email || !validEmail(email)) {
    return { ok: false, email, error: "email must be a valid email address" };
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
// Allow letters (any script), numbers, spaces, hyphen, apostrophe, period,
// ampersand, hash, parentheses, colon, plus, asterisk, and slash. Everything
// else (control chars, HTML markup, emoji) is rejected so names cannot be
// smuggled as code.
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

/** Usernames are trimmed + lowercased so typed case never matters. */
export function cleanUsername(raw) {
  return String(raw ?? "").trim().toLowerCase();
}

export function validateUsername(raw) {
  const value = cleanUsername(raw);
  if (!value) return { ok: false, value, error: "Username is required." };
  if (!USERNAME_RE.test(value)) {
    return {
      ok: false,
      value,
      error: "Username must be 3-30 chars: a-z, 0-9, dot, underscore or hyphen.",
    };
  }
  if (value.startsWith(".") || value.endsWith(".") || value.includes("..")) {
    return { ok: false, value, error: "Username cannot start or end with a dot, and cannot have consecutive dots." };
  }
  return { ok: true, value };
}
