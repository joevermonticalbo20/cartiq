import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Outlet } from "react-router-dom";
import { ToastProvider } from "../components/Toast.jsx";

vi.mock("../api.js", () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() },
  API_BASE: "/api",
}));

import api from "../api.js";
import ExpensesPage from "./ExpensesPage.jsx";

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <ToastProvider>
        <Routes>
          <Route
            element={<Outlet context={{ user: { name: "Owner", role: "OWNER" } }} />}
          >
            <Route element={<ExpensesPage />} path="/" />
          </Route>
        </Routes>
      </ToastProvider>
    </MemoryRouter>
  );
}

const seedRows = [
  {
    id: 7,
    vendor: "SM Supermarket",
    amount: 150.5,
    // Date-only string: new Date(...) parses it as UTC midnight, so the
    // modal's toISOString round-trip keeps the same day in any timezone.
    date: "2026-09-20",
    category: "Supplies",
    note: "",
    source: "MANUAL",
    location: { code: "CART-01" },
  },
];

function mockApi(rows = seedRows) {
  api.get.mockImplementation((url) => {
    if (url === "/catalog") {
      return Promise.resolve({ data: { locations: [{ code: "CART-01", name: "Cart 1" }] } });
    }
    if (url.startsWith("/expenses")) {
      return Promise.resolve({
        data: { data: rows, meta: { total: rows.length, page: 1, pageSize: 50, totalPages: 1 } },
      });
    }
    return Promise.resolve({ data: null });
  });
}

describe("ExpensesPage loading/error states", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading skeletons while fetching", () => {
    api.get.mockReturnValue(new Promise(() => {}));
    const { container } = renderPage();
    expect(container.querySelector(".skel")).not.toBeNull();
    expect(screen.queryByText("No expenses in this period")).toBeNull();
  });

  it("shows the empty state on success with zero expenses", async () => {
    mockApi([]);
    renderPage();
    expect(await screen.findByText("No expenses in this period")).toBeInTheDocument();
    expect(screen.queryByText("SM Supermarket")).toBeNull();
  });

  it("shows the server error instead of the empty state on failure", async () => {
    api.get.mockImplementation((url) => {
      if (url === "/catalog") return Promise.resolve({ data: { locations: [] } });
      if (url.startsWith("/expenses")) return Promise.reject(new Error("expenses-down"));
      return Promise.resolve({ data: null });
    });
    renderPage();
    expect(await screen.findByText("expenses-down")).toBeInTheDocument();
    expect(screen.queryByText("No expenses in this period")).toBeNull();
  });
});

describe("ExpensesPage edit change feedback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi();
    api.patch.mockResolvedValue({ data: {} });
  });

  async function openEdit() {
    renderPage();
    await screen.findByText("SM Supermarket");
    fireEvent.click(screen.getByTitle("Edit expense"));
    expect(await screen.findByText("Edit Expense")).toBeInTheDocument();
  }

  it("reports no changes with an em-dash when nothing was touched", async () => {
    await openEdit();
    fireEvent.click(screen.getByText("Save Changes"));
    expect(
      await screen.findByText("No changes — nothing to update on this expense.")
    ).toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it("saves when the amount actually changed", async () => {
    await openEdit();
    const amountInput = screen.getByTitle("Whole pesos max 7 digits, up to 2 decimals");
    fireEvent.change(amountInput, { target: { value: "200" } });
    fireEvent.click(screen.getByText("Save Changes"));
    expect(await screen.findByText("Expense for SM Supermarket updated")).toBeInTheDocument();
    expect(api.patch).toHaveBeenCalledWith(
      "/expenses/7",
      expect.objectContaining({ amount: 200 })
    );
  });
});
