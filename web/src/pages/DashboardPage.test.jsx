import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Outlet } from "react-router-dom";
import { ToastProvider } from "../components/Toast.jsx";

vi.mock("../api.js", () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
  API_BASE: "/api",
  getErrorMessage: (err, fallback) => err?.message || fallback,
}));

vi.mock("../hooks/useSSE.js", () => ({
  useSSE: vi.fn(),
}));

import api from "../api.js";
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
      if (url.startsWith("/alerts")) {
        return Promise.reject(new Error("down"));
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
      if (url.includes("trends") || url.startsWith("/readings/recent")) {
        return Promise.resolve({ data: url.includes("trends") ? { by_weekday: [] } : { readings: [] } });
      }
      return Promise.resolve({ data: null });
    });
    renderPage();
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("Sales");
    expect(banner).toHaveTextContent("Alerts");
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
