import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Outlet } from "react-router-dom";
import { ToastProvider } from "../components/Toast.jsx";

vi.mock("../api.js", () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  clearSession: vi.fn(),
}));

vi.mock("../utils/errors.js", () => ({
  getFriendlyError: (err, fallback) => err?.message || fallback,
}));

import api, { clearSession } from "../api.js";
import { __resetLiveData } from "../state/liveData.js";
import SettingsPage from "./SettingsPage.jsx";

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <ToastProvider>
        <Routes>
          <Route
            element={<Outlet context={{ user: null }} />}
          >
            <Route element={<SettingsPage />} path="/" />
          </Route>
        </Routes>
      </ToastProvider>
    </MemoryRouter>
  );
}

const emptyOk = (url) => {
  if (url === "/catalog") return Promise.resolve({ data: { locations: [] } });
  if (url === "/devices" || url === "/auth/staff") {
    return Promise.resolve({ data: { data: [] } });
  }
  return Promise.resolve({ data: {} });
};

describe("SettingsPage profile states", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The live store is a module singleton (one fetch, shared by every
    // screen): each test starts from a clean slate.
    __resetLiveData();
  });

  it("shows profile details on success", async () => {
    api.get.mockImplementation((url) => {
      if (url === "/auth/me") {
        return Promise.resolve({ data: { user: { name: "Owner", role: "OWNER" } } });
      }
      return emptyOk(url);
    });
    renderPage();
    expect(await screen.findByText("Owner")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows an error with retry when the profile request fails", async () => {
    api.get.mockImplementation((url) => {
      if (url === "/auth/me") return Promise.reject(new Error("down"));
      return emptyOk(url);
    });
    renderPage();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Unable to load profile.");
    expect(screen.queryByText("Owner")).toBeNull();
  });

  it("shows a placeholder recovery email and saves a real one", async () => {
    api.get.mockImplementation((url) => {
      if (url === "/auth/me") {
        return Promise.resolve({
          data: { user: { name: "Owner", username: "owner", role: "OWNER", email: null } },
        });
      }
      return emptyOk(url);
    });
    api.post.mockResolvedValue({
      data: { sent: true, email: "o***@example.com", expiresInMinutes: 10, message: "A 6-digit verification code was sent to that email." },
    });
    api.patch.mockResolvedValue({
      data: {
        user: {
          name: "Owner",
          username: "owner",
          role: "OWNER",
          email: "owner@example.com",
        },
      },
    });
    renderPage();
    expect(await screen.findByText("owner@cartiq.local")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Edit recovery email"));
    const dialog = await screen.findByRole("dialog", { name: "Recovery email" });
    fireEvent.change(within(dialog).getByLabelText("Email address"), {
      target: { value: "owner@example.com" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /Send code/ }));
    await vi.waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/auth/me/email-otp", { email: "owner@example.com" }),
    );
    fireEvent.change(within(dialog).getByLabelText(/Verification code/), {
      target: { value: "123456" },
    });
    fireEvent.change(within(dialog).getByLabelText(/Current password/), {
      target: { value: "oldpass123" },
    });
    fireEvent.click(within(dialog).getByText("Save email"));
    await vi.waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/auth/me", {
        email: "owner@example.com",
        currentPassword: "oldpass123",
        code: "123456",
      }),
    );
    expect(await screen.findByText("owner@example.com")).toBeInTheDocument();
  });

  it("retry reloads the profile after a failure", async () => {
    let meCalls = 0;
    api.get.mockImplementation((url) => {
      if (url === "/auth/me") {
        meCalls++;
        if (meCalls === 1) return Promise.reject(new Error("down"));
        return Promise.resolve({ data: { user: { name: "Owner", role: "OWNER" } } });
      }
      return emptyOk(url);
    });
    renderPage();
    const alert = await screen.findByRole("alert");
    fireEvent.click(within(alert).getByText("Retry"));
    expect(await screen.findByText("Owner")).toBeInTheDocument();
  });
});

describe("SettingsPage password change", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs out and redirects to login after a code-confirmed change", async () => {
    api.get.mockImplementation((url) => {
      if (url === "/auth/me") {
        return Promise.resolve({
          data: {
            user: {
              name: "Owner",
              username: "owner",
              role: "OWNER",
              email: "owner@example.com",
            },
          },
        });
      }
      return emptyOk(url);
    });
    api.post.mockImplementation((url) => {
      if (url === "/auth/change-password/otp") {
        return Promise.resolve({
          data: { sent: true, email: "o***@example.com", message: "Code sent." },
        });
      }
      if (url === "/auth/change-password") return Promise.resolve({ data: { updated: true } });
      return Promise.resolve({ data: {} });
    });
    render(
      <MemoryRouter initialEntries={["/"]}>
        <ToastProvider>
          <Routes>
            <Route element={<Outlet context={{ user: { name: "Owner", role: "OWNER" } }} />}>
              <Route element={<SettingsPage />} path="/" />
              <Route element={<div>Login screen</div>} path="/login" />
            </Route>
          </Routes>
        </ToastProvider>
      </MemoryRouter>
    );
    expect(await screen.findByText("owner@example.com")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Current password/i), { target: { value: "oldpass123" } });
    const sendButton = screen.getByRole("button", { name: "Send code" });
    expect(sendButton).not.toBeDisabled();
    fireEvent.click(sendButton);
    await vi.waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/auth/change-password/otp", {}),
    );
    expect(await screen.findByText(/Sent to o\*\*\*@example.com/i)).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("6-digit code"), { target: { value: "482916" } });
    // The meter promises "Good" strength, so the handler must accept only a
    // password that reaches it (upper/lower, number, special).
    fireEvent.change(screen.getByPlaceholderText("At least 8 characters"), { target: { value: "Newpass123!" } });
    fireEvent.change(screen.getByLabelText(/Confirm new password/i), { target: { value: "Newpass123!" } });
    fireEvent.click(screen.getByText("Update password"));
    expect(await screen.findByText("Login screen")).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith("/auth/change-password", {
      currentPassword: "oldpass123",
      newPassword: "Newpass123!",
      code: "482916",
    });
    // Session clear goes through the shared helper (both storages).
    expect(clearSession).toHaveBeenCalled();
  });

  it("refuses a password below the promised strength", async () => {
    api.get.mockImplementation((url) => {
      if (url === "/auth/me") {
        return Promise.resolve({
          data: {
            user: {
              name: "Owner",
              username: "owner",
              role: "OWNER",
              email: "owner@example.com",
            },
          },
        });
      }
      return emptyOk(url);
    });
    api.post.mockImplementation((url) => {
      if (url === "/auth/change-password/otp") {
        return Promise.resolve({
          data: { sent: true, email: "o***@example.com", message: "Code sent." },
        });
      }
      return Promise.resolve({ data: {} });
    });
    render(
      <MemoryRouter initialEntries={["/"]}>
        <ToastProvider>
          <Routes>
            <Route element={<Outlet context={{ user: { name: "Owner", role: "OWNER" } }} />}>
              <Route element={<SettingsPage />} path="/" />
              <Route element={<div>Login screen</div>} path="/login" />
            </Route>
          </Routes>
        </ToastProvider>
      </MemoryRouter>
    );
    expect(await screen.findByText("owner@example.com")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Current password/i), { target: { value: "oldpass123" } });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    await vi.waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/auth/change-password/otp", {}),
    );
    fireEvent.change(screen.getByPlaceholderText("6-digit code"), { target: { value: "482916" } });
    // 9 chars, lower + digits only: "Fair", not "Good".
    fireEvent.change(screen.getByPlaceholderText("At least 8 characters"), { target: { value: "newpass123" } });
    fireEvent.change(screen.getByLabelText(/Confirm new password/i), { target: { value: "newpass123" } });
    fireEvent.click(screen.getByText("Update password"));

    expect(await screen.findByText(/at least 'Good' strength/i)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalledWith(
      "/auth/change-password",
      expect.anything(),
    );
  });
});

describe("SettingsPage cart/device confirmations", () => {
  const seedCarts = [
    { id: 11, code: "CART-01", name: "Cart 1", status: "ACTIVE", itemCount: 4, device: null },
  ];
  const seedDevices = [
    { id: 21, device_id: "ESP32-A1", cart: "CART-01", active: true, online: false, last_seen_at: null },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    __resetLiveData();
    api.get.mockImplementation((url) => {
      if (url === "/auth/me") {
        return Promise.resolve({ data: { user: { name: "Owner", role: "OWNER" } } });
      }
      if (url === "/devices") return Promise.resolve({ data: { data: seedDevices } });
      if (url === "/auth/staff") return Promise.resolve({ data: { data: [] } });
      if (url === "/locations") return Promise.resolve({ data: { data: seedCarts } });
      return emptyOk(url);
    });
    api.patch.mockResolvedValue({ data: {} });
    api.del.mockResolvedValue({ data: {} });
  });

  function renderOwnerPage() {
    return render(
      <MemoryRouter initialEntries={["/"]}>
        <ToastProvider>
          <Routes>
            <Route
              element={<Outlet context={{ user: { name: "Owner", role: "OWNER" } }} />}
            >
              <Route element={<SettingsPage />} path="/" />
            </Route>
          </Routes>
        </ToastProvider>
      </MemoryRouter>
    );
  }

  it("asks for confirmation before deactivating a cart", async () => {
    renderOwnerPage();
    fireEvent.click(await screen.findByTitle("Deactivate"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Deactivate CART-01?");
    fireEvent.click(within(dialog).getByText("Deactivate", { selector: "button" }));
    expect(api.patch).toHaveBeenCalledWith("/locations/11", { status: "INACTIVE" });
    expect(await screen.findByText("Cart CART-01 deactivated")).toBeInTheDocument();
  });

  it("disables edit actions for inactive carts", async () => {
    api.get.mockImplementation((url) => {
      if (url === "/auth/me") {
        return Promise.resolve({ data: { user: { name: "Owner", role: "OWNER" } } });
      }
      if (url === "/devices") {
        return Promise.resolve({ data: { data: seedDevices } });
      }
      if (url === "/auth/staff") return Promise.resolve({ data: { data: [] } });
      if (url === "/locations") {
        return Promise.resolve({
          data: { data: [{ id: 12, code: "CART-02", name: "Offline Cart", status: "INACTIVE", itemCount: 0, device: null }] },
        });
      }
      return emptyOk(url);
    });
    renderOwnerPage();
    expect(await screen.findByText("UNASSIGNED")).toBeInTheDocument();
    const cartPanel = screen.getByText("Carts").closest("section");
    expect(within(cartPanel).getByTitle("Activate the cart before renaming")).toBeDisabled();
  });

  it("asks for confirmation before deleting a device", async () => {
    renderOwnerPage();
    await screen.findByText("ESP32-A1");
    fireEvent.click(screen.getByTitle("Delete Device"));
    expect(await screen.findByText("Delete IoT Device?")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Delete Device", { selector: "button" }));
    expect(api.del).toHaveBeenCalledWith("/devices/21");
    expect(await screen.findByText("Device ESP32-A1 deleted")).toBeInTheDocument();
  });
});

describe("SettingsPage time clock", () => {
  const clockSeed = {
    enabled: false,
    inOpen: "07:00",
    inClose: "09:00",
    outOpen: "17:00",
    outClose: "19:00",
    days: [0, 1, 2, 3, 4, 5, 6],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    __resetLiveData();
    api.get.mockImplementation((url) => {
      if (url === "/auth/me") {
        return Promise.resolve({ data: { user: { name: "Owner", role: "OWNER" } } });
      }
      if (url === "/settings/timeclock") {
        return Promise.resolve({ data: { clock: clockSeed } });
      }
      return emptyOk(url);
    });
    api.put.mockResolvedValue({
      data: {
        clock: {
          enabled: true,
          inOpen: "08:00",
          inClose: "09:30",
          outOpen: "17:30",
          outClose: "19:00",
          days: [1, 2, 3, 4, 5, 6],
        },
      },
    });
  });

  function renderOwnerPage() {
    return render(
      <MemoryRouter initialEntries={["/"]}>
        <ToastProvider>
          <Routes>
            <Route
              element={<Outlet context={{ user: { name: "Owner", role: "OWNER" } }} />}
            >
              <Route element={<SettingsPage />} path="/" />
            </Route>
          </Routes>
        </ToastProvider>
      </MemoryRouter>,
    );
  }

  it("renders the OFF state with 12-hour editors and all day chips", async () => {
    renderOwnerPage();
    expect(await screen.findByText("Time clock")).toBeInTheDocument();
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    expect(
      screen.getByText("Schedule is OFF — both buttons always work (current behavior)."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Time in opens hour")).toBeDisabled();
    expect(screen.getByLabelText("Time out opens AM or PM")).toBeDisabled();
    // 12-hour values shown, e.g. 05:00 PM for 17:00.
    expect(screen.getByLabelText("Time out opens AM or PM")).toHaveValue("PM");
    expect(screen.getByLabelText("Time out opens hour")).toHaveValue("5");
    expect(screen.getByLabelText("Time in opens AM or PM")).toHaveValue("AM");
    expect(screen.getByLabelText("Time in opens hour")).toHaveValue("7");
    // Every selling day is on.
    for (const label of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) {
      expect(screen.getByRole("button", { name: label })).toHaveAttribute("aria-pressed", "true");
    }
  });

  it("turning ON enables the 12h editors and day chips", async () => {
    renderOwnerPage();
    expect(await screen.findByText("Time clock")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch"));
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Schedule is ON")).toBeInTheDocument();
    expect(screen.getByLabelText("Time in opens hour")).toBeEnabled();
    expect(screen.getByLabelText("Time out closes hour")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Sun" })).toBeEnabled();
  });

  it("saves the ON config with the selected selling days", async () => {
    renderOwnerPage();
    expect(await screen.findByText("Time clock")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.change(screen.getByLabelText("Time in opens hour"), { target: { value: "8" } });
    fireEvent.change(screen.getByLabelText("Time out opens hour"), { target: { value: "6" } });
    fireEvent.change(screen.getByLabelText("Time out opens AM or PM"), {
      target: { value: "PM" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sun" })); // uncheck Sunday
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await vi.waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/settings/timeclock", {
        enabled: true,
        inOpen: "08:00",
        inClose: "09:00",
        outOpen: "18:00",
        outClose: "19:00",
        days: [1, 2, 3, 4, 5, 6],
      }),
    );
    expect(await screen.findByText("Time clock saved")).toBeInTheDocument();
  });

  it("blocks saving with no selling day selected, without calling the server", async () => {
    renderOwnerPage();
    expect(await screen.findByText("Time clock")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch"));
    for (const label of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) {
      fireEvent.click(screen.getByRole("button", { name: label }));
    }
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("at least one day");
    expect(api.put).not.toHaveBeenCalled();
  });

  it("blocks saving when Time in opens after it closes", async () => {
    renderOwnerPage();
    expect(await screen.findByText("Time clock")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.change(screen.getByLabelText("Time in opens hour"), { target: { value: "9" } });
    fireEvent.change(screen.getByLabelText("Time in opens minute"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "opening time must be before the closing time",
    );
    expect(api.put).not.toHaveBeenCalled();
  });

  it("blocks saving when Time out opens after it closes", async () => {
    renderOwnerPage();
    expect(await screen.findByText("Time clock")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.change(screen.getByLabelText("Time out opens hour"), { target: { value: "8" } });
    fireEvent.change(screen.getByLabelText("Time out opens AM or PM"), {
      target: { value: "PM" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Time out: the opening time must be before the closing time",
    );
    expect(api.put).not.toHaveBeenCalled();
  });

  it("blocks saving a Time out that is earlier than the Time in", async () => {
    // Time in 4:00-4:10 PM with Time out 3:00-3:10 PM is not a schedule: a
    // shift has to start before it can end.
    renderOwnerPage();
    expect(await screen.findByText("Time clock")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.change(screen.getByLabelText("Time in opens hour"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("Time in opens AM or PM"), {
      target: { value: "PM" },
    });
    fireEvent.change(screen.getByLabelText("Time in closes hour"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("Time in closes minute"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("Time in closes AM or PM"), {
      target: { value: "PM" },
    });
    fireEvent.change(screen.getByLabelText("Time out opens hour"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Time out opens AM or PM"), {
      target: { value: "PM" },
    });
    fireEvent.change(screen.getByLabelText("Time out closes hour"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Time out closes minute"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("Time out closes AM or PM"), {
      target: { value: "PM" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Time out cannot be earlier than Time in",
    );
    expect(api.put).not.toHaveBeenCalled();
  });

  it("still saves the all-day schedule", async () => {
    // Both windows cover the whole day: a real choice for a stall.
    renderOwnerPage();
    expect(await screen.findByText("Time clock")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.change(screen.getByLabelText("Time in opens hour"), { target: { value: "12" } });
    fireEvent.change(screen.getByLabelText("Time in opens AM or PM"), {
      target: { value: "AM" },
    });
    fireEvent.change(screen.getByLabelText("Time in closes hour"), { target: { value: "11" } });
    fireEvent.change(screen.getByLabelText("Time in closes minute"), { target: { value: "59" } });
    fireEvent.change(screen.getByLabelText("Time in closes AM or PM"), {
      target: { value: "PM" },
    });
    fireEvent.change(screen.getByLabelText("Time out opens hour"), { target: { value: "12" } });
    fireEvent.change(screen.getByLabelText("Time out opens AM or PM"), {
      target: { value: "AM" },
    });
    fireEvent.change(screen.getByLabelText("Time out closes hour"), { target: { value: "11" } });
    fireEvent.change(screen.getByLabelText("Time out closes minute"), { target: { value: "59" } });
    fireEvent.change(screen.getByLabelText("Time out closes AM or PM"), {
      target: { value: "PM" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await vi.waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/settings/timeclock", {
        enabled: true,
        inOpen: "00:00",
        inClose: "23:59",
        outOpen: "00:00",
        outClose: "23:59",
        days: [0, 1, 2, 3, 4, 5, 6],
      }),
    );
  });
});

describe("SettingsPage administrators", () => {
  const ownerRow = {
    id: 1, name: "Owner", username: "owner", role: "OWNER", active: true,
    email: "owner@cartiq.local", location: null, rfidUid: null, createdAt: "2026-01-01T00:00:00.000Z",
  };
  const secondAdmin = {
    id: 3, name: "Co Owner", username: "coowner", role: "OWNER", active: true,
    email: "co@example.com", location: null, rfidUid: null, createdAt: "2026-02-01T00:00:00.000Z",
  };
  const staffRow = {
    id: 2, name: "Stall Staff 1", username: "staff01", role: "STAFF", active: true,
    email: "staff01@cartiq.local", location: { code: "CART-01", name: "CART-01" }, rfidUid: "1A1336E1",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    __resetLiveData();
    api.get.mockImplementation((url) => {
      if (url === "/auth/me") {
        return Promise.resolve({ data: { user: { id: 1, name: "Owner", username: "owner", role: "OWNER" } } });
      }
      if (url === "/auth/staff") {
        return Promise.resolve({ data: { data: [ownerRow, secondAdmin, staffRow] } });
      }
      return emptyOk(url);
    });
    api.post.mockResolvedValue({
      data: { user: { id: 4, name: "Co Admin", username: "coadmin", role: "OWNER", active: true, email: "co@example.com" } },
    });
  });

  function renderOwnerPage() {
    return render(
      <MemoryRouter initialEntries={["/"]}>
        <ToastProvider>
          <Routes>
            <Route
              element={<Outlet context={{ user: { id: 1, name: "Owner", username: "owner", role: "OWNER" } }} />}
            >
              <Route element={<SettingsPage />} path="/" />
            </Route>
          </Routes>
        </ToastProvider>
      </MemoryRouter>,
    );
  }

  it("lists administrators, and hides actions on the current account", async () => {
    renderOwnerPage();
    expect(await screen.findByText("Administrators")).toBeInTheDocument();
    expect(await screen.findByText("Co Owner")).toBeInTheDocument();
    const panel = screen.getByText("Administrators").closest("section");
    // Staff are not listed as administrators.
    expect(within(panel).queryByText("Stall Staff 1")).toBeNull();
    expect(within(panel).getByText("You")).toBeInTheDocument();
    expect(within(panel).getAllByTitle("Reset Password")).toHaveLength(1);
    expect(within(panel).getByRole("button", { name: "Disable" })).toBeInTheDocument();
  });

  it("edits another administrator's name, username and recovery email", async () => {
    api.patch.mockResolvedValue({ data: { user: { id: 3 } } });
    renderOwnerPage();
    expect(await screen.findByText("Co Owner")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Edit admin"));
    const dialog = await screen.findByRole("dialog", { name: "Edit admin account" });
    fireEvent.change(within(dialog).getByLabelText(/Full name/), { target: { value: "Corrected Owner" } });
    fireEvent.change(within(dialog).getByLabelText(/^Username/), { target: { value: "correctedowner" } });
    fireEvent.change(within(dialog).getByLabelText(/Recovery email/), { target: { value: "corrected@example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Save Changes/ }));
    await vi.waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/auth/staff/3", {
        name: "Corrected Owner",
        username: "correctedowner",
        email: "corrected@example.com",
      }),
    );
    expect(await screen.findByText('Admin account "correctedowner" updated')).toBeInTheDocument();
  });

  it("disables edit and reset actions for disabled staff accounts", async () => {
    api.get.mockImplementation((url) => {
      if (url === "/auth/me") {
        return Promise.resolve({ data: { user: { id: 1, name: "Owner", username: "owner", role: "OWNER" } } });
      }
      if (url === "/auth/staff") {
        return Promise.resolve({ data: { data: [ownerRow, { ...staffRow, active: false }] } });
      }
      return emptyOk(url);
    });
    renderOwnerPage();
    expect(await screen.findByText("Stall Staff 1")).toBeInTheDocument();
    const panel = screen.getByText("Staff accounts").closest("section");
    expect(within(panel).getByTitle("Enable the account before editing")).toBeDisabled();
    expect(within(panel).getByTitle("Enable the account before resetting password")).toBeDisabled();
  });

  it("shows the card and the cart it belongs to", async () => {
    api.get.mockImplementation((url) => {
      if (url === "/auth/me") {
        return Promise.resolve({ data: { user: { id: 1, name: "Owner", username: "owner", role: "OWNER" } } });
      }
      if (url === "/auth/staff") {
        return Promise.resolve({
          data: { data: [ownerRow, { ...staffRow, rfidLocationCode: "CART-01" }] },
        });
      }
      return emptyOk(url);
    });
    renderOwnerPage();
    expect(await screen.findByText("Stall Staff 1")).toBeInTheDocument();
    // A card only works at the cart it was registered on, so the owner sees
    // both numbers.
    expect(screen.getByText(/1A1336E1 · CART-01/)).toBeInTheDocument();
  });

  it("registers a staff card at the reader for that staff member's cart", async () => {
    api.post.mockResolvedValue({
      data: {
        claim: {
          claimId: "claim-1",
          status: "pending",
          locationCode: "CART-01",
          deviceOnline: true,
          expiresAt: new Date(Date.now() + 90000).toISOString(),
        },
      },
    });
    renderOwnerPage();
    expect(await screen.findByText("Stall Staff 1")).toBeInTheDocument();
    const panel = screen.getByText("Staff accounts").closest("section");
    fireEvent.click(within(panel).getByTitle("Register a card for this staff member at their cart"));

    // The claim is for THAT staff member; the cart is the server's business.
    await vi.waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/auth/my-rfid/claim", {
        targetUserId: 2,
      }),
    );
    expect(await screen.findByText(/Register a card for Stall Staff 1/)).toBeInTheDocument();
    expect(screen.getByText(/Reader online/)).toBeInTheDocument();
  });

  it("refuses to open a reader claim for a staff member with no cart", async () => {
    api.get.mockImplementation((url) => {
      if (url === "/auth/me") {
        return Promise.resolve({ data: { user: { id: 1, name: "Owner", username: "owner", role: "OWNER" } } });
      }
      if (url === "/auth/staff") {
        return Promise.resolve({
          data: { data: [ownerRow, { ...staffRow, location: null }] },
        });
      }
      return emptyOk(url);
    });
    renderOwnerPage();
    expect(await screen.findByText("Stall Staff 1")).toBeInTheDocument();
    const panel = screen.getByText("Staff accounts").closest("section");
    fireEvent.click(within(panel).getByTitle("Register a card for this staff member at their cart"));

    expect(await screen.findByRole("alert")).toHaveTextContent("has no cart yet");
    expect(api.post).not.toHaveBeenCalled();
  });

  it("creates an owner-level account", async () => {
    renderOwnerPage();
    expect(await screen.findByText("Administrators")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Add admin/ }));
    fireEvent.change(screen.getByLabelText(/Full name/), { target: { value: "Co Admin" } });
    fireEvent.change(screen.getByLabelText(/^Username/), { target: { value: "coadmin" } });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: "Str0ngPassw0rd!" } });
    fireEvent.change(screen.getByLabelText(/Recovery email/), { target: { value: "co@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Create account/ }));
    await vi.waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/auth/staff", {
        name: "Co Admin",
        username: "coadmin",
        password: "Str0ngPassw0rd!",
        email: "co@example.com",
        role: "OWNER",
      }),
    );
    expect(await screen.findByText('Admin account "coadmin" created')).toBeInTheDocument();
  });
});
