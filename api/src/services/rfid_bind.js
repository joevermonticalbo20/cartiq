// Bind a tapped RFID tag to the user who opened a registration claim.
//
// Called from the tap path (routes/iot.js POST /shifts) - that is the only
// place a tag is physically presented, so it is the only place a registration
// can be completed. Keeping the logic here rather than inline means the claim
// lifecycle lives in one file and the tap route stays a thin handler.

import { db as prisma } from "../firestore.js";
import { emit } from "../routes/events.js";
import { normalizeRfidUid } from "./rfid.js";
import {
  CLAIM_BOUND,
  CLAIM_CONFLICT,
  findActiveClaimForLocation,
  resolveClaim,
} from "./rfid_claims.js";

/**
 * Try to satisfy the live claim on [locationId] using the tapped tag [rawUid].
 *
 * Returns null when nobody is registering on that cart, which is the normal
 * case - the caller then falls through to its ordinary tap handling. Otherwise
 * returns one of:
 *   { outcome: "bound",    rfidUid, userId, name, username, locationCode }
 *   { outcome: "conflict", rfidUid, holderName }   tag belongs to someone else
 *   { outcome: "error",    message }               claim target vanished
 *
 * Safe to call with a tag that is already registered: re-tapping your own card
 * while the prompt is open resolves the claim instead of erroring, so the app
 * can be retried without the user having to unregister first.
 */
export async function bindClaimedTag({ rawUid, locationId }) {
  const claim = findActiveClaimForLocation(locationId);
  if (!claim) return null;

  const rfidUid = normalizeRfidUid(rawUid);
  if (!rfidUid) return null;

  const holder = await prisma.user.findFirst({
    where: { rfidUid },
    include: { location: true },
  });

  if (holder && holder.id !== claim.userId) {
    // Never silently move another person's card. Say who holds it instead:
    // the person at the cart needs to know they grabbed the wrong card.
    resolveClaim(claim.claimId, CLAIM_CONFLICT, rfidUid, holder.name);
    emit("rfid:conflict", {
      rfidUid,
      locationCode: claim.locationCode,
      holderName: holder.name,
      claimedBy: claim.userId,
    });
    return { outcome: "conflict", rfidUid, holderName: holder.name };
  }

  let target = holder;
  if (!target) {
    target = await prisma.user.findUnique({ where: { id: claim.userId } });
    if (!target) {
      resolveClaim(claim.claimId, CLAIM_CONFLICT, rfidUid);
      return { outcome: "error", message: "Account not found" };
    }
  }

  // Re-registering from Settings replaces the old card rather than failing, so
  // a staff member who lost a tag can enrol a new one. Snapshot the old UID
  // before the write: the previous card stops working immediately, so the UI
  // has to be able to say which one was replaced.
  const previousUid = target.rfidUid ? normalizeRfidUid(target.rfidUid) : null;
  const replacedExisting = !holder && Boolean(previousUid) && previousUid !== rfidUid;

  if (!holder) {
    await prisma.user.update({ where: { id: target.id }, data: { rfidUid } });
  }
  resolveClaim(claim.claimId, CLAIM_BOUND, rfidUid, null, claim.event);
  emit("rfid:bound", {
    userId: target.id,
    name: target.name,
    username: target.username,
    rfidUid,
    previousRfidUid: replacedExisting ? previousUid : null,
    locationCode: claim.locationCode,
    replacedExisting,
  });
  return {
    outcome: "bound",
    rfidUid,
    previousRfidUid: replacedExisting ? previousUid : null,
    replacedExisting,
    userId: target.id,
    name: target.name,
    username: target.username,
    locationCode: claim.locationCode,
    // Handed back so the tap route can override the firmware's toggle and tell
    // the app which shift was actually written.
    claimId: claim.claimId,
    desiredEvent: claim.event ?? null,
  };
}