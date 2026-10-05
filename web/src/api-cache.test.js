import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchApi, clearApiCache, clearSession, _setHttpClientForTests } from "./api.js";

describe("fetchApi GET cache (cacheTtl)", () => {
  let calls;
  const fakeClient = {
    request: async (options) => {
      calls++;
      return { data: { n: calls, url: options.url } };
    },
  };

  beforeEach(() => {
    calls = 0;
    clearApiCache();
    _setHttpClientForTests(fakeClient);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearApiCache();
  });

  it("serves repeat GETs from cache within TTL without a second request", async () => {
    const first = await fetchApi({ method: "GET", url: "/catalog", cacheTtl: 60000 });
    const second = await fetchApi({ method: "GET", url: "/catalog", cacheTtl: 60000 });
    expect(first).toEqual({ success: true, data: { n: 1, url: "/catalog" } });
    expect(second).toEqual(first);
    expect(calls).toBe(1);
  });

  it("refetches after the TTL expires", async () => {
    await fetchApi({ method: "GET", url: "/catalog", cacheTtl: 1000 });
    vi.advanceTimersByTime(1001);
    const second = await fetchApi({ method: "GET", url: "/catalog", cacheTtl: 1000 });
    expect(second.data.n).toBe(2);
    expect(calls).toBe(2);
  });

  it("does not cache when cacheTtl is unset", async () => {
    await fetchApi({ method: "GET", url: "/catalog" });
    await fetchApi({ method: "GET", url: "/catalog" });
    expect(calls).toBe(2);
  });

  it("a successful mutation clears cached GETs", async () => {
    await fetchApi({ method: "GET", url: "/catalog", cacheTtl: 60000 });
    await fetchApi({ method: "POST", url: "/inventory/items", data: {} });
    const after = await fetchApi({ method: "GET", url: "/catalog", cacheTtl: 60000 });
    expect(after.data.n).toBe(3);
    expect(calls).toBe(3);
  });

  it("keys cache by params", async () => {
    await fetchApi({ method: "GET", url: "/orders", params: { page: 1 }, cacheTtl: 60000 });
    await fetchApi({ method: "GET", url: "/orders", params: { page: 2 }, cacheTtl: 60000 });
    expect(calls).toBe(2);
  });

  // Regression: clearApiCache() existed but was never called from app code,
  // so cached data outlived the session. On a shared cart device the next
  // user could be served the previous user's /catalog for up to its TTL.
  it("clearing the session also drops cached GETs", async () => {
    const first = await fetchApi({ method: "GET", url: "/catalog", cacheTtl: 60000 });
    expect(first.data.n).toBe(1);

    clearSession();

    const afterLogout = await fetchApi({ method: "GET", url: "/catalog", cacheTtl: 60000 });
    expect(afterLogout.data.n).toBe(2);
    expect(calls).toBe(2);
  });

  it("a second user signing in on the same device gets fresh data", async () => {
    await fetchApi({ method: "GET", url: "/catalog", cacheTtl: 60000 });
    // sign out of user A, sign in as user B on the shared device
    clearSession();
    const b = await fetchApi({ method: "GET", url: "/catalog", cacheTtl: 60000 });
    expect(b.data.n).toBe(2);
  });
});
