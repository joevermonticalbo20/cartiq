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
    if (url.startsWith("/shifts/report")) {
      return Promise.resolve({
        data: {
          period_days: 28,
          generated_at: "2026-11-18T02:00:00Z",
          totals: {
            on_time_pct: 83,
            clock_ins: 10,
            clock_outs: 9,
            on_time: 8,
            tardy: 2,
            early_out: 1,
            overtime_min: 45,
            overtime_hours: 0.8,
            absences: 1,
            half_days: 1,
            hours_worked: 80.5,
          },
          staff: [
            {
              staff_id: 2, name: "Stall Staff 1", username: "staff01", role: "STAFF",
              active: true, locationCode: "CART-01", scheduled_days: 24,
              clock_ins: 8, clock_outs: 8, on_time: 7, tardy: 1, early_out: 1,
              overtime_min: 45, overtime_hours: 0.8, hours_worked: 70.4,
              absences: 0, half_days: 1, on_time_pct: 88,
            },
            {
              staff_id: 3, name: "Retired Staff", username: "retired", role: "STAFF",
              active: false, locationCode: null, scheduled_days: 24,
              clock_ins: 2, clock_outs: 1, on_time: 1, tardy: 1, early_out: 0,
              overtime_min: 0, overtime_hours: 0, hours_worked: 10.1,
              absences: 1, half_days: 0, on_time_pct: 50,
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

  it("shows the attendance report for the owner with KPIs and per-staff rows", async () => {
    renderPage();
    expect(await screen.findByText("Attendance report")).toBeInTheDocument();
    expect(screen.getByText("83%")).toBeInTheDocument();
    // Half-day rule: the column shows for the half-day day.
    expect(screen.getAllByText("Half days").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole("button", { name: /csv/i })).toBeEnabled();
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

  const cardFor = (username) =>
    screen.getAllByText(new RegExp(`@${username}`)).find((el) => el.closest?.("article"))?.closest("article");

  it("shows the weekly roster cards with status pills", async () => {
    renderPage();
    expect(await screen.findByText("No schedule")).toBeInTheDocument();
    expect(screen.getByText("Scheduled")).toBeInTheDocument();
    // Times are displayed in 12-hour format now.
    expect(screen.getByText("6:00 AM")).toBeInTheDocument();
    expect(screen.getByText("2:00 PM")).toBeInTheDocument();
    expect(
      screen.getByText((_, el) => el?.textContent?.trim() === "1 of 2 with a schedule"),
    ).toBeInTheDocument();
  });

  it("saves the edited week through PUT /staff/:id/schedule", async () => {
    renderPage();
    await screen.findByText("Scheduled");
    fireEvent.click(within(cardFor("staff01")).getByRole("button", { name: /edit/i }));
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
    fireEvent.click(within(cardFor("staff01")).getByRole("button", { name: /edit/i }));
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
    fireEvent.click(within(cardFor("staff01")).getByRole("button", { name: /edit/i }));
    const dialog = document.body.querySelector(".modal");
    fireEvent.click(within(dialog).getByRole("button", { name: /clear week/i }));
    fireEvent.click(within(dialog).getByRole("button", { name: /save schedule/i }));
    const [, body] = api.put.mock.calls[0];
    expect(body.days.every((d) => d === null)).toBe(true);
  });

  it("removes the schedule after a confirmation", async () => {
    api.del.mockResolvedValue({ data: { deleted: true } });
    renderPage();
    await screen.findByText("Scheduled");
    fireEvent.click(within(cardFor("staff01")).getByRole("button", { name: /edit/i }));
    const dialog = document.body.querySelector(".modal");
    fireEvent.click(within(dialog).getByRole("button", { name: /remove schedule/i }));
    // The confirm dialog spells out the consequence before the delete runs.
    const confirm = await screen.findByText(/becomes unrestricted again/i);
    expect(confirm).toBeInTheDocument();
    const dangerButton = screen
      .getAllByRole("button", { name: "Remove schedule" })
      .find((b) => b.classList.contains("danger"));
    fireEvent.click(dangerButton);
    expect(api.del).toHaveBeenCalledWith("/staff/2/schedule");
    expect(await screen.findByText("No schedule")).toBeInTheDocument();
  });
});
