import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Outlet } from "react-router-dom";
import { ToastProvider } from "../components/Toast.jsx";

vi.mock("../api.js", () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
  API_BASE: "/api",
}));

import api from "../api.js";
import GcashApprovalsPage from "./GcashApprovalsPage.jsx";

const pendingOrder = {
  orderId: 9,
  id: 9,
  total: 120,
  createdAt: "2026-11-17T00:00:00.000Z",
  staffName: "Stall Staff 1",
  locationCode: "CART-01",
  itemCount: 2,
  items: [
    { productName: "Flavored Fries", flavor: "Cheese", qty: 2, unitPrice: 60 },
  ],
  receiptAvailable: true,
  receiptReplacedAfterRecording: false,
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <ToastProvider>
        <Routes>
          <Route
            element={<Outlet context={{ user: { name: "Owner", role: "OWNER" } }} />}
          >
            <Route element={<GcashApprovalsPage />} path="/" />
          </Route>
        </Routes>
      </ToastProvider>
    </MemoryRouter>
  );
}

describe("GcashApprovalsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockResolvedValue({
      data: { data: [pendingOrder], meta: { total: 1 } },
    });
    api.patch.mockResolvedValue({
      data: { order: { ...pendingOrder, status: "PAID" }, restored: [], warnings: [] },
    });
  });

  it("renders the pending GCash order and confirms without a note", async () => {
    renderPage();
    expect(await screen.findByText("#9")).toBeInTheDocument();
    expect(screen.getByText("₱120.00")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Confirm$/ }));
    // The confirm dialog asks no note - Void payment is enabled by default.
    const confirm = await screen.findByRole("button", { name: "Confirm payment" });
    expect(confirm).not.toBeDisabled();

    fireEvent.click(confirm);
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        "/orders/9/gcash-decision",
        { decision: "confirm" },
      ),
    );
  });

  it("shows a table skeleton while approvals are loading", () => {
    api.get.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByRole("region", { name: "Loading GCash approvals" })).toBeInTheDocument();
  });

  it("decline allows choosing a preset reason", async () => {
    renderPage();
    expect(await screen.findByText("#9")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Decline$/ }));
    const confirm = await screen.findByRole("button", { name: "Decline payment" });
    expect(confirm).toBeDisabled();

    fireEvent.click(screen.getByRole("radio", { name: "Transaction not found in GCash account" }));
    expect(confirm).not.toBeDisabled();

    fireEvent.click(confirm);
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        "/orders/9/gcash-decision",
        { decision: "reject", note: "Transaction not found in GCash account" },
      ),
    );
  });

  it("allows entering a specific GCash decline reason", async () => {
    renderPage();
    expect(await screen.findByText("#9")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Decline$/ }));
    fireEvent.click(screen.getByRole("radio", { name: "Other / type a specific reason" }));

    const confirm = await screen.findByRole("button", { name: "Decline payment" });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Specific reason" }), {
      target: { value: "Transaction reference does not match" },
    });
    expect(confirm).not.toBeDisabled();

    fireEvent.click(confirm);
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        "/orders/9/gcash-decision",
        { decision: "reject", note: "Transaction reference does not match" },
      ),
    );
  });

  it("shows the empty state when nothing is waiting", async () => {
    api.get.mockResolvedValue({ data: { data: [], meta: { total: 0 } } });
    renderPage();
    expect(await screen.findByText("No GCash payments waiting")).toBeInTheDocument();
  });

  it("bulk confirms selected GCash payments below the table", async () => {
    renderPage();
    expect(await screen.findByText("#9")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "Select GCash payment for order 9" }));
    expect(screen.getByText("1 of 1 selected")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Confirm selected" })[0]);
    fireEvent.click((await screen.findAllByRole("button", { name: "Confirm selected" })).at(-1));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        "/orders/9/gcash-decision",
        { decision: "confirm" },
      ),
    );
  });
});
