// Shared text-input rules for vendor/note fields (single source so web and
// mobile validate identically):
//  - length 2-40 chars (note is optional: empty is allowed, non-empty needs 2+)
//  - at least 2 LETTER characters (Unicode-aware; digits/symbols don't count)
//  - single spaces only: runs collapse to one, ends trimmed
export const TEXT_MIN_LETTERS = 2;
export const TEXT_MAX = 40;

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
