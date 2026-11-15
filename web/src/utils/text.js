// Shared text-input rules for vendor/note/item-name fields (single source
// so web and mobile validate identically):
//  - vendor: 3-30 chars; note: 2-40 chars; item names: 2-30 chars
//  - text-line fields (category, flavor name, recipe item): declared per call
//  - single spaces only: runs collapse to one, ends trimmed
export const TEXT_MIN_LETTERS = 2;
export const TEXT_MAX = 40;
export const ITEM_NAME_MAX = 30;
export const VENDOR_MIN = 3;
export const VENDOR_MAX = 30;

// Strict check for a single-line text field (Category, Flavor name, recipe
// item names - the owner's 3/20/30 char limits). Collapses whitespace runs,
// trims, and rejects whitespace-only input. Returns { ok, value, error }.
export function validateTextLine(raw, { label, min, max }) {
  const value = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!value) return { ok: false, value, error: `${label} is required.` };
  if (value.length < min) {
    return { ok: false, value, error: `${label} must be at least ${min} characters.` };
  }
  if (value.length > max) {
    return { ok: false, value, error: `${label} must not exceed ${max} characters.` };
  }
  return { ok: true, value };
}

export function countLetters(s) {
  const m = String(s ?? "").match(/\p{L}/gu);
  return m ? m.length : 0;
}

// Live-typing sanitizer: collapse whitespace runs, drop a leading space,
// cap at max. Trailing single space is kept so the next word can be typed.
export function sanitizeTextInput(raw, max = TEXT_MAX) {
  let s = String(raw ?? "").replace(/\s+/g, " ");
  if (s.startsWith(" ")) s = s.slice(1);
  if (s.length > max) s = s.slice(0, max);
  return s;
}

// Strict checks used on submit. Returns { ok, value } (value trimmed).
// Vendor rule (Add Expense): 3-30 characters, single spaces, leading and
// trailing spaces are ignored, whitespace-only input is refused.
export function validateVendor(raw) {
  return validateTextLine(raw, { label: "Vendor", min: VENDOR_MIN, max: VENDOR_MAX });
}

export function validateNote(raw) {
  const value = sanitizeTextInput(raw).trim();
  if (!value) return { ok: true, value: "" };
  if (value.length > TEXT_MAX) {
    return { ok: false, value, error: "Note must be at most 40 characters." };
  }
  if (countLetters(value) < TEXT_MIN_LETTERS) {
    return { ok: false, value, error: "Note needs at least 2 letters when provided (max 40 characters)." };
  }
  return { ok: true, value };
}

export function validateItemName(raw) {
  const value = sanitizeTextInput(raw, ITEM_NAME_MAX).trim();
  if (!value) return { ok: false, value, error: "Item name is required (min 2 letters, max 30 characters)." };
  if (value.length > ITEM_NAME_MAX) {
    return { ok: false, value, error: "Item name must be at most 30 characters." };
  }
  if (countLetters(value) < TEXT_MIN_LETTERS) {
    return { ok: false, value, error: "Item name needs at least 2 letters (max 30 characters)." };
  }
  return { ok: true, value };
}

// Mirrors api/src/services/validation.js (keep both in sync).
const NAME_PATTERN = /^[\p{L}\p{N}\p{M}][\p{L}\p{N}\p{M}\p{Pc}\p{Pd}'.\-&#/()+:* ]*$/u;
// eslint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\u0000-\u001F\u007F]/g;

export function validatePersonName(raw, label = "Name", max = 100) {
  const value = String(raw ?? "")
    .replace(CONTROL_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
  if (!value) return { ok: false, value, error: `${label} is required.` };
  if (value.length < 2) return { ok: false, value, error: `${label} needs at least 2 characters.` };
  if (countLetters(value) < 2) return { ok: false, value, error: `${label} needs at least 2 letters.` };
  if (!NAME_PATTERN.test(value)) {
    return { ok: false, value, error: `${label} may contain only letters, numbers, spaces, -, ', ., #, / and &. ` };
  }
  return { ok: true, value };
}

export function validateReason(raw, label = "Reason", max = 500) {
  const value = String(raw ?? "").replace(CONTROL_PATTERN, "").trim();
  if (!value) return { ok: false, value, error: `${label} is required.` };
  if (value.length < 3) return { ok: false, value, error: `${label} needs at least 3 characters.` };
  if (value.length > max) return { ok: false, value, error: `${label} must be at most ${max} characters.` };
  return { ok: true, value };
}

// Usernames for staff/admin accounts are validated by
// validateAccountUsername() below - that is the only username rule the
// product has, so there is no second, looser one to drift out of sync.

// Account holders (staff/admin): full name + username.
//
// The owner's exact rules. These are deliberately STRICTER than the general
// name validator, which stays: it is used for vendors, items, products and
// other free-text names. Mirrors api/src/services/validation.js (keep both
// in sync).
export const FULL_NAME_MIN = 2;
export const FULL_NAME_MAX = 30;
// A run of 3 or more of the SAME letter back-to-back is not a real name.
// "Aaron" (two a's) and "Yyan" are fine; "AAa" and "aaaa" are not.
const ACCOUNT_SAME_LETTER_RUN = /(\p{L})\1\1/iu;

// Unicode letters, spaces, hyphens and apostrophes ONLY - no digits, no other
// punctuation, so HTML/markup cannot be built from this charset.
const ACCOUNT_NAME_ALLOWED = /^[\p{L}\p{M} '-]+$/u;

// Character-by-character filter for live typing: letters/marks/spaces/hyphen/
// apostrophe only; digits and specials never land in the field; a run of 3+
// IDENTICAL (case-insensitive) letters in a row is refused at the keystroke
// that would create it, so "AAa" and "AAaaAAA" can never be typed. Spaces
// collapse to one; each word's first letter auto-capitalises; cap at MAX.
export function sanitizeFullNameTyping(raw) {
  const source = String(raw ?? "");
  let out = "";
  for (const ch of source) {
    if (!/[\p{L}\p{M}' -]/u.test(ch)) continue; // digits/specials never accepted
    const isLetter = /[\p{L}\p{M}]/u.test(ch);
    if (isLetter) {
      const prev2 = out[out.length - 2] ?? "";
      const prev1 = out[out.length - 1] ?? "";
      const lc = ch.toLowerCase();
      // Refuse the third (and later) consecutive identical letter.
      if (
        prev1 && prev2 &&
        prev1.toLowerCase() === lc && prev2.toLowerCase() === lc
      ) {
        continue;
      }
    }
    out += ch;
  }
  // Collapse runs of spaces into one space (text-line rule).
  out = out.replace(/\s+/g, " ");
  // Auto-capitalise each word's first letter (keep the rest as typed).
  out = out.replace(/(^|[\s'-])([\p{L}\p{M}])/gu, (_, sep, ch) => sep + ch.toUpperCase());
  if (out.length > FULL_NAME_MAX) out = out.slice(0, FULL_NAME_MAX);
  return out;
}

/** Full name for a staff/admin account. Returns { ok, value, error }. */
export function validateFullName(raw) {
  const value = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!value) return { ok: false, value, error: "Full name is required." };
  if (value.length < FULL_NAME_MIN) {
    return { ok: false, value, error: "Full name must be at least 2 characters." };
  }
  if (value.length > FULL_NAME_MAX) {
    return { ok: false, value, error: "Full name must not exceed 30 characters." };
  }
  // Numbers or anything outside letters/spaces/hyphens/apostrophes are out.
  if (!ACCOUNT_NAME_ALLOWED.test(value)) {
    return { ok: false, value, error: "Full name cannot contain numbers or special characters." };
  }
  if ((value.match(/\p{L}/gu) ?? []).length < 2) {
    return { ok: false, value, error: "Please enter a valid full name." };
  }
  // No run of 3+ identical letters anywhere in the name.
  if (ACCOUNT_SAME_LETTER_RUN.test(value)) {
    return { ok: false, value, error: "Please enter a valid full name." };
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Username rules for staff/admin accounts, from the owner's spec:
//
//   min 4, max 20 characters
//   must start with an English letter (A-Z, a-z)
//   only letters, digits (0-9), underscores (_) and periods (.)
//   spaces and every other special character are strictly prohibited
//   no consecutive underscores or periods ("..", "__", "._", "_.")
//   the username must end with a letter or a digit
//   validation is case-insensitive (Admin123 and admin123 are the same name)
//   reserved system names and offensive terms are refused
//   leading and trailing spaces are trimmed automatically
// ---------------------------------------------------------------------------
export const USERNAME_MIN = 4;
export const USERNAME_MAX = 20;
const USERNAME_LETTERS = /[a-z]/u;
const USERNAME_ALLOWED = /^[a-z0-9_.]+$/;
// Two underscores/periods in a row - the same one or mixed - are refused.
const USERNAME_CONSECUTIVE = /[._]{2}/;
// Same-word look-alike duplicates in different cases are stored lowercased.

const RESERVED_USERNAMES = new Set([
  // System and role identifiers that must never be a person's login.
  "admin", "administrator", "superadmin", "root", "system", "owner", "support",
  "help", "security", "staff", "service", "manager", "dealer", "cashier",
  "pos", "cartiq", "api", "auth", "login", "password", "reset", "account",
  // The usual null-ish / generic ones.
  "null", "undefined", "anonymous", "nobody", "noone", "unknown", "user", "test",
  "none", "guest", "demo", "default", "everyone", "anyone", "postmaster",
  "abuse", "noreply", "no-reply", "webmaster", "www", "mail", "ftp", "info",
  // Developer-adjacent handles.
  "dev", "developer", "debug", "localhost", "backup", "rootuser", "sa", "sysadmin",
]);

// Offensive terms are matched as substrings ("joever fuck" would not sneak
// through), while reserved words must match the whole username exactly.
const OFFENSIVE_USERNAMES = [
  "fuck", "fucking", "fucker", "shit", "bitch", "asshole", "cunt", "bastard",
  "whore", "slut", "nigger", "faggot", "retard", "puta", "punyeta", "punyetr",
  "putangina", "gago", "bobo", "tanga", "ulol", "pakyu",
];

/** Username for a staff/admin account. Lowercased before validating. */
export function validateAccountUsername(raw) {
  // Leading/trailing spaces are trimmed first; case is normalised to
  // lowercase so Admin123 and admin123 are the same account.
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return { ok: false, value, error: "Username is required." };
  if (/\s/.test(value) || /[^a-z0-9_.]/.test(value)) {
    return { ok: false, value, error: "Username cannot contain spaces or special characters." };
  }
  if (value.length < USERNAME_MIN || value.length > USERNAME_MAX) {
    return { ok: false, value, error: "Username must be between 4 and 20 characters." };
  }
  if (!USERNAME_LETTERS.test(value[0])) {
    return { ok: false, value, error: "Username must start with a letter." };
  }
  if (USERNAME_CONSECUTIVE.test(value)) {
    return { ok: false, value, error: "Username cannot contain consecutive underscores or periods." };
  }
  if (!/[a-z0-9]$/.test(value)) {
    return { ok: false, value, error: "Username must end with a letter or number." };
  }
  if (RESERVED_USERNAMES.has(value)) {
    return { ok: false, value, error: "This username is reserved for the system." };
  }
  if (OFFENSIVE_USERNAMES.some((term) => value.includes(term))) {
    return { ok: false, value, error: "This username contains inappropriate language." };
  }
  if (!USERNAME_ALLOWED.test(value)) {
    return { ok: false, value, error: "Please enter a valid username." };
  }
  return { ok: true, value };
}

// Live typing helper for the Username fields: strip anything that is not a
// letter/digit/underscore/period, keep the text lowercase and cap at
// USERNAME_MAX. Spaces never make it into the field. A run of 3+ identical
// characters in a row (letter or digit, case-insensitive) is refused at the
// keystroke that would create it.
export function sanitizeUsernameTyping(raw) {
  const source = String(raw ?? "").trim().toLowerCase();
  let out = "";
  for (const ch of source) {
    if (!/[a-z0-9_.]/.test(ch)) continue;
    if (out.length >= 2) {
      const prev2 = out[out.length - 2];
      const prev1 = out[out.length - 1];
      if (prev1 === ch && prev2 === ch) continue; // third identical char refused
    }
    out += ch;
  }
  if (out.length > USERNAME_MAX) out = out.slice(0, USERNAME_MAX);
  return out;
}

// A recovery inbox has to survive a real mail server, so the shape is
// checked here (the server still verifies the domain with an MX lookup).
// Cart name and address rules (Add Cart). The backend enforces the same
// rules - keep these in sync with api/src/services/cart_validation.js.
export const CART_NAME_MIN = 2;
export const CART_NAME_MAX = 50;
export const CART_ADDRESS_MIN = 5;
export const CART_ADDRESS_MAX = 150;

// Unicode letters + digits, plus the allowed punctuation per field.
const NAME_ALLOWED = /^[\p{L}\p{N}\p{M} '&-]+$/u;
const ADDRESS_ALLOWED = /^[\p{L}\p{N}\p{M} ,./'#-]+$/u;
const HAS_LETTER = /\p{L}/u;
const HAS_ALPHANUMERIC = /[\p{L}\p{N}]/u;

/** Validate a cart name. Returns { ok, value, error } - value trimmed. */
export function validateCartName(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return { ok: false, value, error: "Cart Name is required." };
  if (value.length < CART_NAME_MIN) {
    return { ok: false, value, error: "Cart Name must be at least 2 characters." };
  }
  if (value.length > CART_NAME_MAX) {
    return { ok: false, value, error: "Cart Name must not exceed 50 characters." };
  }
  if (!NAME_ALLOWED.test(value)) {
    return { ok: false, value, error: "Please enter a valid Cart Name." };
  }
  if (!HAS_LETTER.test(value)) {
    return { ok: false, value, error: "Please enter a valid Cart Name." };
  }
  return { ok: true, value };
}

/** Validate a cart address. Empty input is a valid (absent) address. */
export function validateCartAddress(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return { ok: true, value: null };
  if (value.length < CART_ADDRESS_MIN) {
    return { ok: false, value, error: "Address must be at least 5 characters." };
  }
  if (value.length > CART_ADDRESS_MAX) {
    return { ok: false, value, error: "Address must not exceed 150 characters." };
  }
  if (!ADDRESS_ALLOWED.test(value)) {
    return { ok: false, value, error: "Please enter a valid address." };
  }
  if (!HAS_ALPHANUMERIC.test(value)) {
    return { ok: false, value, error: "Please enter a valid address." };
  }
  return { ok: true, value };
}

export const EMAIL_MAX = 120;
// Local part and domain: one @, no spaces, no leading/trailing dots, no
// consecutive dots anywhere, TLD at least 2 letters, ASCII only for our
// recovery mail path (MX checks verify existence elsewhere).
const LOCAL_ALLOWED = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/;
const DOMAIN_ALLOWED = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * Recovery email rules (an owner-only field in the account modals).
 * Optional when empty; when present: valid shape, 2+ letter TLD, no
// consecutive dots, trimmed, lowercase. Returns { ok, value, error }.
 */
export function validateEmail(raw, _label = "Recovery email") {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return { ok: true, value: "" }; // empty clears the field
  // Uppercase anywhere in the address is refused outright - the store and
  // the comparison below are case-insensitive, and silently rewriting the
  // user's input would hide a typo.
  if (trimmed !== trimmed.toLowerCase()) {
    return { ok: false, value: trimmed.toLowerCase(), error: "Please enter a valid email address." };
  }
  const value = trimmed.toLowerCase();
  if (value.length > EMAIL_MAX) {
    return { ok: false, value, error: "Please enter a valid email address." };
  }
  // Spaces anywhere in the address, or multiple @ signs, are refused.
  if (/\s/.test(value)) {
    return { ok: false, value, error: "Please enter a valid email address." };
  }
  const at = value.indexOf("@");
  if (at === -1 || at !== value.lastIndexOf("@")) {
    return { ok: false, value, error: "Please enter a valid email address." };
  }
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  // Local part: sane chars, not empty, not starting/ending with a dot,
  // no consecutive dots.
  if (!LOCAL_ALLOWED.test(local) || local.startsWith(".") || local.endsWith(".") || local.includes("..")) {
    return { ok: false, value, error: "Please enter a valid email address." };
  }
  // Domain: labels of letters/digits/hyphens, no consecutive dots, at least
  // one dot, TLD of 2+ letters.
  if (!DOMAIN_ALLOWED.test(domain) || domain.includes("..")) {
    return { ok: false, value, error: "Please enter a valid email address." };
  }
  const labels = domain.split(".");
  if (labels.length < 2 || !/^[a-z]{2,}$/.test(labels[labels.length - 1])) {
    return { ok: false, value, error: "Please enter a valid email address." };
  }
  return { ok: true, value };
}

// An RFID tag UID: 4-10 bytes of hex, with or without separators. The server
// stores the normalised form, so the client only has to reject nonsense.
const RFID_PATTERN = /^[0-9a-f]{8,20}$/i;
export const RFID_MAX = 24;

export function validateRfidUid(raw, label = "RFID UID") {
  const value = String(raw ?? "").trim().replace(/[:\s-]/g, "").toUpperCase();
  if (!value) return { ok: true, value: "" }; // empty clears the field
  if (value.length > RFID_MAX) {
    return { ok: false, value, error: `${label} must be at most ${RFID_MAX} characters.` };
  }
  if (!RFID_PATTERN.test(value)) {
    return { ok: false, value, error: `${label} must be 4-10 bytes of hex, e.g. 04A2B3C4.` };
  }
  return { ok: true, value };
}

// An IoT node id: 3-40 chars, letters/digits/underscore/hyphen.
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{3,40}$/;
export const DEVICE_ID_MAX = 40;

export function validateDeviceId(raw, label = "Device ID") {
  const value = String(raw ?? "").trim();
  if (!value) return { ok: false, value, error: `${label} is required.` };
  if (value.length > DEVICE_ID_MAX) {
    return { ok: false, value, error: `${label} must be at most ${DEVICE_ID_MAX} characters.` };
  }
  if (!DEVICE_ID_PATTERN.test(value)) {
    return { ok: false, value, error: `${label} must be 3-40 characters: letters, digits, underscore or hyphen.` };
  }
  return { ok: true, value };
}
