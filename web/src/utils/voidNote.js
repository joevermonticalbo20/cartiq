// Note rules (used by the DECLINE/REJECT decision - approve and confirm are
// note-less):
//   required, min 2, max 100 characters
//   letters/digits and the characters ` , . - _ ` plus single spaces
//   single spaces between words (no runs)
//   no run of three identical characters in a row (case-insensitive for letters)
//   leading/trailing spaces are trimmed

export const VOID_NOTE_MIN = 2;
export const VOID_NOTE_MAX = 100;

// Unicode letters + digits, space, comma, period, hyphen, underscore only —
// no other punctuation, no emoji, no accents beyond Unicode letters.
export const VOID_NOTE_ALLOWED = /^[\p{L}\p{N} ,.\-_]+$/u;

// A run of three identical characters (case-insensitive for letters).
const VOID_NOTE_TRIPLE = /(.)(\1)(\1)/iu;

function tripleRunIn(value) {
  return VOID_NOTE_TRIPLE.test(value);
}

// Character-by-character filter for live typing: letters/digits/space/comma/
// period/hyphen/underscore only, collapses runs of spaces into one, strips
// leading spaces, caps at VOID_NOTE_MAX and refuses the third consecutive
// identical character (case-insensitive).
export function sanitizeVoidNoteTyping(raw) {
  const source = String(raw ?? "");
  let out = "";
  for (const ch of source) {
    if (!/[\p{L}\p{N} ,._-]/u.test(ch)) continue;
    const isSpace = ch === " ";
    if (isSpace) {
      if (out.length === 0 || out[out.length - 1] === " ") continue;
      out += " ";
      continue;
    }
    if (out.length >= 2) {
      const prev2 = out[out.length - 2];
      const prev1 = out[out.length - 1];
      const lc = ch.toLowerCase();
      if (prev1.toLowerCase() === lc && prev2.toLowerCase() === lc) {
        // Third identical char in a row: drop the keystroke entirely.
        continue;
      }
    }
    out += ch;
    if (out.length > VOID_NOTE_MAX) out = out.slice(0, VOID_NOTE_MAX);
  }
  return out;
}

export function validateVoidNote(raw) {
  const value = String(raw ?? "").replace(/\s+/g, " ").trim();
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
  if (tripleRunIn(value)) {
    return { ok: false, error: "Note cannot contain three identical characters in a row." };
  }
  return { ok: true, value };
}
