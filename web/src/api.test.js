import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isTokenExpired,
  getTokenExpiry,
  writeSession,
  readSessionToken,
  readRefreshToken,
  clearSession,
} from "./api.js";

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

describe("session storage (remember me)", () => {
  let origLs;
  let origSs;

  function memStore() {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => void m.set(k, String(v)),
      removeItem: (k) => void m.delete(k),
      clear: () => m.clear(),
      _map: m,
    };
  }

  let ls;
  let ss;

  beforeEach(() => {
    ls = memStore();
    ss = memStore();
    origLs = window.localStorage;
    origSs = window.sessionStorage;
    Object.defineProperty(window, "localStorage", {
      value: ls,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "sessionStorage", {
      value: ss,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "localStorage", {
      value: origLs,
      writable: true,
      configurable: true,
    });
    if (origSs !== undefined) {
      Object.defineProperty(window, "sessionStorage", {
        value: origSs,
        writable: true,
        configurable: true,
      });
    }
  });

  it("remember:true persists to localStorage only", () => {
    writeSession({ token: "t", refreshToken: "r", remember: true });
    expect(ls._map.get("cartiq_token")).toBe("t");
    expect(ls._map.get("cartiq_refresh_token")).toBe("r");
    expect(ss._map.size).toBe(0);
    expect(readSessionToken()).toBe("t");
    expect(readRefreshToken()).toBe("r");
  });

  it("remember:false scopes to sessionStorage and clears stale persistent copies", () => {
    ls._map.set("cartiq_token", "stale");
    ls._map.set("cartiq_refresh_token", "stale-r");
    writeSession({ token: "t", refreshToken: "r", remember: false });
    expect(ss._map.get("cartiq_token")).toBe("t");
    expect(ss._map.get("cartiq_refresh_token")).toBe("r");
    expect(ls._map.size).toBe(0);
    expect(readSessionToken()).toBe("t");
    expect(readRefreshToken()).toBe("r");
  });

  it("pre-existing localStorage sessions keep working", () => {
    ls._map.set("cartiq_token", "old");
    expect(readSessionToken()).toBe("old");
  });

  it("clearSession wipes both stores", () => {
    writeSession({ token: "t", refreshToken: "r", remember: true });
    writeSession({ token: "t2", refreshToken: "r2", remember: false });
    clearSession();
    expect(readSessionToken()).toBeNull();
    expect(readRefreshToken()).toBeNull();
    expect(ls._map.size).toBe(0);
    expect(ss._map.size).toBe(0);
  });
});
