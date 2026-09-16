import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { assertOwnLocation } from "../src/middleware/auth.js";

const ownerReq = () => ({ user: { role: "OWNER", locationId: null } });
const staffReq = (locationId) => ({ user: { role: "STAFF", locationId } });

describe("assertOwnLocation", () => {
  it("OWNERs bypass any cart", () => {
    assert.doesNotThrow(() => assertOwnLocation(ownerReq(), 999));
  });

  it("STAFF pass for their own cart", () => {
    assert.doesNotThrow(() => assertOwnLocation(staffReq(3), 3));
  });

  it("STAFF are rejected outside their cart with 403", () => {
    assert.throws(() => assertOwnLocation(staffReq(1), 2), (err) => {
      assert.equal(err.status, 403);
      assert.match(err.message, /outside your assigned cart/);
      return true;
    });
  });

  it("STAFF with no assigned cart are rejected with 403", () => {
    assert.throws(() => assertOwnLocation(staffReq(null), 1), (err) => {
      assert.equal(err.status, 403);
      assert.match(err.message, /no cart assigned/);
      return true;
    });
  });
});
