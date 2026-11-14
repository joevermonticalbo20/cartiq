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

describe("DashboardPage partial failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The live store is a module singleton (one fetch, shared by every
    // screen): each test starts from a clean slate.
    __resetLiveData();
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

// Regression: the API honours `date` first and ignores `daysAgo`, so asking
// for "yesterday" while also sending the selected date returned the SAME day.
// Every "% vs prior" card then read 0.0% whenever a date filter was on.
describe("DashboardPage previous period with a date filter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetLiveData();
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
