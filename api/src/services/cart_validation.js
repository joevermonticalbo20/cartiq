// Cart name and address validation rules.
//
// The owner's spec (Add Cart):
//
//   Cart name - required, 2-50 characters. Letters, numbers, spaces, hyphens,
//   apostrophes and ampersands only. Must contain at least one letter, so
//   numbers-only and punctuation-only names are refused. Trimmed on input.
//
//   Address - optional. When present: 5-150 characters. Letters, numbers,
//   spaces, commas, periods, hyphens, apostrophes, hash and slashes only.
//   Must contain at least one letter or digit. Not remotely restrictive on the
//   format: building numbers, unit numbers, barangays, cities and provinces
//   are all legal.
//
// Both reject HTML entirely: the allowed character sets cannot build tags, so
// there is no way to inject markup - but we still strip anything else too, so
// a pasted "<script>" is refused, not just discouraged.
//
// The same rules are mirrored in web/src/utils/text.js - keep both in sync.

export const CART_NAME_MIN = 2;
export const CART_NAME_MAX = 50;
export const CART_ADDRESS_MIN = 5;
export const CART_ADDRESS_MAX = 150;

// Unicode letters + digits, plus the allowed punctuation per field.
const NAME_ALLOWED = /^[\p{L}\p{N}\p{M} '&-]+$/u;
const ADDRESS_ALLOWED = /^[\p{L}\p{N}\p{M} ,./'#-]+$/u;
const HAS_LETTER = /\p{L}/u;
const HAS_ALPHANUMERIC = /[\p{L}\p{N}]/u;

/**
 * Validate a cart name. Returns { ok, value, error } - value trimmed.
 */
export function validateCartName(raw) {
  const value = String(raw ?? "").trim();
  if (!value) {
    return { ok: false, value, error: "Cart Name is required." };
  }
  if (value.length < CART_NAME_MIN) {
    return { ok: false, value, error: "Cart Name must be at least 2 characters." };
  }
  if (value.length > CART_NAME_MAX) {
    return { ok: false, value, error: "Cart Name must not exceed 50 characters." };
  }
  if (!NAME_ALLOWED.test(value)) {
    return { ok: false, value, error: "Please enter a valid Cart Name." };
  }
  // At least one letter: digits-only and punctuation-only names are refused.
  if (!HAS_LETTER.test(value)) {
    return { ok: false, value, error: "Please enter a valid Cart Name." };
  }
  return { ok: true, value };
}

/**
 * Validate a cart address. Returns { ok, value, error } - value trimmed.
 * Empty input is a valid (absent) address.
 */
export function validateCartAddress(raw) {
  const value = String(raw ?? "").trim();
  if (!value) {
    return { ok: true, value: null };
  }
  if (value.length < CART_ADDRESS_MIN) {
    return { ok: false, value, error: "Address must be at least 5 characters." };
  }
  if (value.length > CART_ADDRESS_MAX) {
    return { ok: false, value, error: "Address must not exceed 150 characters." };
  }
  if (!ADDRESS_ALLOWED.test(value)) {
    return { ok: false, value, error: "Please enter a valid address." };
  }
  // At least one letter or digit: punctuation-only addresses are refused.
  if (!HAS_ALPHANUMERIC.test(value)) {
    return { ok: false, value, error: "Please enter a valid address." };
  }
  return { ok: true, value };
}
