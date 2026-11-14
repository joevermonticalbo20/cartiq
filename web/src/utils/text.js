// Shared text-input rules for vendor/note/item-name fields (single source
// so web and mobile validate identically):
//  - vendor/note: 2-40 chars; item names: 2-30 chars
//  - at least 2 LETTER characters (Unicode-aware; digits/symbols don't count
//    but are allowed)
//  - single spaces only: runs collapse to one, ends trimmed
export const TEXT_MIN_LETTERS = 2;
export const TEXT_MAX = 40;
export const ITEM_NAME_MAX = 30;

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
export function validateVendor(raw) {
  const value = sanitizeTextInput(raw).trim();
  if (!value) return { ok: false, value, error: "Vendor is required (min 2 letters, max 40 characters)." };
  if (value.length > TEXT_MAX) {
    return { ok: false, value, error: "Vendor must be at most 40 characters." };
  }
  if (countLetters(value) < TEXT_MIN_LETTERS) {
    return { ok: false, value, error: "Vendor needs at least 2 letters (max 40 characters)." };
  }
  return { ok: true, value };
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

const USERNAME_PATTERN = /^[a-z0-9._-]{3,30}$/;
export function validateUsername(raw) {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return { ok: false, value, error: "Username is required." };
  if (!USERNAME_PATTERN.test(value)) {
    return { ok: false, value, error: "Username must be 3-30 chars: a-z, 0-9, dot, underscore or hyphen." };
  }
  if (value.startsWith(".") || value.endsWith(".") || value.includes("..")) {
    return { ok: false, value, error: "Username cannot start or end with a dot, and cannot have consecutive dots." };
  }
  return { ok: true, value };
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
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function validateEmail(raw, label = "Recovery email") {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return { ok: true, value: "" }; // empty clears the field
  if (value.length > EMAIL_MAX) {
    return { ok: false, value, error: `${label} must be at most ${EMAIL_MAX} characters.` };
  }
  if (!EMAIL_PATTERN.test(value)) {
    return { ok: false, value, error: `${label} is not a valid email address.` };
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
