import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Outlet } from "react-router-dom";
import { ToastProvider } from "../components/Toast.jsx";

vi.mock("../api.js", () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
  API_BASE: "/api",
}));

import api from "../api.js";
import VoidRequestsPage from "./VoidRequestsPage.jsx";

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <ToastProvider>
        <Routes>
          <Route
            element={<Outlet context={{ user: { name: "Owner", role: "OWNER" } }} />}
          >
            <Route element={<VoidRequestsPage />} path="/" />
          </Route>
        </Routes>
      </ToastProvider>
    </MemoryRouter>
  );
}

describe("VoidRequestsPage header", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockResolvedValue({
      data: { data: [], meta: { total: 0, page: 1, pageSize: 100, totalPages: 1 } },
    });
  });

  it("renders the header Refresh action", async () => {
    renderPage();
    expect(await screen.findByRole("button", { name: "Refresh" })).toBeInTheDocument();
    expect(screen.getByText("Operations")).toBeInTheDocument();
  });
});
