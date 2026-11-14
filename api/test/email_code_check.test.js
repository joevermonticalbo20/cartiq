// The recovery-email code check: the field turns red for a wrong code and
// green for the right one, and only the server knows - so the server answers
// without changing anything.
import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateCode,
  hashOtp,
  OTP_TTL_MS,
} from "../src/services/password_reset.js";

const now = 1_700_000_000_000;
const live = {
  tokenHash: hashOtp("123456"),
  expiresAt: new Date(now + OTP_TTL_MS),
};

test("the right code is accepted", () => {
  const verdict = evaluateCode(live, "123456", now);
  assert.equal(verdict.valid, true);
});

test("a wrong code is refused, and says so", () => {
  const verdict = evaluateCode(live, "654321", now);
  assert.equal(verdict.valid, false);
  assert.equal(verdict.reason, "wrong");
});

test("a code past its lifetime is expired, not wrong", () => {
  const verdict = evaluateCode(live, "123456", now + OTP_TTL_MS + 1);
  assert.equal(verdict.valid, false);
  assert.equal(verdict.reason, "expired");
});

test("no code at all is not a wrong code", () => {
  const verdict = evaluateCode(null, "123456", now);
  assert.equal(verdict.valid, false);
  assert.equal(verdict.reason, "no_code");
});

test("a broken record never passes", () => {
  assert.equal(
    evaluateCode({ ...live, tokenHash: "not-hex" }, "123456", now).valid,
    false,
  );
  assert.equal(evaluateCode(live, "123456", now).valid, true);
});
