import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api.js", () => ({
  default: { get: vi.fn() },
}));
vi.mock("./liveData.js", () => ({
  loadLiveList: vi.fn(),
}));

import api from "../api.js";
import { loadLiveList } from "./liveData.js";
import {
  prefetchDashboard,
  getCachedTrends,
  getCachedSnapshot,
  cacheTrends,
  cacheSnapshot,
  __resetDashboardCache,
} from "./dashboardCache.js";

describe("dashboardCache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetDashboardCache();
  });

  it("prefetches the All-carts view, including each active cart's trend", async () => {
    loadLiveList.mockResolvedValue([
      { code: "CART-01", status: "ACTIVE" },
      { code: "CART-02", status: "INACTIVE" },
    ]);
    api.get.mockImplementation((url) => {
      if (url === "/analytics/trends?days=7") {
        return Promise.resolve({ data: { location: "ALL", total_sales: 300, by_weekday: [] } });
      }
      if (url.includes("code=CART-01")) {
        return Promise.resolve({ data: { location: "CART-01", total_sales: 100, by_weekday: [] } });
      }
      if (url === "/reports/daily") {
        return Promise.resolve({ data: { total_sales: 50, orders: 2 } });
      }
      if (url.startsWith("/orders")) {
        return Promise.resolve({ data: { data: [{ id: 1 }] } });
      }
      if (url.includes("daysAgo")) {
        return Promise.resolve({ data: { total_sales: 40, orders: 1 } });
      }
      return Promise.resolve({ data: null });
    });

    await prefetchDashboard();

    expect(getCachedTrends("")).toMatchObject({ total_sales: 300 });
    expect(getCachedTrends("CART-01")).toMatchObject({ total_sales: 100 });
    // The deactivated cart is not queried or cached.
    expect(getCachedTrends("CART-02")).toBeNull();
    expect(getCachedSnapshot("", "").report).toEqual({ total_sales: 50, orders: 2 });
  });

  it("shares one in-flight prefetch and clears on demand", () => {
    loadLiveList.mockResolvedValue([]);
    api.get.mockImplementation(() => new Promise(() => {}));
    const first = prefetchDashboard();
    const second = prefetchDashboard();
    expect(second).toBe(first);

    cacheTrends("", { total_sales: 1 });
    cacheSnapshot("", "", { report: { total_sales: 1 } });
    __resetDashboardCache();
    expect(getCachedTrends("")).toBeNull();
    expect(getCachedSnapshot("", "")).toBeNull();
  });
});
