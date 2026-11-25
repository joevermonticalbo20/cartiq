// Staff page: Manual Log dropdowns and Shift History read-only rules.
// The owner asked that (a) deactivated staff/carts disappear from the Manual
// Log dropdowns, and (b) Shift History cannot be edited or deleted from the
// web — the log is an append-only audit trail.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
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
import { __emitLiveEvent } from "../hooks/useLiveStream.js";
import { LIVE_EVENTS } from "../hooks/liveEvents.js";
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
            absences: 1,
            half_days: 1,
            hours_worked: 80.5,
          },
          staff: [
            {
              staff_id: 2, name: "Stall Staff 1", username: "staff01", role: "STAFF",
              active: true, locationCode: "CART-01", scheduled_days: 24,
              clock_ins: 8, clock_outs: 8, on_time: 7, tardy: 1, early_out: 1,
              hours_worked: 70.4,
              absences: 0, half_days: 1, on_time_pct: 88,
            },
            {
              staff_id: 3, name: "Retired Staff", username: "retired", role: "STAFF",
              active: false, locationCode: null, scheduled_days: 24,
              clock_ins: 2, clock_outs: 1, on_time: 1, tardy: 1, early_out: 0,
              hours_worked: 10.1,
              absences: 1, half_days: 0, on_time_pct: 50,
            },
          ],
        },
      });
    }
    if (url.startsWith("/alerts")) {
      return Promise.resolve({
        data: {
          data: [
            { id: 1, type: "UNKNOWN_CARD", createdAt: new Date().toISOString() },
            { id: 2, type: "UNKNOWN_CARD", createdAt: "2026-01-01T00:00:00Z" },
            { id: 3, type: "SHIFT", createdAt: new Date().toISOString() },
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

  it("refreshes the shift history table when a tap is recorded live", async () => {
    let historyCalls = 0;
    const originalGet = api.get.getMockImplementation();
    api.get.mockImplementation((url) => {
      if (String(url).startsWith("/shifts/history")) historyCalls++;
      return originalGet(url);
    });
    renderPage();
    await screen.findByText("Attendance report");
    const before = historyCalls;
    expect(before).toBeGreaterThan(0);

    __emitLiveEvent(LIVE_EVENTS.shiftNew, { event: "IN" });
    await waitFor(() => expect(historyCalls).toBeGreaterThan(before));
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
    expect(await screen.findByText("83%")).toBeInTheDocument();
    // Half-day rule: the column shows for the half-day day.
    expect(screen.getAllByText("Half days").length).toBeGreaterThanOrEqual(2);
    // "Tardy" was renamed to "Late" in both the KPI and the table header.
    expect(screen.getAllByText("Late").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("Tardy")).toBeNull();
    expect(screen.getByRole("button", { name: /csv/i })).toBeEnabled();
  });

  it("counts only today's unregistered card taps", async () => {
    renderPage();
    expect(await screen.findByText("Attendance report")).toBeInTheDocument();
    expect(await screen.findByText("1 unregistered tap today")).toBeInTheDocument();
  });

  it("filters shift history in the browser as the user types, without refetching", async () => {
    renderPage();
    expect(await screen.findByText("Attendance report")).toBeInTheDocument();

    const historyRequests = () =>
      api.get.mock.calls.map(([url]) => String(url))
        .filter((url) => url.startsWith("/shifts/history?"));
    const before = historyRequests().length;

    fireEvent.change(screen.getByRole("searchbox", { name: "Search shift history" }), {
      target: { value: "Stall" },
    });

    // Instant: no new request for a search keystroke.
    expect(historyRequests()).toHaveLength(before);
    const matchesInHistory = () => {
      const section = screen.getByText("Shift History").closest("section");
      const table = within(section).queryByText("Punctuality")?.closest("table");
      return table ? within(table).queryAllByText("Stall Staff 1") : [];
    };
    expect(matchesInHistory().length).toBeGreaterThan(0);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search shift history" }), {
      target: { value: "zzzz" },
    });
    await waitFor(() => expect(matchesInHistory()).toHaveLength(0));

    // "mai" is only inside the cart NAME (Main Cart), which is not a
    // searchable column — the row must stay hidden.
    fireEvent.change(screen.getByRole("searchbox", { name: "Search shift history" }), {
      target: { value: "mai" },
    });
    await waitFor(() => expect(matchesInHistory()).toHaveLength(0));

    // "in" matches the visible EVENT column (IN) and not the OUT rows, even
    // though "Main Cart" also contains "in".
    fireEvent.change(screen.getByRole("searchbox", { name: "Search shift history" }), {
      target: { value: "in" },
    });
    await waitFor(() => expect(matchesInHistory().length).toBeGreaterThan(0));
  });

  it("sends select filters (event/method/punctuality/date) to the paged endpoint", async () => {
    renderPage();
    expect(await screen.findByText("Attendance report")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Filter by event" }));
    fireEvent.click(screen.getByRole("option", { name: "OUT" }));
    fireEvent.click(screen.getByRole("button", { name: "Filter by method" }));
    fireEvent.click(screen.getByRole("option", { name: "MANUAL" }));
    fireEvent.click(screen.getByRole("button", { name: "Filter by punctuality" }));
    fireEvent.click(screen.getByRole("option", { name: "Half day" }));
    fireEvent.change(screen.getByLabelText("Filter by date"), {
      target: { value: "2026-11-24" },
    });

    await waitFor(() => {
      const historyRequests = api.get.mock.calls
        .map(([url]) => String(url))
        .filter((url) => url.startsWith("/shifts/history?"));
      expect(historyRequests).toContain(
        "/shifts/history?page=1&pageSize=100&event=OUT&method=MANUAL&punctuality=half-day&date=2026-11-24",
      );
    });
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
    const card = cardFor("staff01");
    expect(within(card).queryByText("6:00 AM")).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: /view week/i }));
    // Times are displayed in 12-hour format after opening a roster.
    expect(screen.getByText("6:00 AM")).toBeInTheDocument();
    expect(screen.getByText("2:00 PM")).toBeInTheDocument();
    expect(
      screen.getByText((_, el) => el?.textContent?.trim() === "1 of 2 with a schedule"),
    ).toBeInTheDocument();
  });

  it("paginates larger staff lists and searches across pages", async () => {
    const getMock = api.get.getMockImplementation();
    const scheduleRows = Array.from({ length: 9 }, (_, index) => ({
      id: index + 10,
      name: `Staff ${index + 1}`,
      username: `staff${String(index + 1).padStart(2, "0")}`,
      role: "STAFF",
      active: true,
      locationCode: `CART-${String(index + 1).padStart(2, "0")}`,
      schedule: null,
    }));
    api.get.mockImplementation((url, ...args) =>
      url === "/staff/schedules"
        ? Promise.resolve({ data: { data: scheduleRows } })
        : getMock(url, ...args),
    );

    renderPage();
    expect(await screen.findByText(/@staff01/)).toBeInTheDocument();
    expect(screen.queryByText(/@staff07/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Page 2" }));
    expect(await screen.findByText(/@staff07/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search staff schedules" }), {
      target: { value: "staff09" },
    });
    expect(await screen.findByText(/@staff09/)).toBeInTheDocument();
    expect(screen.queryByText(/@staff01/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Page 2" })).toBeNull();
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
