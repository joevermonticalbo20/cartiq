import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Outlet } from "react-router-dom";
import { ToastProvider } from "../components/Toast.jsx";

vi.mock("../api.js", () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
  API_BASE: "/api",
}));

vi.mock("../utils/errors.js", () => ({
  getFriendlyError: (err, fallback) => err?.message || fallback,
}));

vi.mock("../hooks/useSSE.js", () => ({
  useSSE: vi.fn(),
}));

import api from "../api.js";
import { __resetLiveData } from "../state/liveData.js";
import { __resetDashboardCache, cacheTrends, cacheSnapshot } from "../state/dashboardCache.js";
import DashboardPage from "./DashboardPage.jsx";

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <ToastProvider>
        <Routes>
          <Route
            element={<Outlet context={{ user: { name: "Owner", role: "OWNER" } }} />}
          >
            <Route element={<DashboardPage />} path="/" />
          </Route>
        </Routes>
      </ToastProvider>
    </MemoryRouter>
  );
}

function mockApiAllOk() {
  api.get.mockImplementation((url) => {
    if (url.includes("daysAgo")) {
      return Promise.resolve({ data: { total_sales: 1000, orders: 30 } });
    }
    if (url.startsWith("/reports/daily")) {
      return Promise.resolve({ data: { total_sales: 1250, orders: 34 } });
    }
    if (url.startsWith("/inventory")) {
      return Promise.resolve({ data: { locations: [] } });
    }
    if (url.startsWith("/staff/on-shift")) {
      return Promise.resolve({ data: { on_shift: [] } });
    }
    if (url.startsWith("/orders")) {
      return Promise.resolve({ data: { data: [] } });
    }
    if (url.startsWith("/alerts")) {
      return Promise.resolve({ data: { data: [] } });
    }
    if (url.includes("trends")) {
      return Promise.resolve({ data: { by_weekday: [] } });
    }
    if (url.startsWith("/readings/recent")) {
      return Promise.resolve({ data: { readings: [] } });
    }
    return Promise.resolve({ data: null });
  });
}

describe("DashboardPage Cart Status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetLiveData();
    __resetDashboardCache();
  });

  it("hides a deactivated cart from the Cart Status section", async () => {
    api.get.mockImplementation((url) => {
      if (url === "/locations") {
        return Promise.resolve({
          data: {
            data: [
              { id: 1, code: "CART-01", name: "Main Cart", status: "ACTIVE", itemCount: 2 },
              { id: 2, code: "CART-02", name: "Old Cart", status: "INACTIVE", itemCount: 3 },
            ],
          },
        });
      }
      if (url.includes("daysAgo")) {
        return Promise.resolve({ data: { total_sales: 1000, orders: 30 } });
      }
      if (url.startsWith("/reports/daily")) {
        return Promise.resolve({ data: { total_sales: 1250, orders: 34 } });
      }
      if (url.startsWith("/inventory")) {
        return Promise.resolve({
          data: {
            locations: [
              { id: 1, code: "CART-01", name: "Main Cart", items: [] },
              { id: 2, code: "CART-02", name: "Old Cart", items: [] },
            ],
          },
        });
      }
      if (url.startsWith("/staff/on-shift")) {
        return Promise.resolve({ data: { on_shift: [] } });
      }
      if (url.startsWith("/orders")) {
        return Promise.resolve({ data: { data: [] } });
      }
      if (url.includes("trends")) {
        return Promise.resolve({ data: { by_weekday: [] } });
      }
      return Promise.resolve({ data: null });
    });
    renderPage();
    // Active cart appears
    expect(await screen.findByText("CART-01")).toBeInTheDocument();
    // Deactivated cart never shows in the Cart Status section
    const section = screen.getByText("Cart status").closest("section");
    expect(within(section).queryByText("CART-02")).toBeNull();

    // ...and it is not selectable in the "All carts" dropdown either.
    fireEvent.click(screen.getByRole("button", { name: "All carts" }));
    const menu = screen.getByRole("listbox");
    expect(within(menu).getByText("CART-01")).toBeInTheDocument();
    expect(within(menu).queryByText("CART-02")).toBeNull();
  });
});

describe("DashboardPage partial failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The live store is a module singleton (one fetch, shared by every
    // screen): each test starts from a clean slate.
    __resetLiveData();
    __resetDashboardCache();
  });

  it("shows KPIs with no banner when everything succeeds", async () => {
    mockApiAllOk();
    renderPage();
    expect(await screen.findByText("P1,250")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps working sections when one request fails", async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith("/reports/daily") && !url.includes("daysAgo")) {
        return Promise.reject(new Error("boom-500"));
      }
      if (url.includes("daysAgo")) {
        return Promise.resolve({ data: { total_sales: 1000, orders: 30 } });
      }
      if (url.startsWith("/inventory")) {
        return Promise.resolve({ data: { locations: [] } });
      }
      if (url.startsWith("/staff/on-shift")) {
        return Promise.resolve({ data: { on_shift: [] } });
      }
      if (url.startsWith("/orders")) {
        return Promise.resolve({ data: { data: [] } });
      }
      if (url.startsWith("/alerts")) {
        return Promise.resolve({ data: { data: [] } });
      }
      if (url.includes("trends") || url.startsWith("/readings/recent")) {
        return Promise.resolve({ data: url.includes("trends") ? { by_weekday: [] } : { readings: [] } });
      }
      return Promise.resolve({ data: null });
    });
    renderPage();
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent(/Couldn't refresh/);
    expect(banner).toHaveTextContent("Sales");
    // Unavailable numbers render as dashes, not zeros.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("lists every failed section when several fail", async () => {
    mockApiAllOk();
    api.get.mockImplementation((url) => {
      if (url.startsWith("/reports/daily") && !url.includes("daysAgo")) {
        return Promise.reject(new Error("down"));
      }
      if (url.startsWith("/inventory")) {
        return Promise.reject(new Error("down"));
      }
      if (url.includes("daysAgo")) {
        return Promise.resolve({ data: { total_sales: 1000, orders: 30 } });
      }
      if (url.startsWith("/staff/on-shift")) {
        return Promise.resolve({ data: { on_shift: [] } });
      }
      if (url.startsWith("/orders")) {
        return Promise.resolve({ data: { data: [] } });
      }
      if (url.includes("trends") || url.startsWith("/readings/recent")) {
        return Promise.resolve({ data: url.includes("trends") ? { by_weekday: [] } : { readings: [] } });
      }
      return Promise.resolve({ data: null });
    });
    renderPage();
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("Sales");
    expect(banner).toHaveTextContent("Inventory");
    expect(
      banner.textContent.includes("Alerts"),
      "a section that is not rendered must not raise a false error banner",
    ).toBe(false);
  });

  it("treats a network failure like any section failure", async () => {
    mockApiAllOk();
    api.get.mockImplementation((url) => {
      if (url.startsWith("/inventory")) {
        return Promise.reject(new Error("socket hang up"));
      }
      if (url.startsWith("/reports/daily") && !url.includes("daysAgo")) {
        return Promise.resolve({ data: { total_sales: 1250, orders: 34 } });
      }
      if (url.includes("daysAgo")) {
        return Promise.resolve({ data: { total_sales: 1000, orders: 30 } });
      }
      if (url.startsWith("/staff/on-shift")) {
        return Promise.resolve({ data: { on_shift: [] } });
      }
      if (url.startsWith("/orders")) {
        return Promise.resolve({ data: { data: [] } });
      }
      if (url.startsWith("/alerts")) {
        return Promise.resolve({ data: { data: [] } });
      }
      if (url.includes("trends") || url.startsWith("/readings/recent")) {
        return Promise.resolve({ data: url.includes("trends") ? { by_weekday: [] } : { readings: [] } });
      }
      return Promise.resolve({ data: null });
    });
    renderPage();
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("Inventory");
    // Sales KPIs unaffected by the inventory outage.
    expect(await screen.findByText("P1,250")).toBeInTheDocument();
  });

  it("retry re-runs the refresh after partial failure", async () => {
    mockApiAllOk();
    let failReport = true;
    api.get.mockImplementation((url) => {
      if (url.startsWith("/reports/daily") && !url.includes("daysAgo") && failReport) {
        return Promise.reject(new Error("flaky"));
      }
      if (url.startsWith("/reports/daily")) {
        return Promise.resolve({ data: { total_sales: 1250, orders: 34 } });
      }
      if (url.includes("daysAgo")) {
        return Promise.resolve({ data: { total_sales: 1000, orders: 30 } });
      }
      if (url.startsWith("/inventory")) {
        return Promise.resolve({ data: { locations: [] } });
      }
      if (url.startsWith("/staff/on-shift")) {
        return Promise.resolve({ data: { on_shift: [] } });
      }
      if (url.startsWith("/orders")) {
        return Promise.resolve({ data: { data: [] } });
      }
      if (url.startsWith("/alerts")) {
        return Promise.resolve({ data: { data: [] } });
      }
      if (url.includes("trends") || url.startsWith("/readings/recent")) {
        return Promise.resolve({ data: url.includes("trends") ? { by_weekday: [] } : { readings: [] } });
      }
      return Promise.resolve({ data: null });
    });
    renderPage();
    const banner = await screen.findByRole("alert");
    failReport = false;
    fireEvent.click(within(banner).getByText("Retry"));
    expect(await screen.findByText("P1,250")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("DashboardPage weekly per-cart breakdown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetLiveData();
    __resetDashboardCache();
  });

  it("switches from All carts to a single cart from cached trends without waiting for the network", async () => {
    let cartTrendCalls = 0;
    api.get.mockImplementation((url) => {
      if (url === "/locations") {
        return Promise.resolve({
          data: {
            data: [
              { id: 1, code: "CART-01", name: "One", status: "ACTIVE" },
              { id: 2, code: "CART-02", name: "Two", status: "ACTIVE" },
            ],
          },
        });
      }
      if (url.startsWith("/inventory")) {
        return Promise.resolve({
          data: {
            locations: [
              { id: 1, code: "CART-01", name: "One", items: [] },
              { id: 2, code: "CART-02", name: "Two", items: [] },
            ],
          },
        });
      }
      if (url.startsWith("/staff/on-shift")) return Promise.resolve({ data: { on_shift: [] } });
      if (url.startsWith("/orders")) return Promise.resolve({ data: { data: [] } });
      if (url.startsWith("/reports/daily")) {
        return Promise.resolve({ data: { total_sales: 0, orders: 0 } });
      }
      if (url.includes("/analytics/trends")) {
        const code = /code=([^&]+)/.exec(url)?.[1];
        if (code) {
          cartTrendCalls++;
          // The initial All-carts load resolves both carts; any later request
          // stays pending so only the cache can paint the switch.
          if (cartTrendCalls > 2) return new Promise(() => {});
          const total = code === "CART-01" ? 100 : 200;
          return Promise.resolve({
            data: {
              location: decodeURIComponent(code),
              total_sales: total,
              by_weekday: [{ dow: 0, label: "Sun", total_sales: total }],
            },
          });
        }
        return Promise.resolve({
          data: {
            location: "ALL",
            total_sales: 300,
            by_weekday: [{ dow: 0, label: "Sun", total_sales: 300 }],
          },
        });
      }
      return Promise.resolve({ data: null });
    });

    renderPage();
    expect(await screen.findByText("P300")).toBeInTheDocument();
    await waitFor(() => expect(cartTrendCalls).toBe(2));

    fireEvent.click(screen.getByRole("button", { name: "All carts" }));
    fireEvent.click(screen.getByRole("option", { name: "CART-01" }));

    expect(await screen.findByText("P100")).toBeInTheDocument();
  });
});

describe("DashboardPage warm start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetLiveData();
    __resetDashboardCache();
  });

  it("paints warmed data on the first render without the loading skeleton", () => {
    cacheTrends("", { location: "ALL", total_sales: 777, by_weekday: [] });
    cacheSnapshot("", "", {
      report: { total_sales: 777, orders: 9 },
      prev: { total_sales: 700, orders: 8 },
      sales: [],
    });
    api.get.mockImplementation(() => new Promise(() => {}));

    renderPage();

    expect(screen.queryByText("Syncing data...")).toBeNull();
    expect(screen.getAllByText("P777").length).toBeGreaterThan(0);
  });
});

// Regression: the API honours `date` first and ignores `daysAgo`, so asking
// for "yesterday" while also sending the selected date returned the SAME day.
// Every "% vs prior" card then read 0.0% whenever a date filter was on.
describe("DashboardPage previous period with a date filter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetLiveData();
    __resetDashboardCache();
  });

  it("asks for the previous DAY, not the same day with daysAgo", async () => {
    mockApiAllOk();
    const { container } = renderPage();
    await screen.findByText("P1,250");

    const dateInput = container.querySelector('input[type="date"]');
    expect(dateInput).toBeTruthy();
    fireEvent.change(dateInput, { target: { value: "2026-11-10" } });

    await waitFor(() => {
      const urls = api.get.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes("date=2026-11-09"))).toBe(true);
    });
    const urls = api.get.mock.calls.map((c) => String(c[0]));
    // The prior request must not carry the selected day as well.
    expect(urls.some((u) => u.includes("date=2026-11-10&") && u.includes("daysAgo"))).toBe(false);
  });
});
