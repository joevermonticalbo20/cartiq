import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Outlet } from "react-router-dom";
import { ToastProvider } from "../components/Toast.jsx";

vi.mock("../api.js", () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
  getErrorMessage: (err, fallback) => err?.message || fallback,
}));

import api from "../api.js";
import InventoryPage from "./InventoryPage.jsx";

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <ToastProvider>
        <Routes>
          <Route
            element={<Outlet context={{ user: { name: "Owner", role: "OWNER" } }} />}
          >
            <Route element={<InventoryPage />} path="/" />
          </Route>
        </Routes>
      </ToastProvider>
    </MemoryRouter>
  );
}

describe("InventoryPage loading/error states", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows a loading skeleton while fetching", () => {
    api.get.mockReturnValue(new Promise(() => {}));
    const { container } = renderPage();
    expect(container.querySelector(".skel")).not.toBeNull();
    expect(screen.queryByText("No carts configured")).toBeNull();
  });

  it("shows the empty state on success with zero carts", async () => {
    api.get.mockImplementation((url) => {
      if (url === "/inventory") return Promise.resolve({ data: { locations: [] } });
      return Promise.resolve({ data: null });
    });
    renderPage();
    expect(await screen.findByText("No carts configured")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows an error with retry on 500, not the empty state", async () => {
    api.get.mockImplementation((url) => {
      if (url === "/inventory") {
        return Promise.reject(new Error("explode"));
      }
      return Promise.resolve({ data: null });
    });
    renderPage();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("explode")).toBeInTheDocument();
    expect(screen.queryByText("No carts configured")).toBeNull();
  });

  it("retry re-fetches after a failure", async () => {
    let calls = 0;
    api.get.mockImplementation((url) => {
      if (url === "/inventory") {
        calls++;
        if (calls === 1) return Promise.reject(new Error("down"));
        return Promise.resolve({ data: { locations: [] } });
      }
      return Promise.resolve({ data: null });
    });
    renderPage();
    const alert = await screen.findByRole("alert");
    const callsBeforeRetry = api.get.mock.calls.length;
    fireEvent.click(within(alert).getByText("Retry"));
    expect(await screen.findByText("No carts configured")).toBeInTheDocument();
    // Retry fires a fresh round of fetches.
    expect(api.get.mock.calls.length).toBeGreaterThan(callsBeforeRetry);
  });
});
