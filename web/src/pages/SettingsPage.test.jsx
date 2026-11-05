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
  const clockSeed = { enabled: false, inOpen: "07:00", inClose: "09:00", outOpen: "17:00", outClose: "19:00" };

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
        clock: { enabled: true, inOpen: "08:00", inClose: "09:30", outOpen: "17:30", outClose: "19:00" },
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

  it("loads the stored windows and saves an edited window", async () => {
    renderOwnerPage();
    expect(await screen.findByText("Time clock")).toBeInTheDocument();
    expect(screen.getByLabelText(/daily window/)).not.toBeChecked();
    fireEvent.click(screen.getByLabelText(/daily window/));
    fireEvent.change(screen.getByLabelText("Time in opens"), { target: { value: "08:00" } });
    fireEvent.change(screen.getByLabelText("Time in closes"), { target: { value: "09:30" } });
    fireEvent.change(screen.getByLabelText("Time out opens"), { target: { value: "17:30" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await vi.waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/settings/timeclock", {
        enabled: true,
        inOpen: "08:00",
        inClose: "09:30",
        outOpen: "17:30",
        outClose: "19:00",
      }),
    );
    expect(await screen.findByText("Time clock saved")).toBeInTheDocument();
  });

  it("blocks saving when Time in opens after it closes, without calling the server", async () => {
    renderOwnerPage();
    expect(await screen.findByText("Time clock")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/daily window/));
    fireEvent.change(screen.getByLabelText("Time in opens"), { target: { value: "09:30" } });
    fireEvent.change(screen.getByLabelText("Time in closes"), { target: { value: "08:00" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "opening time must be before the closing time",
    );
    expect(api.put).not.toHaveBeenCalled();
  });

  it("blocks saving when Time out opens after it closes, without calling the server", async () => {
    renderOwnerPage();
    expect(await screen.findByText("Time clock")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/daily window/));
    fireEvent.change(screen.getByLabelText("Time out opens"), { target: { value: "19:00" } });
    fireEvent.change(screen.getByLabelText("Time out closes"), { target: { value: "17:00" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Time out: the opening time must be before the closing time",
    );
    expect(api.put).not.toHaveBeenCalled();
  });

  it("shows the unrestricted hint while the restriction is off", async () => {
    renderOwnerPage();
    expect(await screen.findByText("Time clock")).toBeInTheDocument();
    expect(screen.getByText(/No restriction/)).toBeInTheDocument();
  });
});
