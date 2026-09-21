import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Outlet } from "react-router-dom";
import { ToastProvider } from "../components/Toast.jsx";

vi.mock("../api.js", () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() },
  API_BASE: "/api",
}));

// Recharts needs ResizeObserver, which jsdom lacks — stub the chart
// primitives so the data sections (tables, summaries) still render.
vi.mock("recharts", () => {
  const Stub = ({ children }) => <div>{children}</div>;
  return {
    AreaChart: Stub,
    Area: Stub,
    BarChart: Stub,
    Bar: Stub,
    XAxis: Stub,
    YAxis: Stub,
    Tooltip: Stub,
    ResponsiveContainer: Stub,
    CartesianGrid: Stub,
    Cell: Stub,
    LabelList: Stub,
  };
});

import api from "../api.js";
import AnalyticsPage from "./AnalyticsPage.jsx";

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <ToastProvider>
        <Routes>
          <Route
            element={<Outlet context={{ user: { name: "Owner", role: "OWNER" } }} />}
          >
            <Route element={<AnalyticsPage />} path="/" />
          </Route>
        </Routes>
      </ToastProvider>
    </MemoryRouter>
  );
}

const curTrends = {
  total_sales: 5000,
  orders: 100,
  top_items: [
    { name: "Cheese Fries", qty: 60, sales: 3000 },
    { name: "BBQ Fries", qty: 40, sales: 2000 },
  ],
  by_weekday: [{ dow: 1, label: "Mon", total_sales: 1000, orders: 20 }],
};

const prevTrends = {
  total_sales: 8000,
  orders: 160,
  top_items: [{ name: "Cheese Fries", qty: 50, sales: 2500 }],
};

const cartForecast = {
  code: "CART-01",
  items: [
    {
      name: "Cheese Powder",
      current_stock: 10,
      unit: "kg",
      avg_daily_use: 1,
      depletion_date: "2026-10-01",
      mape_pct: 12.5,
      risk: "high",
      data_sufficient: true,
    },
  ],
};

const salesForecast = {
  data_sufficient: true,
  mape: 8.5,
  forecast: [{ date: "Day 1", expected_use: 100 }],
};

function mockApiAllOk() {
  api.get.mockImplementation((url) => {
    if (url === "/catalog") {
      return Promise.resolve({ data: { locations: [{ code: "CART-01", name: "Cart 1" }] } });
    }
    if (url.startsWith("/analytics/trends")) {
      return Promise.resolve({ data: url.includes("days=60") ? prevTrends : curTrends });
    }
    if (url.startsWith("/analytics/forecast")) {
      return Promise.resolve({ data: cartForecast });
    }
    if (url.startsWith("/analytics/sales-forecast")) {
      return Promise.resolve({ data: salesForecast });
    }
    return Promise.resolve({ data: null });
  });
}

function calledUrls() {
  return api.get.mock.calls.map((c) => String(c[0]));
}

describe("AnalyticsPage loading/error states", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows a loading skeleton while fetching", () => {
    api.get.mockReturnValue(new Promise(() => {}));
    const { container } = renderPage();
    expect(screen.getByRole("status", { name: "Loading analytics" })).toBeInTheDocument();
    expect(container.querySelector(".skel")).not.toBeNull();
    expect(screen.queryByText("Quick Summary")).toBeNull();
  });

  it("shows an error with retry on failure, not the dashboard sections", async () => {
    api.get.mockImplementation((url) => {
      if (url === "/catalog") return Promise.resolve({ data: { locations: [] } });
      return Promise.reject(new Error("analytics-down"));
    });
    renderPage();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("analytics-down");
    expect(within(alert).getByText("Retry")).toBeInTheDocument();
    expect(screen.queryByText("Quick Summary")).toBeNull();
  });

  it("never requests the retired basket endpoint", async () => {
    mockApiAllOk();
    renderPage();
    await screen.findByText("Quick Summary");
    expect(calledUrls().some((u) => u.includes("/analytics/basket"))).toBe(false);
  });
});

describe("AnalyticsPage forecast honesty guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiAllOk();
  });

  it("labels forecast accuracy as sMAPE with a tooltip, not MAPE", async () => {
    mockApiAllOk();
    renderPage();
    await screen.findByText("Quick Summary");

    // Pick CART-01 so the per-cart forecast table loads.
    fireEvent.click(screen.getByRole("button", { name: "All carts" }));
    fireEvent.click(await screen.findByRole("option", { name: /CART-01/ }));

    const header = await screen.findByTitle(
      "Symmetric mean absolute percentage error (0-200%)"
    );
    expect(header).toHaveTextContent("sMAPE");
    expect(screen.queryByText("MAPE")).toBeNull();
  });

  it("labels the revenue backtest as sMAPE", async () => {
    mockApiAllOk();
    renderPage();
    expect(await screen.findByText(/backtest sMAPE/)).toBeInTheDocument();
    expect(screen.getByText("8.5%")).toBeInTheDocument();
  });

  it("shows sort direction arrows on the items table", async () => {
    mockApiAllOk();
    renderPage();
    await screen.findByText("Quick Summary");

    // Default sort is Revenue desc — exactly one active arrow.
    expect(screen.getAllByText("↓")).toHaveLength(1);

    // Sorting another column moves the arrow instead of blanking it.
    fireEvent.click(screen.getByText(/Qty Sold/));
    expect(screen.getAllByText("↓")).toHaveLength(1);
    fireEvent.click(screen.getByText(/Qty Sold/));
    expect(screen.getByText("↑")).toBeInTheDocument();
  });
});
