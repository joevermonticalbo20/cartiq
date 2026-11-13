// Which taps may enrol a card, and which may not.
//
// The rule: enrolling a tag is a deliberate act ("register this card" in
// Settings). Clocking in or out must NEVER enrol one - otherwise whoever
// happens to tap a stray tag while clocking in silently takes it over.
import test from "node:test";
import assert from "node:assert/strict";

import { db as prisma } from "../src/firestore.js";
import {
  CLAIM_BOUND,
  CLAIM_CONFLICT,
  CLAIM_UNREGISTERED,
} from "../src/services/rfid.js";
import { getClaim, openClaim, resetClaims } from "../src/services/rfid_claims.js";
import { bindClaimedTag } from "../src/services/rfid_bind.js";

// A tiny in-memory stand-in for the users table.
const users = [
  { id: 2, name: "Stall Staff 1", username: "staff01", rfidUid: "3A20704F" },
  { id: 4, name: "Stall Staff 3", username: "staff03", rfidUid: "06C4D5E6" },
];

const originalUser = prisma.user;
prisma.user = {
  async findFirst({ where }) {
    return (
      users.find((u) => u.rfidUid && u.rfidUid === where.rfidUid) ?? null
    );
  },
  async findUnique({ where }) {
    return users.find((u) => u.id === where.id) ?? null;
  },
  async update({ where, data }) {
    const user = users.find((u) => u.id === where.id);
    if (user) user.rfidUid = data.rfidUid;
    return user;
  },
};

function reset() {
  resetClaims();
  users[0].rfidUid = "3A20704F";
  users[1].rfidUid = "06C4D5E6";
}

test("clocking in with a card nobody owns does NOT register it", async () => {
  reset();
  const claim = openClaim({
    userId: 2,
    locationId: 1,
    locationCode: "CART-01",
    event: "IN",
  });

  const result = await bindClaimedTag({ rawUid: "DEADBEEF", locationId: 1 });

  assert.equal(result.outcome, "unregistered");
  assert.equal(
    users[0].rfidUid,
    "3A20704F",
    "the account must keep the card it already has",
  );
  assert.equal(
    getClaim(claim.claimId).status,
    CLAIM_UNREGISTERED,
    "the app is told the card is not on any account",
  );
});

test("clocking out with a card nobody owns does NOT register it either", async () => {
  reset();
  const claim = openClaim({
    userId: 2,
    locationId: 1,
    locationCode: "CART-01",
    event: "OUT",
  });

  const result = await bindClaimedTag({ rawUid: "DEADBEEF", locationId: 1 });

  assert.equal(result.outcome, "unregistered");
  assert.equal(users[0].rfidUid, "3A20704F");
  assert.equal(getClaim(claim.claimId).status, CLAIM_UNREGISTERED);
});

test("registering a card that nobody owns still binds it", async () => {
  reset();
  const claim = openClaim({
    userId: 2,
    locationId: 1,
    locationCode: "CART-01",
  });

  const result = await bindClaimedTag({ rawUid: "DEADBEEF", locationId: 1 });

  assert.equal(result.outcome, "bound");
  assert.equal(users[0].rfidUid, "DEADBEEF");
  assert.equal(getClaim(claim.claimId).status, CLAIM_BOUND);
});

test("clocking in with somebody else's card is refused and never moves it", async () => {
  reset();
  const claim = openClaim({
    userId: 2,
    locationId: 1,
    locationCode: "CART-01",
    event: "IN",
  });

  const result = await bindClaimedTag({ rawUid: "06C4D5E6", locationId: 1 });

  assert.equal(result.outcome, "conflict");
  assert.equal(result.holderName, "Stall Staff 3");
  assert.equal(users[1].rfidUid, "06C4D5E6", "the other card stays where it is");
  assert.equal(users[0].rfidUid, "3A20704F");
  assert.equal(getClaim(claim.claimId).status, CLAIM_CONFLICT);
});

test("clocking in with your own card logs the shift and enrols nothing", async () => {
  reset();
  const claim = openClaim({
    userId: 2,
    locationId: 1,
    locationCode: "CART-01",
    event: "IN",
  });

  const result = await bindClaimedTag({ rawUid: "3A20704F", locationId: 1 });

  assert.equal(result.outcome, "bound");
  assert.equal(result.desiredEvent, "IN", "the tap route uses this for the shift");
  assert.equal(users[0].rfidUid, "3A20704F");
  assert.equal(getClaim(claim.claimId).status, CLAIM_BOUND);
});

test.after(() => {
  prisma.user = originalUser;
});
