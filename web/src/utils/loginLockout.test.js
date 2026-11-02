import { describe, expect, it } from "vitest";
import {
  attemptsRemainingFromError,
  formatLockCountdown,
  lockoutSecondsFromError,
} from "./loginLockout.js";

describe("login lockout helpers", () => {
  it("reads retryAfterSeconds from an axios error", () => {
    const err = { response: { status: 429, data: { retryAfterSeconds: 300 } } };
    expect(lockoutSecondsFromError(err)).toBe(300);
  });

  it("computes from lockedUntil when seconds are absent", () => {
    const now = Date.parse("2026-11-02T12:00:00Z");
    const err = {
      data: { lockedUntil: "2026-11-02T12:04:59Z" },
    };
    expect(lockoutSecondsFromError(err, now)).toBe(299);
  });

  it("returns null when the error carries no lock", () => {
    expect(lockoutSecondsFromError({ response: { status: 401, data: {} } })).toBeNull();
    expect(lockoutSecondsFromError(null)).toBeNull();
  });

  it("reads attemptsRemaining only when it is a whole number", () => {
    expect(attemptsRemainingFromError({ data: { attemptsRemaining: 2 } })).toBe(2);
    expect(attemptsRemainingFromError({ data: { attemptsRemaining: 0 } })).toBe(0);
    expect(attemptsRemainingFromError({ data: { attemptsRemaining: "2" } })).toBe(2);
    expect(attemptsRemainingFromError({ data: {} })).toBeNull();
    expect(attemptsRemainingFromError({ data: { attemptsRemaining: -1 } })).toBeNull();
  });

  it("formats a stable m:ss countdown", () => {
    expect(formatLockCountdown(300)).toBe("5:00");
    expect(formatLockCountdown(299)).toBe("4:59");
    expect(formatLockCountdown(9)).toBe("0:09");
    expect(formatLockCountdown(0)).toBe("0:00");
  });
});
