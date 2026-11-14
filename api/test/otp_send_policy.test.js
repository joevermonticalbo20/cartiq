// The resend policy: what the server is allowed to do with one OTP request.
//
// These are the rules the owner asked for:
//   * a code is good for 5 minutes
//   * a 60 second cooldown between successful sends
//   * 5 successful sends per address in 15 minutes - the 6th is blocked
//   * a 15 minute lockout after that, then the address may ask again
//   * a system-wide cap, so many addresses cannot become a mail cannon
import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateGlobalPolicy,
  evaluateSendPolicy,
  otpLimitId,
  OTP_GLOBAL_MAX_SENDS_PER_HOUR,
  OTP_LOCKOUT_MS,
  OTP_MAX_SENDS_PER_WINDOW,
  OTP_RESEND_COOLDOWN_MS,
  OTP_SEND_WINDOW_MS,
} from "../src/services/password_reset.js";

const now = 1_700_000_000_000;

test("the first send is allowed", () => {
  const verdict = evaluateSendPolicy({}, now);
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.sends, 0);
  assert.equal(verdict.windowStartedAt, now);
});

test("an immediate resend is blocked by the cooldown", () => {
  const state = { sends: 1, lastSentAt: now, windowStartedAt: now };
  const verdict = evaluateSendPolicy(state, now + 1000);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "cooldown");
  assert.equal(verdict.retryAfterMs, OTP_RESEND_COOLDOWN_MS - 1000);
});

test("the 60th second is allowed again", () => {
  const state = { sends: 1, lastSentAt: now, windowStartedAt: now };
  const verdict = evaluateSendPolicy(state, now + OTP_RESEND_COOLDOWN_MS);
  assert.equal(verdict.allowed, true);
});

test("59 seconds is still blocked", () => {
  const state = { sends: 1, lastSentAt: now, windowStartedAt: now };
  const verdict = evaluateSendPolicy(state, now + OTP_RESEND_COOLDOWN_MS - 1);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "cooldown");
});

test("five sends in the window are allowed, the sixth is not", () => {
  let state = { sends: 0, windowStartedAt: now, lastSentAt: 0 };
  for (let i = 0; i < OTP_MAX_SENDS_PER_WINDOW; i++) {
    const verdict = evaluateSendPolicy(state, now + i * (OTP_RESEND_COOLDOWN_MS + 1000));
    assert.equal(verdict.allowed, true, `send ${i + 1} must be allowed`);
    state = {
      sends: verdict.sends + 1,
      windowStartedAt: verdict.windowStartedAt,
      lastSentAt: now + i * (OTP_RESEND_COOLDOWN_MS + 1000),
    };
  }
  const sixth = evaluateSendPolicy(state, now + 10 * (OTP_RESEND_COOLDOWN_MS + 1000));
  assert.equal(sixth.allowed, false);
  assert.equal(sixth.reason, "locked");
  assert.ok(sixth.retryAfterMs > 0);
  assert.equal(sixth.lockedUntil, state.windowStartedAt + OTP_LOCKOUT_MS);
});

test("a lockout that has not expired blocks everything", () => {
  const state = {
    sends: OTP_MAX_SENDS_PER_WINDOW,
    windowStartedAt: now,
    lastSentAt: now,
    lockedUntil: now + 60_000,
  };
  const verdict = evaluateSendPolicy(state, now + 1000);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "locked");
  assert.equal(verdict.retryAfterMs, 59_000);
});

test("after the lockout the address may ask again", () => {
  const state = {
    sends: OTP_MAX_SENDS_PER_WINDOW,
    windowStartedAt: now,
    lastSentAt: now,
    lockedUntil: now + OTP_LOCKOUT_MS,
  };
  const later = now + OTP_LOCKOUT_MS + 1;
  const verdict = evaluateSendPolicy(state, later);
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.sends, 0, "the window is over, the budget is fresh");
  assert.equal(verdict.windowStartedAt, later);
});

test("a window that expired on its own starts over", () => {
  const state = {
    sends: OTP_MAX_SENDS_PER_WINDOW,
    windowStartedAt: now,
    lastSentAt: now - 1000,
  };
  const verdict = evaluateSendPolicy(state, now + OTP_SEND_WINDOW_MS + 1000);
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.sends, 0);
});

test("the system-wide cap stops a spray across many addresses", () => {
  let state = { sends: 0, windowStartedAt: now };
  for (let i = 0; i < OTP_GLOBAL_MAX_SENDS_PER_HOUR; i++) {
    const verdict = evaluateGlobalPolicy(state, now);
    assert.equal(verdict.allowed, true);
    state = { sends: verdict.sends + 1, windowStartedAt: verdict.windowStartedAt };
  }
  const over = evaluateGlobalPolicy(state, now);
  assert.equal(over.allowed, false);
  assert.equal(over.reason, "global_limit");
  assert.ok(over.retryAfterMs > 0);
});

test("the global window resets after an hour", () => {
  const state = { sends: OTP_GLOBAL_MAX_SENDS_PER_HOUR, windowStartedAt: now };
  const later = now + 60 * 60 * 1000 + 1;
  const verdict = evaluateGlobalPolicy(state, later);
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.sends, 0);
});

test("the limit id does not leak the address", () => {
  const id = otpLimitId("Someone@Example.com");
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.ok(!id.includes("example"));
  assert.equal(id, otpLimitId("someone@example.com"), "the id is stable per address");
  assert.notEqual(id, otpLimitId("other@example.com"));
});
