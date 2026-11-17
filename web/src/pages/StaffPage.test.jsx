// Staff page: Manual Log dropdowns and Shift History read-only rules.
// The owner asked that (a) deactivated staff/carts disappear from the Manual
// Log dropdowns, and (b) Shift History cannot be edited or deleted from the
// web — the log is an append-only audit trail.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Outlet } from "react-router-dom";
import { ToastProvider } from "../components/Toast.jsx";

vi.mock("../api.js", () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
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
    if (url === "/staff/schedules") {
      return Promise.resolve({
        data: {
          data: [
            {
              id: 2,
              name: "Stall Staff 1",
              username: "staff01",
              role: "STAFF",
              active: true,
              locationCode: "CART-01",
              schedule: {
                days: [null, { start: "06:00", end: "14:00" }, null, null, null, null, null],
                updatedAt: "2026-11-16T00:00:00Z",
                updatedByName: "Owner",
                history: [],
              },
            },
            {
              id: 3,
              name: "Retired Staff",
              username: "retired",
              role: "STAFF",
              active: false,
              locationCode: null,
              schedule: null,
            },
          ],
        },
      });
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
    await screen.findAllByText("Stall Staff 1", {}, { timeout: 3000 });
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

describe("StaffPage Shift History is read-only", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetLiveData();
    mockApi();
  });

  it("shows the append-only note and offers no edit or delete actions", async () => {
    renderPage();
    expect(await screen.findByText(/append-only/i)).toBeInTheDocument();
    expect(screen.queryByTitle("Edit Log")).toBeNull();
    expect(screen.queryByTitle("Delete Log")).toBeNull();
    expect(api.patch).not.toHaveBeenCalled();
    expect(api.del).not.toHaveBeenCalled();
  });
});

describe("StaffPage Staff Schedules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetLiveData();
    mockApi();
    api.put.mockResolvedValue({ data: { schedule: { days: new Array(7).fill(null) } } });
  });

  const rosterRowFor = (username) =>
    screen.getAllByRole("row").find((r) => r.textContent.includes(username));

  it("shows the weekly roster with status pills", async () => {
    renderPage();
    expect(await screen.findByText("No schedule")).toBeInTheDocument();
    expect(screen.getByText("Scheduled")).toBeInTheDocument();
    expect(screen.getByText("06:00–14:00")).toBeInTheDocument();
    expect(
      screen.getByText((_, el) => el?.textContent?.trim() === "1 of 2 with a schedule"),
    ).toBeInTheDocument();
  });

  it("saves the edited week through PUT /staff/:id/schedule", async () => {
    renderPage();
    await screen.findByText("Scheduled");
    fireEvent.click(within(rosterRowFor("staff01")).getByRole("button", { name: /edit/i }));
    const dialog = document.body.querySelector(".modal");
    expect(dialog).not.toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: /save schedule/i }));
    expect(api.put).toHaveBeenCalledTimes(1);
    const [url, body] = api.put.mock.calls[0];
    expect(url).toBe("/staff/2/schedule");
    expect(body.days).toHaveLength(7);
    expect(body.days[1]).toEqual({ start: "06:00", end: "14:00" });
    expect(body.days[0]).toBeNull();
  });

  it("refuses to save a day whose start is not before its end", async () => {
    renderPage();
    await screen.findByText("Scheduled");
    fireEvent.click(within(rosterRowFor("staff01")).getByRole("button", { name: /edit/i }));
    const dialog = document.body.querySelector(".modal");
    fireEvent.click(within(dialog).getByLabelText("Sunday is off")); // turn Sunday on
    fireEvent.change(within(dialog).getByLabelText("Sunday start"), { target: { value: "14:00" } });
    fireEvent.change(within(dialog).getByLabelText("Sunday end"), { target: { value: "06:00" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /save schedule/i }));
    expect(api.put).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/start must be before the end/i)).toBeInTheDocument();
  });

  it("clears the whole week with Clear week", async () => {
    renderPage();
    await screen.findByText("Scheduled");
    fireEvent.click(within(rosterRowFor("staff01")).getByRole("button", { name: /edit/i }));
    const dialog = document.body.querySelector(".modal");
    fireEvent.click(within(dialog).getByRole("button", { name: /clear week/i }));
    fireEvent.click(within(dialog).getByRole("button", { name: /save schedule/i }));
    const [, body] = api.put.mock.calls[0];
    expect(body.days.every((d) => d === null)).toBe(true);
  });
});
