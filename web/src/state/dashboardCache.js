// Dashboard data lives here instead of inside the page component, so it
// survives navigating away and back. The shell warms it in idle time and on
// Dashboard nav hover; the page paints from it immediately, then revalidates.
import api from "../api.js";
import { loadLiveList } from "./liveData.js";
import { addCartBreakdowns } from "../utils/analytics.js";

const TTL = 5 * 60 * 1000;
const snapshots = new Map(); // `${dateFilter}|${cartFilter}` -> payload
const trends = new Map(); // cart code ("" = All carts) -> trends response
const inflight = new Map();

function fresh(entry) {
  return Boolean(entry && Date.now() - entry.at < TTL);
}

export function getCachedTrends(cartFilter = "") {
  const entry = trends.get(cartFilter);
  return fresh(entry) ? entry.data : null;
}

export function cacheTrends(cartFilter, data) {
  if (!data) return;
  trends.set(cartFilter, { data, at: Date.now() });
}

export function getCachedSnapshot(dateFilter = "", cartFilter = "") {
  const entry = snapshots.get(`${dateFilter}|${cartFilter}`);
  return fresh(entry) ? entry : null;
}

export function cacheSnapshot(dateFilter, cartFilter, payload) {
  const key = `${dateFilter}|${cartFilter}`;
  const previous = snapshots.get(key) ?? {};
  snapshots.set(key, {
    report: payload.report !== undefined ? payload.report : previous.report,
    prev: payload.prev !== undefined ? payload.prev : previous.prev,
    sales: payload.sales !== undefined ? payload.sales : previous.sales,
    at: Date.now(),
  });
}

export function hasCachedDashboardView(dateFilter = "", cartFilter = "") {
  return Boolean(getCachedSnapshot(dateFilter, cartFilter) || getCachedTrends(cartFilter));
}

// Warm the default view (All carts, no date filter) before the page opens.
// Safe to call repeatedly: one in-flight load is shared by every caller.
export function prefetchDashboard() {
  if (inflight.has("default")) return inflight.get("default");

  const load = (async () => {
    const [carts, aggregate, report, sales, prev] = await Promise.all([
      loadLiveList("carts"),
      api.get("/analytics/trends?days=7").catch(() => ({ data: null })),
      api.get("/reports/daily").catch(() => ({ data: null })),
      api.get("/orders?page=1&pageSize=5").catch(() => ({ data: null })),
      api.get("/reports/daily?daysAgo=1").catch(() => ({ data: null })),
    ]);

    const cartResults = await Promise.all(
      (Array.isArray(carts) ? carts : [])
        .filter((loc) => loc.status !== "INACTIVE" && loc.code)
        .map(async (loc) => {
          try {
            const { data } = await api.get(
              `/analytics/trends?days=7&code=${encodeURIComponent(loc.code)}`
            );
            if (data?.location !== loc.code) return null;
            cacheTrends(loc.code, data);
            return { code: loc.code, data };
          } catch {
            return null;
          }
        })
    );

    if (aggregate.data) {
      cacheTrends(
        "",
        addCartBreakdowns(aggregate.data, cartResults.filter(Boolean))
      );
    }
    cacheSnapshot("", "", {
      report: report.data,
      prev: prev.data,
      sales: sales.data?.data,
    });
  })()
    .catch(() => {})
    .finally(() => inflight.delete("default"));

  inflight.set("default", load);
  return load;
}

export function clearDashboardCache() {
  snapshots.clear();
  trends.clear();
}

// Test seam: each test file needs a clean slate.
export const __resetDashboardCache = clearDashboardCache;
