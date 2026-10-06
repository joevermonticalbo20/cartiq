// Registry of in-flight RFID registration claims.
//
// The POS app knows WHO is registering a tag; the ESP32 reader only ever sees
// the tag UID. A claim bridges the two: the app opens one scoped to its cart,
// the reader's next tap resolves it, and the app polls for the result.
//
// In-memory on purpose. A claim lives 90 seconds and only matters while one
// person is standing at the cart holding a card, so surviving an API restart
// buys nothing - and keeping it out of Firestore costs zero reads against a
// quota that is already the project's binding constraint.
//
// Mirrors the ticket store in routes/events.js: prune on access, evict oldest
// first, never clear() wholesale.

import { randomBytes } from "node:crypto";

import { evictOverflow } from "../routes/events.js";
import {
  CLAIM_BOUND,
  CLAIM_CONFLICT,
  CLAIM_EXPIRED,
  CLAIM_PENDING,
  RFID_CLAIM_MAX,
  RFID_CLAIM_TTL_MS,
  isClaimActive,
} from "./rfid.js";

const _claims = new Map(); // claimId -> claim

function pruneClaims(now = Date.now()) {
  for (const [id, rec] of _claims) {
    if (rec.exp <= now) _claims.delete(id);
  }
  evictOverflow(_claims, RFID_CLAIM_MAX);
}

/**
 * Open a claim for [userId] on [locationId].
 *
 * Only one claim per cart can be live at a time, so opening a claim evicts any
 * other active claim on that cart - last prompt wins. Without this, two people
 * prompting on the same cart (an owner testing the flow while staff use it)
 * would leave two claims, and findActiveClaimForLocation would resolve the tap
 * against whichever was inserted first. That silently registers the wrong
 * person's card, which is exactly the outcome this handshake must never have.
 */
export function openClaim({ userId, locationId, locationCode, event }) {
  pruneClaims();
  for (const [id, rec] of _claims) {
    if (isClaimActive(rec) && (rec.userId === userId || rec.locationId === locationId)) {
      _claims.delete(id);
    }
  }
  const claimId = randomBytes(12).toString("hex");
  const exp = Date.now() + RFID_CLAIM_TTL_MS;
  _claims.set(claimId, {
    claimId,
    userId,
    locationId,
    locationCode,
    // What the person pressed in the app: "IN" to clock on, "OUT" to clock
    // off, null when they were only enrolling a card. The firmware otherwise
    // toggles on every tap, which is wrong here - the person already said which
    // one they meant.
    event: event ?? null,
    resolvedEvent: null,
    status: CLAIM_PENDING,
    rfidUid: null,
    createdAt: Date.now(),
    exp,
  });
  return _claims.get(claimId);
}

/** Fetch a claim. Returns null when unknown or already pruned. */
export function getClaim(claimId) {
  pruneClaims();
  return _claims.get(claimId) ?? null;
}

/**
 * Resolve a claim to a terminal state. No-op once it is not pending.
 * [holderName] is set on a conflict so the app can say whose card it was
 * instead of showing a bare "already registered".
 * [event] is the shift that was actually written, which is what the app toasts.
 */
export function resolveClaim(claimId, status, rfidUid, holderName, event) {
  pruneClaims();
  const rec = _claims.get(claimId);
  if (!rec || rec.status !== CLAIM_PENDING) return null;
  rec.status = status;
  rec.rfidUid = rfidUid ?? null;
  rec.holderName = holderName ?? null;
  rec.resolvedEvent = event ?? null;
  return rec;
}

/**
 * Find the live claim a tap on [locationId] should resolve.
 * At most one claim per location can be active - two staff members prompting
 * on the same cart cannot both be told they registered the same card.
 */
export function findActiveClaimForLocation(locationId) {
  pruneClaims();
  for (const rec of _claims.values()) {
    if (rec.locationId === locationId && isClaimActive(rec)) return rec;
  }
  return null;
}

/**
 * Report a claim to its owner, translating a passed TTL into the explicit
 * expired state so the app can tell "still waiting" from "too late".
 *
 * [now] is injectable so the expiry transition is testable without sleeping.
 */
export function claimView(claim, now = Date.now()) {
  if (!claim) return null;
  const expired = claim.exp <= now;
  const status = expired && claim.status === CLAIM_PENDING ? CLAIM_EXPIRED : claim.status;
  return {
    claimId: claim.claimId,
    status,
    rfidUid: claim.rfidUid,
    holderName: claim.holderName ?? null,
    locationCode: claim.locationCode,
    // What was asked for, and what the shift log actually recorded. They can
    // differ if the tap was rejected, so the app toasts resolvedEvent, not this.
    event: claim.event ?? null,
    resolvedEvent: claim.resolvedEvent ?? null,
    expiresAt: new Date(claim.exp).toISOString(),
  };
}

/** Test seam: drop all claims. */
export function resetClaims() {
  _claims.clear();
}

export { CLAIM_BOUND, CLAIM_CONFLICT, CLAIM_EXPIRED, CLAIM_PENDING };