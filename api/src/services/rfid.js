// RFID tag UID shared rules. Pure functions so the policy is unit-testable
// without a database.
// The same rules are mirrored in supabase/functions/api/index.ts
// (production Edge path) - keep both in sync when changing policy.

/**
 * Normalize a tag UID to the single stored form.
 *
 * This is not cosmetic. POST /shifts matches a tapped tag against
 * users.rfidUid with exact string equality (see routes/iot.js), and the
 * firmware emits zero-padded UPPERCASE hex (iot/firmware/main.cpp). A uid
 * stored as "04a2b3c4" would never match a tap of "04A2B3C4", so the card
 * would silently degrade into an UNKNOWN_CARD alert instead of a shift.
 * Every write path must run through here so the stored value and the tapped
 * value are always the same string.
 */
export function normalizeRfidUid(value) {
  // Strip separators a human may paste in ("04 A2 B3 C4" -> "04A2B3C4") and
  // a trailing colon that some reader shells print.
  return String(value ?? "")
    .replace(/[:\s-]/g, "")
    .toUpperCase();
}

/**
 * Accepted UID shapes: MIFARE Classic 4/7-byte, Ultralight 7/8-byte and
 * NTAG/other 4-10 byte tags all surface as 8-20 hex chars. Anything outside
 * that is a malformed body, not a real card.
 */
const UID_RE = /^[0-9A-F]{8,20}$/;

export function validRfidUid(value) {
  const v = normalizeRfidUid(value);
  // Must be an even number of hex chars (whole bytes) and 4-10 bytes long.
  return UID_RE.test(v);
}

/** Trim + validate, returning null when the input is not a usable tag UID. */
export function cleanRfidUid(value) {
  const v = normalizeRfidUid(value);
  return validRfidUid(v) ? v : null;
}

/**
 * Key used ONLY to match a tap against a stored card. Case-insensitive and
 * separator-tolerant, so a card stored as "04A2B3C4" matches a tap of
 * "04a2b3c4" or "04 A2 B3 C4".
 *
 * Deliberately separate from [normalizeRfidUid]: the tap's UID is reported
 * verbatim in the UNKNOWN_CARD alert and in the shift record, so what the
 * operator is shown stays exactly what the reader sent. Rewriting it here
 * would both misreport the tap and corrupt what gets stored.
 */
export function lookupUid(value) {
  return String(value ?? "")
    .replace(/[:\s-]/g, "")
    .toUpperCase();
}

// A registration claim is the handshake between the POS app (which knows WHO
// is registering) and the ESP32 reader (which only ever sees the tag UID).
// The app opens a claim scoped to its cart, the reader reports a tap, and the
// tap resolves the claim. Short TTL: this only has to survive a person walking
// over to the cart with a card in hand.
export const RFID_CLAIM_TTL_MS = 90 * 1000;
// Cap concurrent claims so a misbehaving client cannot grow the map without
// bound; oldest is evicted first (see evictOverflow in routes/events.js).
export const RFID_CLAIM_MAX = 200;

/** Claim lifecycle states as reported to the app. */
export const CLAIM_PENDING = "pending";
export const CLAIM_BOUND = "bound";
export const CLAIM_CONFLICT = "conflict";
export const CLAIM_EXPIRED = "expired";

/** True when the claim is still waiting for a tap. */
export function isClaimActive(claim, now = Date.now()) {
  return Boolean(claim) && claim.exp > now && claim.status === CLAIM_PENDING;
}