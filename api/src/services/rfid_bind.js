// Bind a tapped RFID tag to the user who opened a registration claim.
//
// Called from the tap path (routes/iot.js POST /shifts) - that is the only
// place a tag is physically presented, so it is the only place a registration
// can be completed. Keeping the logic here rather than inline means the claim
// lifecycle lives in one file and the tap route stays a thin handler.

import { db as prisma } from "../firestore.js";
import { emit } from "../routes/events.js";
import {
  CLAIM_ALREADY_REGISTERED,
  CLAIM_BOUND,
  CLAIM_CONFLICT,
  CLAIM_UNREGISTERED,
  CLAIM_WRONG_CART,
  findActiveClaimForLocation,
  resolveClaim,
} from "./rfid_claims.js";
import {
  cardBelongsToAnotherCart,
  cardLocationCode,
  normalizeRfidUid,
} from "./rfid.js";

/**
 * Try to satisfy the live claim on [locationId] using the tapped tag [rawUid].
 *
 * Returns null when nobody is registering on that cart, which is the normal
 * case - the caller then falls through to its ordinary tap handling. Otherwise
 * returns one of:
 *   { outcome: "bound",        rfidUid, userId, name, username, locationCode }
 *   { outcome: "conflict",     rfidUid, holderName }   tag belongs to someone else
 *   { outcome: "unregistered", rfidUid }               tag belongs to nobody
 *   { outcome: "wrong_cart",   rfidUid, cardLocationCode } tag belongs to another cart
 *   { outcome: "already_registered", rfidUid }          tag is already on this account
 *   { outcome: "error",        message }               claim target vanished
 *
 * The card always ends up on the claim's TARGET account (targetUserId), which
 * is the person who opened the claim unless an OWNER opened it for a staff
 * member.
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

  // The account the card is for. An OWNER may open the claim for a staff
  // member; everyone else enrols their own card.
  const targetUserId = claim.targetUserId ?? claim.userId;

  const holder = await prisma.user.findFirst({
    where: { rfidUid },
    include: { location: true },
  });

  if (holder && holder.id !== targetUserId) {
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

  // A card belongs to the cart where it was enrolled: each cart has its own
  // team, so a card enrolled at CART-01 does not work at CART-02. Checked
  // after ownership (a card that is not yours is the bigger problem), and
  // before anything else, so the card is neither moved nor used there.
  if (holder && cardBelongsToAnotherCart(holder, claim.locationCode)) {
    const enrolledAt = cardLocationCode(holder);
    resolveClaim(
      claim.claimId,
      CLAIM_WRONG_CART,
      rfidUid,
      holder.name,
      null,
      enrolledAt,
    );
    emit("rfid:wrong_cart", {
      rfidUid,
      locationCode: claim.locationCode,
      cardLocationCode: enrolledAt,
      holderName: holder.name,
      claimedBy: claim.userId,
      event: claim.event ?? null,
    });
    return {
      outcome: "wrong_cart",
      rfidUid,
      cardLocationCode: enrolledAt,
      holderName: holder.name,
    };
  }

  // Clocking in or out must NEVER enrol a card. The person pressed Time in /
  // Time out and tapped their staff card; if that card is not on an account
  // the honest answer is "this card is not registered", not "here, let me
  // attach it to you". Only the explicit "register card" flow enrols a tag -
  // that way a tag can never be taken over by whoever happens to clock in
  // with it.
  if (!holder && claim.event) {
    resolveClaim(claim.claimId, CLAIM_UNREGISTERED, rfidUid);
    emit("rfid:unregistered", {
      rfidUid,
      locationCode: claim.locationCode,
      claimedBy: claim.userId,
      event: claim.event,
    });
    return { outcome: "unregistered", rfidUid };
  }

  let target = holder;
  if (!target) {
    target = await prisma.user.findUnique({ where: { id: targetUserId } });
    if (!target) {
      resolveClaim(claim.claimId, CLAIM_CONFLICT, rfidUid);
      return { outcome: "error", message: "Account not found" };
    }
  }

  // The card is already on this account. Enrolling it again would change
  // nothing, so say that instead of claiming a card was registered.
  // Clocking is NOT affected: tapping your own card to time in still records
  // the shift, and that never reaches this point.
  if (holder && !claim.event) {
    resolveClaim(claim.claimId, CLAIM_ALREADY_REGISTERED, rfidUid, holder.name);
    emit("rfid:already_registered", {
      rfidUid,
      locationCode: claim.locationCode,
      holderName: holder.name,
      claimedBy: claim.userId,
      targetUserId,
    });
    return { outcome: "already_registered", rfidUid, holderName: holder.name };
  }

  // Re-registering from Settings replaces the old card rather than failing, so
  // a staff member who lost a tag can enrol a new one. Snapshot the old UID
  // before the write: the previous card stops working immediately, so the UI
  // has to be able to say which one was replaced.
  const previousUid = target.rfidUid ? normalizeRfidUid(target.rfidUid) : null;
  const replacedExisting = !holder && Boolean(previousUid) && previousUid !== rfidUid;

  if (!holder) {
    // The card is enrolled at THIS cart, and that is what it remembers: a tap
    // at another cart is refused instead of silently working there.
    await prisma.user.update({
      where: { id: target.id },
      data: { rfidUid, rfidLocationCode: claim.locationCode ?? null },
    });
  }
  resolveClaim(claim.claimId, CLAIM_BOUND, rfidUid, null, claim.event);
  emit("rfid:bound", {
    userId: target.id,
    name: target.name,
    username: target.username,
    rfidUid,
    previousRfidUid: replacedExisting ? previousUid : null,
    locationCode: claim.locationCode,
    // The cart the card belongs to: the one it was enrolled at. A card that
    // was just enrolled belongs to this cart.
    cardLocationCode: holder
      ? cardLocationCode(holder)
      : (claim.locationCode ?? null),
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