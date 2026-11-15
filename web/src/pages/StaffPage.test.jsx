// Staff page: Manual Log dropdowns and Staff History edit change detection.
// The owner asked that (a) deactivated staff/carts disappear from the Manual
// Log dropdowns, and (b) saving an unchanged history record shows
// "No changes made" and never touches the server.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Outlet } from "react-router-dom";
import { ToastProvider } from "../components/Toast.jsx";

vi.mock("../api.js", () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() },
  API_BASE: "/api",
}));

vi.mock("../utils/errors.js", () => ({
  getFriendlyError: (err, fallback) => err?.message || fallback,
}));

import api from "../api.js";
import { __resetLiveData } from "../state/liveData.js";
import StaffPage from "./StaffPage.jsx";

const activeStaff = { id: 2, name: "Stall Staff 1", username: "staff01", role: "STAFF", active: true };
const disabledStaff = { id: 3, name: "Retired Staff", username: "retired", role: "STAFF", active: false };
const shiftRow = {
  id: 42,
  staffUid: "1A1336E1",
  staffId: 2,
  staffName: "Stall Staff 1",
  event: "IN",
  ts: "2026-11-15T00:35:00.000Z",
  location: { code: "CART-01", name: "Main Cart" },
  source: "MANUAL",
};

function mockApi() {
  api.get.mockImplementation((url) => {
    if (url === "/auth/staff") {
      return Promise.resolve({ data: { data: [activeStaff, disabledStaff] } });
    }
    if (url === "/locations") {
      return Promise.resolve({
        data: {
          data: [
            { id: 1, code: "CART-01", name: "Main Cart", status: "ACTIVE", itemCount: 14 },
            { id: 2, code: "CART-09", name: "Old Cart", status: "INACTIVE", itemCount: 13 },
          ],
        },
      });
    }
    if (url === "/staff/on-shift") {
      return Promise.resolve({ data: { on_shift: [] } });
    }
    if (url.startsWith("/analytics/staff-performance")) {
      return Promise.resolve({ data: { staff: [] } });
    }
    if (url.startsWith("/shifts/history")) {
      return Promise.resolve({
        data: {
          data: [shiftRow],
          meta: { page: 1, pageSize: 10, total: 1, totalPages: 1 },
        },
      });
    }
    return Promise.resolve({ data: null });
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <ToastProvider>
        <Routes>
          <Route
            element={<Outlet context={{ user: { id: 1, name: "Owner", username: "owner", role: "OWNER" } }} />}
          >
            <Route element={<StaffPage />} path="/" />
          </Route>
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe("StaffPage Manual Log", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetLiveData();
    mockApi();
  });

  it("shows only active staff and active carts in the dropdowns", async () => {
    renderPage();
    await screen.findByText("Stall Staff 1", {}, { timeout: 3000 });
    fireEvent.click(screen.getByRole("button", { name: /Manual Log/ }));
    const dialog = document.body.querySelector(".modal");
    expect(dialog).not.toBeNull();
    // Open the staff select
    const staffField = within(dialog).getByText("Staff Member").closest("label");
    fireEvent.click(within(staffField).getByRole("button"));
    expect(within(staffField).getByText(/Stall Staff 1/)).toBeInTheDocument();
    expect(within(staffField).queryByText(/Retired Staff/)).toBeNull();
    fireEvent.keyDown(within(staffField).getByRole("button"), { key: "Escape" });
    // Open the cart select
    const cartField = within(dialog).getByText("Cart").closest("label");
    fireEvent.click(within(cartField).getByRole("button"));
    expect(within(cartField).getAllByRole("option", { name: "CART-01" }).length).toBeGreaterThan(0);
    expect(within(cartField).queryByRole("option", { name: "CART-09" })).toBeNull();
  });
});

describe("StaffPage Staff History edit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetLiveData();
    mockApi();
  });

  it("reports no changes and does not call the server when nothing was modified", async () => {
    renderPage();
    const editBtn = await screen.findByTitle("Edit Log");
    fireEvent.click(editBtn);
    const dialog = document.body.querySelector(".modal");
    expect(dialog?.textContent).toContain("Edit Shift Log");
    fireEvent.click(within(dialog).getByRole("button", { name: /Save Changes/ }));
    expect(await screen.findByText("No changes made")).toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it("saves when the timestamp actually changed", async () => {
    api.patch.mockResolvedValue({ data: { shift: { id: 42 } } });
    renderPage();
    const editBtn = await screen.findByTitle("Edit Log");
    fireEvent.click(editBtn);
    const dialog = document.body.querySelector(".modal");
    const timeInput = dialog.querySelector('input[type="datetime-local"]');
    fireEvent.change(timeInput, { target: { value: "2026-11-15T02:00" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Save Changes/ }));
    await vi.waitFor(() => expect(api.patch).toHaveBeenCalled());
  });
});
