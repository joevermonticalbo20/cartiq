import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  LOGIN_FAILURE_WINDOW_MS,
  LOGIN_LOCK_MS,
  LOGIN_MAX_FAILED_ATTEMPTS,
  formatRetryAfter,
  lockRemainingMs,
  loginAttemptKey,
  loginLockMessage,
  registerLoginFailure,
  retryAfterSeconds,
} from "../src/services/login_lockout.js";

describe("login lockout policy", () => {
  it("allows five failures, then arms the lock on the fifth", () => {
    const now = 1_700_000_000_000;
    let state = null;

    for (let attempt = 1; attempt <= 4; attempt++) {
      state = registerLoginFailure(state, now + attempt);
      assert.equal(state.locked, false);
      assert.equal(state.failedCount, attempt);
      assert.equal(state.attemptsRemaining, LOGIN_MAX_FAILED_ATTEMPTS - attempt);
      assert.equal(state.lockedUntilMs, 0);
    }

    state = registerLoginFailure(state, now + 5);
    assert.equal(state.locked, true);
    assert.equal(state.failedCount, LOGIN_MAX_FAILED_ATTEMPTS);
    assert.equal(state.attemptsRemaining, 0);
    assert.equal(state.lockedUntilMs, now + 5 + LOGIN_LOCK_MS);
  });

  it("blocks the sixth attempt for the full five minutes", () => {
    const now = 1_700_000_000_000;
    let state = null;
    for (let i = 0; i < LOGIN_MAX_FAILED_ATTEMPTS; i++) {
      state = registerLoginFailure(state, now);
    }

    const remaining = lockRemainingMs(state, now + 1);
    assert.equal(remaining, LOGIN_LOCK_MS - 1);
    assert.equal(retryAfterSeconds(remaining), LOGIN_LOCK_MS / 1000);
    assert.equal(lockRemainingMs(state, state.lockedUntilMs), 0);
    assert.equal(lockRemainingMs(state, state.lockedUntilMs + 1), 0);
  });

  it("never extends an active lock when another failure lands", () => {
    const now = 1_700_000_000_000;
    let state = null;
    for (let i = 0; i < LOGIN_MAX_FAILED_ATTEMPTS; i++) {
      state = registerLoginFailure(state, now);
    }
    const armedUntil = state.lockedUntilMs;

    const raced = registerLoginFailure(state, now + 30_000);
    assert.equal(raced.locked, true);
    assert.equal(raced.lockedUntilMs, armedUntil);
    assert.equal(raced.failedCount, LOGIN_MAX_FAILED_ATTEMPTS);
  });

  it("starts a fresh five-attempt run after the lock expires", () => {
    const now = 1_700_000_000_000;
    let state = null;
    for (let i = 0; i < LOGIN_MAX_FAILED_ATTEMPTS; i++) {
      state = registerLoginFailure(state, now);
    }

    const afterExpiry = registerLoginFailure(state, state.lockedUntilMs);
    assert.equal(afterExpiry.locked, false);
    assert.equal(afterExpiry.failedCount, 1);
    assert.equal(afterExpiry.attemptsRemaining, LOGIN_MAX_FAILED_ATTEMPTS - 1);
  });

  it("forgets a stale partial run outside the failure window", () => {
    const now = 1_700_000_000_000;
    let state = null;
    for (let i = 0; i < 4; i++) state = registerLoginFailure(state, now);

    const later = registerLoginFailure(state, now + LOGIN_FAILURE_WINDOW_MS + 1);
    assert.equal(later.locked, false);
    assert.equal(later.failedCount, 1);
  });

  it("hashes usernames case-insensitively into a path-safe doc id", () => {
    assert.match(loginAttemptKey("Owner"), /^[0-9a-f]{64}$/);
    assert.equal(loginAttemptKey("  Owner "), loginAttemptKey("owner"));
    assert.notEqual(loginAttemptKey("owner"), loginAttemptKey("manager"));
  });

  it("formats the wait as m:ss", () => {
    assert.equal(formatRetryAfter(300), "5:00");
    assert.equal(formatRetryAfter(299), "4:59");
    assert.equal(formatRetryAfter(9), "0:09");
    assert.equal(loginLockMessage(300), "Too many failed attempts. Wait 5:00 and try again.");
    assert.equal(retryAfterSeconds(0), 0);
    assert.equal(retryAfterSeconds(1), 1);
  });
});
