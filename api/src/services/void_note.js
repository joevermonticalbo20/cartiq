// Void-note rules for the OWNER voiding an order (direct void and approving a
// staff void request). Pure functions so the policy is unit-testable without
// a database. Mirrored in supabase/functions/api/index.ts (production Edge
// path) — keep both in sync when changing policy.
//
// Rules (enforced at keystroke in the web client, and again here on the
// server — the client can be bypassed):
//   required, min 2, max 100 characters
//   Unicode letters/digits and the characters ` , . - _ ` plus spaces
//   single spaces only (no runs, no leading/trailing space after trim)
//   no run of three identical characters in a row (case-insensitive)

export const VOID_NOTE_MIN = 2;
export const VOID_NOTE_MAX = 100;

const VOID_NOTE_ALLOWED = /^[\p{L}\p{N} ,.\-_]+$/u;
const VOID_NOTE_TRIPLE = /(.)(\1)(\1)/iu;

/** Trim and collapse every whitespace run to a single space. */
export function normalizeVoidNote(raw) {
  return String(raw ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Validate a void note. Returns { ok, value?, error? } where `value` is the
 * normalized note to persist.
 */
export function validateVoidNote(raw) {
  const value = normalizeVoidNote(raw);
  if (!value) {
    return { ok: false, error: "Add a note explaining why the order is voided." };
  }
  if (value.length < VOID_NOTE_MIN) {
    return { ok: false, error: "A single letter is not valid - the minimum is 2." };
  }
  if (value.length > VOID_NOTE_MAX) {
    return { ok: false, error: `Note must not exceed ${VOID_NOTE_MAX} characters.` };
  }
  if (!VOID_NOTE_ALLOWED.test(value)) {
    return { ok: false, error: "Note may only contain letters, digits, spaces and the characters , . - _" };
  }
  if (VOID_NOTE_TRIPLE.test(value)) {
    return { ok: false, error: "Note cannot contain three identical characters in a row." };
  }
  return { ok: true, value };
}
