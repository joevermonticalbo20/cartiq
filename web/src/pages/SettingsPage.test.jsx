import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Outlet } from "react-router-dom";
import { ToastProvider } from "../components/Toast.jsx";

vi.mock("../api.js", () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() },
}));

vi.mock("../utils/errors.js", () => ({
  getFriendlyError: (err, fallback) => err?.message || fallback,
}));

import api from "../api.js";
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

  it("logs out and redirects to login after a successful change", async () => {
    api.get.mockImplementation(emptyOk);
    api.post.mockImplementation((url) => {
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
    fireEvent.change(screen.getByLabelText(/Current password/i), { target: { value: "oldpass123" } });
    fireEvent.change(screen.getByLabelText(/New password \(min 8 chars\)/i), { target: { value: "newpass123" } });
    fireEvent.change(screen.getByLabelText(/Confirm new password/i), { target: { value: "newpass123" } });
    fireEvent.click(screen.getByText("Update password"));
    expect(await screen.findByText("Login screen")).toBeInTheDocument();
    // localStorage is mocked in test setup: assert the removal calls.
    expect(localStorage.removeItem).toHaveBeenCalledWith("cartiq_token");
    expect(localStorage.removeItem).toHaveBeenCalledWith("cartiq_refresh_token");
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
