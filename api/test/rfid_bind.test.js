// Which taps may enrol a card, and which may not.
//
// The rule: enrolling a tag is a deliberate act ("register this card" in
// Settings). Clocking in or out must NEVER enrol one - otherwise whoever
// happens to tap a stray tag while clocking in silently takes it over.
import test from "node:test";
import assert from "node:assert/strict";

import { db as prisma } from "../src/firestore.js";
import {
  CLAIM_ALREADY_REGISTERED,
  CLAIM_BOUND,
  CLAIM_CONFLICT,
  CLAIM_PENDING,
  CLAIM_UNREGISTERED,
  CLAIM_WRONG_CART,
} from "../src/services/rfid.js";
import { getClaim, openClaim, resetClaims } from "../src/services/rfid_claims.js";
import { bindClaimedTag } from "../src/services/rfid_bind.js";

// A tiny in-memory stand-in for the users table.
const mockMessaging = {
  sendEachForMulticast: async () => ({ responses: [], successCount: 0, failureCount: 0 }),
};

const users = [
  {
    id: 2,
    name: "Stall Staff 1",
    username: "staff01",
    rfidUid: "3A20704F",
    rfidLocationCode: "CART-01",
  },
  {
    id: 4,
    name: "Stall Staff 3",
    username: "staff03",
    rfidUid: "06C4D5E6",
    rfidLocationCode: "CART-03",
  },
];

const originalUser = prisma.user;
const originalPushTokens = prisma.pushTokens;
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
    if (user) {
      if (data.rfidUid !== undefined) user.rfidUid = data.rfidUid;
      if (data.rfidLocationCode !== undefined) {
        user.rfidLocationCode = data.rfidLocationCode;
      }
    }
    return user;
  },
  async findMany({ where } = {}) {
    const all = users.map((u) => ({ ...u, active: true, role: u.id === 1 ? "OWNER" : "STAFF" }));
    // The owner is user 1 in this fake (so pushToOwners finds a target).
    if (where?.role === "OWNER") return all.filter((u) => u.role === "OWNER");
    return all;
  },
};
prisma.pushTokens = {
  async findMany() {
    return [{ userId: 1, token: "owner-token" }];
  },
  async deleteMany() {
    return { count: 0 };
  },
};
prisma.alert = {
  async create({ data }) {
    return { id: 999, ...data };
  },
};

function reset() {
  resetClaims();
  users[0].rfidUid = "3A20704F";
  users[0].rfidLocationCode = "CART-01";
  users[1].rfidUid = "06C4D5E6";
  users[1].rfidLocationCode = "CART-03";
}

test("clocking in with a card nobody owns does NOT register it", async () => {
  reset();
  const claim = openClaim({
    userId: 2,
    locationId: 1,
    locationCode: "CART-01",
    event: "IN",
  });

  const result = await bindClaimedTag({ db: prisma, messaging: mockMessaging, skipPush: true, rawUid: "DEADBEEF", locationId: 1 });

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

  const result = await bindClaimedTag({ db: prisma, messaging: mockMessaging, skipPush: true, rawUid: "DEADBEEF", locationId: 1 });

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

  const result = await bindClaimedTag({ db: prisma, messaging: mockMessaging, skipPush: true, rawUid: "DEADBEEF", locationId: 1 });

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

  const result = await bindClaimedTag({ db: prisma, messaging: mockMessaging, skipPush: true, rawUid: "06C4D5E6", locationId: 1 });

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

  const result = await bindClaimedTag({ db: prisma, messaging: mockMessaging, skipPush: true, rawUid: "3A20704F", locationId: 1 });

  assert.equal(result.outcome, "bound");
  assert.equal(result.desiredEvent, "IN", "the tap route uses this for the shift");
  assert.equal(users[0].rfidUid, "3A20704F");
  assert.equal(
    getClaim(claim.claimId).status,
    CLAIM_PENDING,
    "the claim stays open until the shift is written, so the app is never told 'Time in' for a shift the server refuses",
  );
});

test("a card belongs to the cart it was enrolled at", async () => {
  reset();
  // Stall Staff 1's card is enrolled at CART-01. At CART-02 the same card
  // must not work - and must certainly not be (re)registered there.
  const claim = openClaim({
    userId: 2,
    locationId: 2,
    locationCode: "CART-02",
    event: "IN",
  });

  const result = await bindClaimedTag({ db: prisma, messaging: mockMessaging, skipPush: true, rawUid: "3A20704F", locationId: 2 });

  assert.equal(result.outcome, "wrong_cart");
  assert.equal(result.cardLocationCode, "CART-01");
  assert.equal(
    users[0].rfidUid,
    "3A20704F",
    "the card stays where it is",
  );
  assert.equal(
    getClaim(claim.claimId).status,
    CLAIM_WRONG_CART,
    "the app is told which cart the card belongs to",
  );
  assert.equal(
    getClaim(claim.claimId).cardLocationCode,
    "CART-01",
    "the app names the cart",
  );
});

test("enrolling at another cart is refused too", async () => {
  reset();
  const claim = openClaim({
    userId: 2,
    locationId: 2,
    locationCode: "CART-02",
  });

  const result = await bindClaimedTag({ db: prisma, messaging: mockMessaging, skipPush: true, rawUid: "3A20704F", locationId: 2 });

  assert.equal(result.outcome, "wrong_cart");
  assert.equal(users[0].rfidUid, "3A20704F");
  assert.equal(users[0].rfidLocationCode, "CART-01");
  assert.equal(getClaim(claim.claimId).status, CLAIM_WRONG_CART);
});

test("a card with no cart of its own still works anywhere", async () => {
  reset();
  // Enrolled before carts were tracked: never lock a staff member out on a
  // technicality.
  users[0].rfidLocationCode = null;
  const claim = openClaim({
    userId: 2,
    locationId: 2,
    locationCode: "CART-02",
    event: "IN",
  });

  const result = await bindClaimedTag({ db: prisma, messaging: mockMessaging, skipPush: true, rawUid: "3A20704F", locationId: 2 });

  assert.equal(result.outcome, "bound");
  assert.equal(
    getClaim(claim.claimId).status,
    CLAIM_PENDING,
    "a clocking claim is resolved by the tap route, after the shift is written",
  );
});

test("a fresh card is enrolled at the cart where it was tapped", async () => {
  reset();
  const claim = openClaim({
    userId: 2,
    locationId: 2,
    locationCode: "CART-02",
  });

  await bindClaimedTag({ db: prisma, messaging: mockMessaging, skipPush: true, rawUid: "DEADBEEF", locationId: 2 });

  assert.equal(users[0].rfidUid, "DEADBEEF");
  assert.equal(
    users[0].rfidLocationCode,
    "CART-02",
    "the card now belongs to CART-02",
  );
  assert.equal(getClaim(claim.claimId).status, CLAIM_BOUND);
});

test("enrolling a card that is already on the account changes nothing", async () => {
  reset();
  const claim = openClaim({
    userId: 2,
    locationId: 1,
    locationCode: "CART-01",
  });

  const result = await bindClaimedTag({ db: prisma, messaging: mockMessaging, skipPush: true, rawUid: "3A20704F", locationId: 1 });

  // Nothing changed, and the app is told so instead of claiming a card was
  // registered.
  assert.equal(result.outcome, "already_registered");
  assert.equal(users[0].rfidUid, "3A20704F");
  assert.equal(users[0].rfidLocationCode, "CART-01");
  assert.equal(getClaim(claim.claimId).status, CLAIM_ALREADY_REGISTERED);
});

test("clocking in with your own card still records the shift", async () => {
  reset();
  const claim = openClaim({
    userId: 2,
    locationId: 1,
    locationCode: "CART-01",
    event: "IN",
  });

  const result = await bindClaimedTag({ db: prisma, messaging: mockMessaging, skipPush: true, rawUid: "3A20704F", locationId: 1 });

  // The "already registered" rule is enrolment only: clocking writes the shift.
  assert.equal(result.outcome, "bound");
  assert.equal(result.desiredEvent, "IN");
  assert.equal(
    getClaim(claim.claimId).status,
    CLAIM_PENDING,
    "the tap route resolves it with the shift it actually wrote",
  );
});

test("an owner can register a card for a staff member", async () => {
  reset();
  // The owner opens the claim for Stall Staff 3; the card lands on THEIR
  // account, at THEIR cart.
  const claim = openClaim({
    userId: 1,
    targetUserId: 4,
    locationId: 3,
    locationCode: "CART-03",
  });

  const result = await bindClaimedTag({ db: prisma, messaging: mockMessaging, skipPush: true, rawUid: "FEEDFACE", locationId: 3 });

  assert.equal(result.outcome, "bound");
  assert.equal(result.userId, 4);
  assert.equal(users[1].rfidUid, "FEEDFACE");
  assert.equal(users[1].rfidLocationCode, "CART-03");
  assert.equal(users[0].rfidUid, "3A20704F", "the other staff member is untouched");
  assert.equal(getClaim(claim.claimId).status, CLAIM_BOUND);
});

test("an owner's claim never takes another person's card", async () => {
  reset();
  const claim = openClaim({
    userId: 1,
    targetUserId: 4,
    locationId: 3,
    locationCode: "CART-03",
  });

  const result = await bindClaimedTag({ db: prisma, messaging: mockMessaging, skipPush: true, rawUid: "3A20704F", locationId: 3 });

  // Stall Staff 1's card stays theirs, even for an owner.
  assert.equal(result.outcome, "conflict");
  assert.equal(result.holderName, "Stall Staff 1");
  assert.equal(users[0].rfidUid, "3A20704F");
  assert.equal(users[1].rfidUid, "06C4D5E6");
  assert.equal(getClaim(claim.claimId).status, CLAIM_CONFLICT);
});

test("an owner's claim for a card already on that account changes nothing", async () => {
  reset();
  const claim = openClaim({
    userId: 1,
    targetUserId: 4,
    locationId: 3,
    locationCode: "CART-03",
  });

  const result = await bindClaimedTag({ db: prisma, messaging: mockMessaging, skipPush: true, rawUid: "06C4D5E6", locationId: 3 });

  assert.equal(result.outcome, "already_registered");
  assert.equal(users[1].rfidUid, "06C4D5E6");
  assert.equal(getClaim(claim.claimId).status, CLAIM_ALREADY_REGISTERED);
});

test.after(() => {
  prisma.user = originalUser;
  prisma.pushTokens = originalPushTokens;
});
