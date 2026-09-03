import { describe, it, expect } from "vitest";
import { isTokenExpired, getTokenExpiry } from "./api.js";

function makeToken(payload, expSecondsFromNow) {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const exp = expSecondsFromNow === null ? now - 1 : now + expSecondsFromNow;
  const body = btoa(JSON.stringify({ ...payload, exp }));
  const sig = "mock-signature";
  return `${header}.${body}.${sig}`;
}

describe("isTokenExpired", () => {
  it("returns true for empty token", () => {
    expect(isTokenExpired("")).toBe(true);
    expect(isTokenExpired(null)).toBe(true);
    expect(isTokenExpired(undefined)).toBe(true);
  });

  it("returns true for malformed token", () => {
    expect(isTokenExpired("not-a-jwt")).toBe(true);
    expect(isTokenExpired("aaa.bbb.ccc.ddd")).toBe(true);
  });

  it("returns true for token past its expiry", () => {
    const expired = makeToken({ sub: 1 }, -100);
    expect(isTokenExpired(expired)).toBe(true);
  });

  it("returns false for token still valid", () => {
    const valid = makeToken({ sub: 1 }, 3600);
    expect(isTokenExpired(valid)).toBe(false);
  });
});

describe("getTokenExpiry", () => {
  it("returns null for empty token", () => {
    expect(getTokenExpiry("")).toBe(null);
    expect(getTokenExpiry(null)).toBe(null);
  });

  it("returns null for malformed token", () => {
    expect(getTokenExpiry("not-a-jwt")).toBe(null);
  });

  it("returns the expiry in milliseconds for valid token", () => {
    const valid = makeToken({ sub: 1 }, 3600);
    const expiry = getTokenExpiry(valid);
    expect(expiry).toBeGreaterThan(Date.now());
    expect(expiry).toBeLessThan(Date.now() + 3600 * 1000 + 1000);
  });
});
