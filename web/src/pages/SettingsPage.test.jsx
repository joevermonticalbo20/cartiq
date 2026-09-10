import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Outlet } from "react-router-dom";
import { ToastProvider } from "../components/Toast.jsx";

vi.mock("../api.js", () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
  getErrorMessage: (err, fallback) => err?.message || fallback,
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
