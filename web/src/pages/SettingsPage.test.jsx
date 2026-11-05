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
    fireEvent.change(within(dialog).getByLabelText(/Current password/), {
      target: { value: "oldpass123" },
    });
    fireEvent.click(within(dialog).getByText("Save email"));
    await vi.waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/auth/me", {
        email: "owner@example.com",
        currentPassword: "oldpass123",
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
    fireEvent.change(screen.getByPlaceholderText("At least 8 characters"), { target: { value: "newpass123" } });
    fireEvent.change(screen.getByLabelText(/Confirm new password/i), { target: { value: "newpass123" } });
    fireEvent.click(screen.getByText("Update password"));
    expect(await screen.findByText("Login screen")).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith("/auth/change-password", {
      currentPassword: "oldpass123",
      newPassword: "newpass123",
      code: "482916",
    });
    // Session clear goes through the shared helper (both storages).
    expect(clearSession).toHaveBeenCalled();
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
});
