import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Outlet } from "react-router-dom";
import { ToastProvider } from "../components/Toast.jsx";

vi.mock("../api.js", () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() },
  API_BASE: "/api",
}));

import api from "../api.js";
import { __resetLiveData } from "../state/liveData.js";
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
    if (url === "/locations") {
      return Promise.resolve({
        data: {
          data: [
            { id: 1, code: "CART-01", name: "Cart 1", status: "ACTIVE" },
            { id: 2, code: "CART-09", name: "Old Cart", status: "INACTIVE" },
          ],
        },
      });
    }
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
    // The live store is a module singleton (one fetch, shared by every
    // screen): each test starts from a clean slate.
    __resetLiveData();
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

  it("hides a deactivated cart from the All carts dropdown", async () => {
    mockApi([]);
    renderPage();
    await screen.findByText("No expenses in this period");

    fireEvent.click(screen.getByRole("button", { name: "All carts" }));
    const menu = screen.getByRole("listbox");
    expect(within(menu).getByText("CART-01 - Cart 1")).toBeInTheDocument();
    expect(within(menu).queryByText(/CART-09/)).toBeNull();
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

describe("ExpensesPage add vendor and cart validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetLiveData();
    mockApi();
    api.post.mockResolvedValue({ data: { expense: { id: 8 } } });
  });

  async function openAdd() {
    renderPage();
    await screen.findByText("SM Supermarket");
    fireEvent.click(screen.getByRole("button", { name: /Add Expense/i }));
    const dialog = document.body.querySelector(".modal");
    expect(dialog?.textContent).toContain("Vendor / Supplier");
    return dialog;
  }

  it("refuses a vendor shorter than 3 characters", async () => {
    const dialog = await openAdd();
    const vendorInput = within(dialog).getByPlaceholderText("e.g. SM Supermarket");
    fireEvent.change(vendorInput, { target: { value: "AB" } });
    fireEvent.change(within(dialog).getByPlaceholderText("0.00"), { target: { value: "75" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Save Expense/ }));
    expect(await within(dialog).findByText("Vendor must be at least 3 characters.")).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("normalizes runs of spaces to a single space on save", async () => {
    const dialog = await openAdd();
    fireEvent.change(within(dialog).getByPlaceholderText("e.g. SM Supermarket"), { target: { value: "ABC  Supplier" } });
    fireEvent.change(within(dialog).getByPlaceholderText("0.00"), { target: { value: "75" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Save Expense/ }));
    await vi.waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/expenses",
        expect.objectContaining({ vendor: "ABC Supplier" }),
      ),
    );
  });

  it("shows only ACTIVE carts in the Cart Assignment dropdown", async () => {
    const dialog = await openAdd();
    const field = within(dialog).getByText("Cart Assignment").closest("label");
    fireEvent.click(within(field).getByRole("button"));
    expect(within(field).getAllByRole("option", { name: /CART-01/ }).length).toBeGreaterThan(0);
    expect(within(field).queryByRole("option", { name: /CART-09/ })).toBeNull();
  });
});

describe("ExpensesPage edit change feedback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The live store is a module singleton (one fetch, shared by every
    // screen): each test starts from a clean slate.
    __resetLiveData();
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
