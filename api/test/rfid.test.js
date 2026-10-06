// RFID registration policy: UID normalization and the claim lifecycle.
import test from "node:test";
import assert from "node:assert/strict";

import {
  cleanRfidUid,
  isClaimActive,
  normalizeRfidUid,
  validRfidUid,
  CLAIM_BOUND,
  CLAIM_PENDING,
  RFID_CLAIM_TTL_MS,
} from "../src/services/rfid.js";
import {
  claimView,
  findActiveClaimForLocation,
  getClaim,
  openClaim,
  resetClaims,
  resolveClaim,
} from "../src/services/rfid_claims.js";

test("normalizeRfidUid uppercases and drops separators a human may paste", () => {
  assert.equal(normalizeRfidUid("04a2b3c4"), "04A2B3C4");
  assert.equal(normalizeRfidUid("  04 a2 b3 c4 "), "04A2B3C4");
  assert.equal(normalizeRfidUid("04-A2-B3-C4"), "04A2B3C4");
  assert.equal(normalizeRfidUid("04A2B3C4:"), "04A2B3C4");
  assert.equal(normalizeRfidUid(null), "");
  assert.equal(normalizeRfidUid(undefined), "");
  // Already-canonical input must be a fixed point, not re-written.
  assert.equal(normalizeRfidUid("04A2B3C4"), "04A2B3C4");
});

test("validRfidUid accepts 4-10 byte tags and rejects junk", () => {
  // 4-byte MIFARE Classic, 7/8-byte MIFARE Ultralight, 10-byte NTAG.
  assert.ok(validRfidUid("04A2B3C4"));
  assert.ok(validRfidUid("A1B2C3D4E5F6A7B8C9DA"));
  assert.ok(validRfidUid("04a2b3c4"), "case must not matter for validity");
  assert.ok(validRfidUid("0123456789ABCDEF0123"), "10 bytes (20 hex chars) is the cap");
  assert.ok(!validRfidUid("ZZZZ"), "non-hex rejected");
  assert.ok(!validRfidUid(""), "empty rejected");
  assert.ok(!validRfidUid("ABC"), "odd length is not whole bytes");
  assert.ok(!validRfidUid("0123456789ABCDEF012345"), "11 bytes is past the cap");
});

test("cleanRfidUid normalizes and validates in one step", () => {
  assert.equal(cleanRfidUid("04 a2 b3 c4"), "04A2B3C4");
  assert.equal(cleanRfidUid("ZZZZ"), null);
  assert.equal(cleanRfidUid(""), null);
});

test("claim lifecycle: open -> pending -> bound", () => {
  resetClaims();
  const claim = openClaim({ userId: 7, locationId: 1, locationCode: "CART-01" });
  assert.equal(claim.status, CLAIM_PENDING);
  assert.ok(isClaimActive(claim));
  assert.equal(claimView(claim).status, CLAIM_PENDING);

  resolveClaim(claim.claimId, CLAIM_BOUND, "04A2B3C4");
  const after = getClaim(claim.claimId);
  assert.equal(after.status, CLAIM_BOUND);
  assert.equal(after.rfidUid, "04A2B3C4");
  assert.ok(!isClaimActive(after), "a resolved claim is no longer active");
});

test("a resolved claim cannot be resolved twice", () => {
  resetClaims();
  const claim = openClaim({ userId: 7, locationId: 1, locationCode: "CART-01" });
  assert.ok(resolveClaim(claim.claimId, CLAIM_BOUND, "04A2B3C4"));
  // A late second tap must not overwrite the first result.
  assert.equal(resolveClaim(claim.claimId, CLAIM_BOUND, "DEADBEEF"), null);
  assert.equal(getClaim(claim.claimId).rfidUid, "04A2B3C4");
});

test("only one claim per cart is live: a newer prompt wins", () => {
  resetClaims();
  const first = openClaim({ userId: 1, locationId: 1, locationCode: "CART-01" });
  const second = openClaim({ userId: 2, locationId: 1, locationCode: "CART-01" });

  // The tap must resolve against the person who is actually looking at the
  // prompt, not whoever opened first.
  assert.equal(findActiveClaimForLocation(1).claimId, second.claimId);
  assert.equal(getClaim(first.claimId), null, "superseded claim is gone");
  assert.equal(findActiveClaimForLocation(2), null, "a claim only covers its own cart");
});

test("re-opening for the same user supersedes their own older claim", () => {
  resetClaims();
  const first = openClaim({ userId: 1, locationId: 1, locationCode: "CART-01" });
  const again = openClaim({ userId: 1, locationId: 1, locationCode: "CART-01" });
  assert.equal(getClaim(first.claimId), null);
  assert.equal(findActiveClaimForLocation(1).claimId, again.claimId);
});

test("claims on different carts do not evict each other", () => {
  resetClaims();
  const a = openClaim({ userId: 1, locationId: 1, locationCode: "CART-01" });
  const b = openClaim({ userId: 2, locationId: 2, locationCode: "CART-02" });
  assert.equal(findActiveClaimForLocation(1).claimId, a.claimId);
  assert.equal(findActiveClaimForLocation(2).claimId, b.claimId);
});

test("an expired claim reports expired instead of pending forever", () => {
  resetClaims();
  const claim = openClaim({ userId: 1, locationId: 1, locationCode: "CART-01" });
  // Pretend the clock moved past the TTL. prune-on-access reads the real clock,
  // so only the pure helpers are asserted here - isClaimActive is the gate that
  // actually stops an expired claim from swallowing a tap.
  const later = Date.now() + RFID_CLAIM_TTL_MS + 1000;
  assert.equal(isClaimActive(claim, later), false);
  assert.equal(claimView(claim, later).status, "expired");
  assert.equal(claimView(claim).status, "pending", "still pending before the TTL");
});

test("an expired claim that had already bound keeps its bound result", () => {
  resetClaims();
  const claim = openClaim({ userId: 1, locationId: 1, locationCode: "CART-01" });
  resolveClaim(claim.claimId, CLAIM_BOUND, "04A2B3C4");
  const later = Date.now() + RFID_CLAIM_TTL_MS + 1000;
  // Expiry must not rewrite a success into a failure on a late poll.
  assert.equal(claimView(claim, later).status, CLAIM_BOUND);
  assert.equal(claimView(claim, later).rfidUid, "04A2B3C4");
});

test("unknown claim ids are simply absent", () => {
  resetClaims();
  assert.equal(getClaim("nope"), null);
  assert.equal(claimView(null), null);
  assert.equal(resolveClaim("nope", CLAIM_BOUND, "04A2B3C4"), null);
});